import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, statfs, access, rename, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import path from 'node:path';
import { BINARIES, MODELS, CUDA_LIBRARIES, SOURCES } from './setup-assets.mjs';

export const GiB = 1024 ** 3;
export const MIN_FREE_BYTES = Object.freeze({ cuda: 8 * GiB, cpu: 512 * 1024 ** 2 });
export const MIN_CUDA_DRIVER = '572.30';

export function parseArgs(args) {
  const options = { backend: 'auto', runtimeDir: null, plan: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--plan') { options.plan = true; continue; }
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    let name, value;
    if (argument.startsWith('--backend=')) { name = 'backend'; value = argument.slice(10); }
    else if (argument === '--backend') { name = 'backend'; value = args[++i]; }
    else if (argument.startsWith('--runtime-dir=')) { name = 'runtimeDir'; value = argument.slice(14); }
    else if (argument === '--runtime-dir') { name = 'runtimeDir'; value = args[++i]; }
    else throw new Error(`Unknown setup option: ${argument}. Run node scripts/setup.mjs --help.`);
    if (typeof value !== 'string' || !value || value.startsWith('--') || value.includes('\0')) throw new Error(`Missing or invalid value for ${argument}.`);
    options[name] = value;
  }
  if (!['auto', 'cpu', 'cuda'].includes(options.backend)) throw new Error('--backend must be auto, cpu, or cuda.');
  return options;
}

function csvFields(line) {
  const fields = []; let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { fields.push(value.trim()); value = ''; }
    else value += char;
  }
  if (quoted) return null;
  fields.push(value.trim()); return fields;
}

export function parseNvidiaSmi(output) {
  if (typeof output !== 'string') return [];
  return output.trim().split(/\r?\n/).flatMap((line, index) => {
    const fields = csvFields(line);
    if (!fields || fields.length !== 3) return [];
    const [name, memory, driverVersion] = fields;
    const match = /^(\d+(?:\.\d+)?)\s*(?:MiB)?$/i.exec(memory);
    if (!name || !match || !/^\d+(?:\.\d+)+$/.test(driverVersion)) return [];
    return [{ index, name, memoryMiB: Number(match[1]), driverVersion }];
  });
}

export function driverAtLeast(actual, minimum = MIN_CUDA_DRIVER) {
  if (!/^\d+(?:\.\d+)+$/.test(actual ?? '')) return false;
  const a = actual.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export function recommendedSettings(backend, logicalCpuThreads = 4, gpu = null) {
  const cpus = Number.isFinite(logicalCpuThreads) ? Math.max(1, Math.floor(logicalCpuThreads)) : 4;
  if (backend === 'cpu') return { searchThreads: Math.min(2, Math.max(1, Math.floor(cpus / 4))), batchSize: 1, eigenThreads: Math.min(4, cpus), nnServers: 1, cachePower: 16 };
  const largeGpu = (gpu?.memoryMiB ?? 0) >= 7 * 1024;
  return { searchThreads: largeGpu && cpus >= 12 ? 32 : cpus >= 6 ? 16 : 8, batchSize: largeGpu ? 16 : 8, nnServers: 1, cachePower: 19 };
}

export function buildPlan({ options, root, platform, arch, logicalCpuThreads, gpus = [], freeBytes, installedBackends = [] }) {
  const runtimeDir = path.resolve(options.runtimeDir ?? path.join(root, 'engine'));
  const requested = options.backend;
  const supported = platform === 'win32' && arch === 'x64';
  const explanations = [], errors = [];
  const suitable = gpus.find(gpu => gpu.memoryMiB >= 4096 && driverAtLeast(gpu.driverVersion));
  let backend = requested;
  if (backend === 'auto') {
    if (!suitable) {
      backend = 'cpu';
      explanations.push(gpus.length ? `No detected NVIDIA GPU meets the automatic CUDA requirements (4GiB VRAM and driver ${MIN_CUDA_DRIVER}+); using compatible CPU Eigen.` : 'No usable nvidia-smi GPU result; using compatible CPU Eigen.');
    } else if (!installedBackends.includes('cuda') && (!Number.isFinite(freeBytes) || freeBytes < MIN_FREE_BYTES.cuda)) {
      backend = 'cpu';
      explanations.push('CUDA first installation needs 8GiB free on the runtime drive; using the smaller CPU setup. Use --runtime-dir on a larger drive for CUDA.');
    } else { backend = 'cuda'; explanations.push(`Using local NVIDIA GPU ${suitable.index}: ${suitable.name}.`); }
  }
  if (!supported) errors.push('Automatic installation supports Windows x64 only. Other systems require a manual KataGo installation and KATAGO_PATH/KATAGO_CONFIG/KATAGO_MODEL/KATAGO_HUMAN_MODEL.');
  if (backend === 'cuda' && !suitable) errors.push(`CUDA requires a detected NVIDIA GPU with at least 4GiB VRAM and driver ${MIN_CUDA_DRIVER}+. Update your NVIDIA driver or use --backend=cpu.`);
  const installed = installedBackends.includes(backend);
  const requiredFreeBytes = installed ? 64 * 1024 ** 2 : MIN_FREE_BYTES[backend];
  if (!Number.isFinite(freeBytes)) errors.push('Unable to determine runtime drive free space. Choose an accessible existing drive with --runtime-dir.');
  else if (freeBytes < requiredFreeBytes) errors.push(`${backend.toUpperCase()} setup needs ${(requiredFreeBytes / GiB).toFixed(2)}GiB free on the runtime drive. Choose another drive with --runtime-dir${backend === 'cuda' ? ' or use --backend=cpu' : ''}.`);
  const gpu = backend === 'cuda' ? suitable ?? null : null;
  const settings = recommendedSettings(backend, logicalCpuThreads, gpu);
  const assets = [BINARIES[backend], ...(backend === 'cuda' ? CUDA_LIBRARIES : []), MODELS[backend], MODELS.human];
  return {
    supported, requestedBackend: requested, backend, runtimeDir,
    selectorPath: path.resolve(root, 'engine', 'active.json'),
    paths: { executable: path.join(runtimeDir, backend, 'katago.exe'), config: path.join(runtimeDir, backend, 'analysis.cfg'), model: path.join(runtimeDir, MODELS[backend].filename), humanModel: path.join(runtimeDir, MODELS.human.filename) },
    gpu, settings, model: MODELS[backend].name, humanModel: MODELS.human.name,
    availableBytes: Number.isFinite(freeBytes) ? freeBytes : null, requiredFreeBytes,
    downloadBytes: installed ? 0 : assets.reduce((sum, asset) => sum + asset.size, 0), installed,
    assets, explanations, errors, sources: SOURCES,
    execution: 'Local KataGo subprocess on this computer; no cloud inference or API key.',
  };
}

export async function nearestExistingDirectory(target, filesystem = { stat }) {
  let current = path.resolve(target);
  for (;;) {
    try { const info = await filesystem.stat(current); if (info.isDirectory()) return current; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No existing parent directory for runtime location.');
    current = parent;
  }
}

export async function availableDiskBytes(target, filesystem = { stat, statfs }) {
  const ancestor = await nearestExistingDirectory(target, filesystem);
  const volume = await filesystem.statfs(ancestor);
  const bytes = Number(volume.bavail) * Number(volume.bsize);
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Invalid filesystem free-space result.');
  return bytes;
}

export async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export function assertAsset(asset) {
  if (!asset || !/^https:\/\//.test(asset.url ?? '') || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) throw new Error('Invalid pinned download manifest.');
}

export function assertDownload(asset, bytes, digest) {
  assertAsset(asset);
  if (bytes !== asset.size) throw new Error(`Incomplete download for ${asset.name}: expected ${asset.size} bytes, received ${bytes}.`);
  if (digest !== asset.sha256) throw new Error(`SHA256 mismatch for ${asset.name}. The file was not installed; retry the official download.`);
}

export async function fileMatches(filename, asset) {
  try { return (await stat(filename)).size === asset.size && await sha256File(filename) === asset.sha256; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}

export async function renameWithRetry(source, destination, { retries = 30, delay = 500 } = {}) {
  for (let attempt = 0;; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt >= retries) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export async function downloadAsset(asset, destination, { fetchImpl = fetch, log = () => {} } = {}) {
  assertAsset(asset);
  if (await fileMatches(destination, asset)) { log(`Verified existing ${asset.name}`); return { reused: true }; }
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part-${process.pid}-${randomUUID()}`;
  let bytes = 0, last = 0;
  const hash = createHash('sha256');
  try {
    const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(1_200_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${asset.url}`);
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) !== asset.size) throw new Error(`Unexpected upstream file size for ${asset.name}; the pinned version was not installed.`);
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > asset.size) { callback(new Error(`Download exceeds expected size: ${asset.name}`)); return; }
      hash.update(chunk);
      if (Date.now() - last > 5000) { log(`${asset.name}: ${(bytes / 1048576).toFixed(1)} / ${(asset.size / 1048576).toFixed(1)}MiB`); last = Date.now(); }
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial, { flags: 'wx' }));
    assertDownload(asset, bytes, hash.digest('hex'));
    await renameWithRetry(partial, destination);
    return { reused: false };
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await renameWithRetry(temporary, filename); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export function selectorForPlan(plan, root) {
  const engine = path.resolve(root, 'engine');
  const inside = filename => {
    const resolved = path.resolve(filename), repo = path.resolve(root);
    return resolved.startsWith(repo + path.sep) ? path.relative(engine, resolved) : resolved;
  };
  return {
    executable: inside(plan.paths.executable), config: inside(plan.paths.config),
    model: inside(plan.paths.model), humanModel: inside(plan.paths.humanModel),
    backend: plan.backend, version: BINARIES[plan.backend].version,
    device: plan.gpu?.index ?? null, modelName: plan.model,
    searchThreads: plan.settings.searchThreads, batchSize: plan.settings.batchSize, nnServers: 1,
  };
}

export function configForPlan(plan) {
  const { settings } = plan;
  return [
    'homeDataDir = cache', 'logToStderr = true', 'logSearchInfo = false',
    'reportAnalysisWinratesAs = SIDETOMOVE', 'wideRootNoise = 0',
    'numAnalysisThreads = 1', `numSearchThreadsPerAnalysisThread = ${settings.searchThreads}`,
    `nnMaxBatchSize = ${settings.batchSize}`, 'numNNServerThreadsPerModel = 1',
    `nnCacheSizePowerOfTwo = ${settings.cachePower}`, 'nnMutexPoolSizePowerOfTwo = 14',
    'maxVisits = 10000000', 'maxTime = 60', 'analysisPVLen = 20',
    ...(plan.backend === 'cuda'
      ? [`cudaDeviceToUse = ${plan.gpu.index}`, 'cudaUseFP16 = auto', 'cudaUseNHWC = auto', 'cudaUse1x1Matmul = auto', 'cudaUseMmaAttention = auto']
      : [`numEigenThreadsPerModel = ${settings.eigenThreads}`]),
  ].join('\n') + '\n';
}
