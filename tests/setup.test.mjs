import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, realpath, rm } from 'node:fs/promises';
import { BINARIES, MODELS, CUDA_LIBRARIES } from '../scripts/setup-assets.mjs';
import {
  GiB, MIN_FREE_BYTES, parseArgs, parseNvidiaSmi, driverAtLeast,
  recommendedSettings, buildPlan, nearestExistingDirectory, availableDiskBytes,
  assertAsset, assertDownload, downloadAsset, selectorForPlan, configForPlan,
} from '../scripts/setup-core.mjs';

const repo = path.resolve('sample-shiro-repository');
const gpu = { index: 0, name: 'NVIDIA GeForce RTX 4060 Laptop GPU', memoryMiB: 8188, driverVersion: '617.42' };
const plan = (overrides = {}) => buildPlan({ options: parseArgs([]), root: repo, platform: 'win32', arch: 'x64', logicalCpuThreads: 20, gpus: [gpu], freeBytes: 20 * GiB, ...overrides });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const assetFor = bytes => ({ name: 'test-official-file', url: 'https://example.test/immutable-file', size: bytes.length, sha256: digest(bytes) });

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiro-setup-test-'));
  t.after(async () => {
    const actual = await realpath(directory), temporaryRoot = await realpath(os.tmpdir());
    assert.equal(path.dirname(actual), temporaryRoot);
    assert.ok(path.basename(actual).startsWith('shiro-setup-test-'));
    await rm(actual, { recursive: true, force: true });
  });
  return directory;
}

test('CLI accepts equals and separate values including space-containing runtime paths', () => {
  assert.deepEqual(parseArgs(['--backend=cpu', '--runtime-dir', 'runtime with spaces', '--plan']), { backend: 'cpu', runtimeDir: 'runtime with spaces', plan: true, help: false });
  assert.equal(parseArgs(['--backend', 'cuda', '--runtime-dir=other-drive']).backend, 'cuda');
});

test('CLI rejects unknown options, missing values, unsupported backends and NUL paths', () => {
  for (const args of [['--cloud'], ['--backend'], ['--runtime-dir', '--plan'], ['--backend=opencl'], ['--runtime-dir=bad\0path']]) assert.throws(() => parseArgs(args));
});

test('NVIDIA CSV handles MiB units, multiple GPUs and quoted names without mixing DXGI IDs', () => {
  const devices = parseNvidiaSmi('"NVIDIA Example, GPU", 2048 MiB, 617.42\r\nNVIDIA RTX 4060, 8188 MiB, 617.42\r\n');
  assert.equal(devices[0].name, 'NVIDIA Example, GPU');
  assert.equal(devices[1].index, 1);
  assert.equal(devices[1].memoryMiB, 8188);
  assert.equal(parseNvidiaSmi('No devices were found').length, 0);
  assert.equal(parseNvidiaSmi('NVIDIA GPU, N/A, 617.42').length, 0);
  assert.equal(parseNvidiaSmi('"unterminated, 8192, 617.42').length, 0);
});

test('driver comparisons enforce the pinned CUDA12.8 PTX-compatible conservative minimum', () => {
  assert.ok(driverAtLeast('572.30'));
  assert.ok(driverAtLeast('572.30.0'));
  assert.ok(driverAtLeast('617.42'));
  assert.equal(driverAtLeast('572.29'), false);
  assert.equal(driverAtLeast('555.99'), false);
  assert.equal(driverAtLeast('N/A'), false);
});

test('suitable NVIDIA with enough space chooses local CUDA device0 and32/16 defaults', () => {
  const actual = plan();
  assert.equal(actual.backend, 'cuda');
  assert.equal(actual.gpu.index, 0);
  assert.equal(actual.settings.searchThreads, 32);
  assert.equal(actual.settings.batchSize, 16);
  assert.equal(actual.errors.length, 0);
});

test('low disk auto-selects CPU before any CUDA download and explains external-runtime option', () => {
  const actual = plan({ freeBytes: 4 * GiB });
  assert.equal(actual.backend, 'cpu');
  assert.equal(actual.downloadBytes, BINARIES.cpu.size + MODELS.cpu.size + MODELS.human.size);
  assert.ok(actual.downloadBytes < 120 * 1024 ** 2);
  assert.ok(actual.explanations.some(message => message.includes('--runtime-dir')));
  assert.equal(actual.assets.some(item => item.url.includes('cudnn')), false);
});

test('explicit CUDA reports inadequate disk instead of silently selecting another backend', () => {
  const actual = plan({ options: parseArgs(['--backend=cuda']), freeBytes: 4 * GiB });
  assert.equal(actual.backend, 'cuda');
  assert.ok(actual.errors.some(message => message.includes('8.00GiB')));
});

test('old driver, insufficient VRAM and missing GPU automatically use safe Eigen CPU', () => {
  for (const devices of [[], [{ ...gpu, driverVersion: '555.99' }], [{ ...gpu, memoryMiB: 2048 }]]) {
    const actual = plan({ gpus: devices });
    assert.equal(actual.backend, 'cpu');
    assert.equal(actual.gpu, null);
    assert.match(actual.assets[0].name, /-eigen-windows-/);
    assert.doesNotMatch(actual.assets[0].name, /avx2/);
  }
});

test('explicit CUDA without compatible driver fails with an actionable CPU alternative', () => {
  const actual = plan({ options: parseArgs(['--backend=cuda']), gpus: [{ ...gpu, driverVersion: '555.99' }] });
  assert.ok(actual.errors.some(message => message.includes('572.30') && message.includes('--backend=cpu')));
});

test('CPU is explicit and remains CPU even on a powerful GPU', () => {
  const actual = plan({ options: parseArgs(['--backend=cpu']) });
  assert.equal(actual.backend, 'cpu');
  assert.equal(actual.model, MODELS.cpu.name);
  assert.match(actual.paths.model, /model\.txt\.gz$/);
  assert.match(actual.paths.humanModel, /human-model\.bin\.gz$/);
});

test('verified installed CUDA can be reused without first-install disk reservation', () => {
  const actual = plan({ freeBytes: 128 * 1024 ** 2, installedBackends: ['cuda'] });
  assert.equal(actual.backend, 'cuda');
  assert.equal(actual.downloadBytes, 0);
  assert.equal(actual.errors.length, 0);
});

test('unknown free space and insufficient CPU space prevent installation', () => {
  assert.ok(plan({ freeBytes: null }).errors.some(message => message.includes('free space')));
  assert.ok(plan({ gpus: [], freeBytes: MIN_FREE_BYTES.cpu - 1 }).errors.length);
});

test('non-Windows platforms and non-x64 architectures have an explicit manual setup message', () => {
  assert.equal(plan({ platform: 'linux' }).supported, false);
  assert.ok(plan({ arch: 'arm64' }).errors.some(message => message.includes('manual KataGo')));
});

test('hardware defaults keep lower-memory CUDA batches and CPU thread counts bounded', () => {
  assert.equal(recommendedSettings('cuda', 4, { memoryMiB: 4096 }).batchSize, 8);
  assert.equal(recommendedSettings('cuda', 4, { memoryMiB: 4096 }).searchThreads, 8);
  assert.equal(recommendedSettings('cpu', 1).eigenThreads, 1);
  assert.equal(recommendedSettings('cpu', 128).eigenThreads, 4);
});

test('every pinned official binary, model and runtime has HTTPS, exact size and SHA256', () => {
  for (const asset of [...Object.values(BINARIES), ...Object.values(MODELS), ...CUDA_LIBRARIES]) assert.doesNotThrow(() => assertAsset(asset));
  assert.equal(MODELS.human.size, 99066230);
});

test('local selectors use engine-relative paths; external runtime selectors are absolute', () => {
  const local = selectorForPlan(plan(), repo);
  assert.equal(path.isAbsolute(local.executable), false);
  assert.equal(path.resolve(repo, 'engine', local.humanModel), path.resolve(repo, 'engine', 'human-model.bin.gz'));
  const externalRoot = path.resolve(repo, '..', 'user-owned-external-runtime');
  const external = selectorForPlan(plan({ options: parseArgs(['--runtime-dir', externalRoot]) }), repo);
  assert.equal(external.executable, path.join(externalRoot, 'cuda', 'katago.exe'));
  assert.equal(path.isAbsolute(external.executable), true);
});

test('generated configs contain each search setting once and backend-specific settings only', () => {
  const cuda = configForPlan(plan());
  assert.match(cuda, /cudaDeviceToUse = 0/);
  assert.equal(cuda.match(/nnMaxBatchSize =/g).length, 1);
  const cpu = configForPlan(plan({ options: parseArgs(['--backend=cpu']) }));
  assert.match(cpu, /numEigenThreadsPerModel = 4/);
  assert.doesNotMatch(cpu, /cudaDevice/);
});

test('free-space discovery reads nearest existing ancestor without creating directories', async () => {
  const ancestor = path.resolve('existing-parent');
  const nested = path.join(ancestor, 'not-created', 'runtime');
  const reads = [];
  const filesystem = {
    stat: async filename => { reads.push(filename); if (filename === ancestor) return { isDirectory: () => true }; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    statfs: async filename => { assert.equal(filename, ancestor); return { bavail: 7n, bsize: 4096n }; },
  };
  assert.equal(await nearestExistingDirectory(nested, filesystem), ancestor);
  assert.equal(await availableDiskBytes(nested, filesystem), 7 * 4096);
  assert.ok(reads.includes(nested));
});

test('download byte-count and digest validation reject mismatches', () => {
  const bytes = Buffer.from('correct'), asset = assetFor(bytes);
  assert.doesNotThrow(() => assertDownload(asset, bytes.length, digest(bytes)));
  assert.throws(() => assertDownload(asset, bytes.length - 1, digest(bytes)), /Incomplete/);
  assert.throws(() => assertDownload(asset, bytes.length, '0'.repeat(64)), /SHA256/);
  assert.throws(() => assertAsset({ ...asset, url: 'http://example.test/file' }), /manifest/);
});

test('verified download is atomically published and subsequent setup performs no network request', async t => {
  const directory = await tempDirectory(t), destination = path.join(directory, 'model.bin.gz');
  const bytes = Buffer.from('immutable verified model'), asset = assetFor(bytes);
  const first = await downloadAsset(asset, destination, { fetchImpl: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }) });
  assert.equal(first.reused, false);
  assert.deepEqual(await readFile(destination), bytes);
  const second = await downloadAsset(asset, destination, { fetchImpl: async () => { throw Error('must not download a verified file'); } });
  assert.equal(second.reused, true);
  assert.deepEqual(await readdir(directory), ['model.bin.gz']);
});

test('corrupt response preserves previous file and removes its own partial download', async t => {
  const directory = await tempDirectory(t), destination = path.join(directory, 'engine.zip');
  await writeFile(destination, 'previous engine');
  const asset = assetFor(Buffer.from('good'));
  await assert.rejects(downloadAsset(asset, destination, { fetchImpl: async () => new Response('evil') }), /SHA256/);
  assert.equal(await readFile(destination, 'utf8'), 'previous engine');
  assert.deepEqual(await readdir(directory), ['engine.zip']);
});

test('oversized upstream response is rejected without a final or partial file', async t => {
  const directory = await tempDirectory(t), destination = path.join(directory, 'engine.zip');
  const asset = assetFor(Buffer.from('good'));
  await assert.rejects(downloadAsset(asset, destination, { fetchImpl: async () => new Response('too large') }), /expected size/);
  assert.deepEqual(await readdir(directory), []);
});

test('unexpected Content-Length and HTTP errors fail before publication', async t => {
  const directory = await tempDirectory(t), destination = path.join(directory, 'file');
  const bytes = Buffer.from('good'), asset = assetFor(bytes);
  await assert.rejects(downloadAsset(asset, destination, { fetchImpl: async () => new Response(bytes, { headers: { 'content-length': '999' } }) }), /upstream file size/);
  await assert.rejects(downloadAsset(asset, destination, { fetchImpl: async () => new Response(null, { status: 404 }) }), /404/);
  assert.deepEqual(await readdir(directory), []);
});
