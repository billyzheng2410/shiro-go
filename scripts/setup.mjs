import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, open, unlink, copyFile, rename, realpath, rm } from 'node:fs/promises';
import { BINARIES, MODELS } from './setup-assets.mjs';
import {
  parseArgs, parseNvidiaSmi, buildPlan, availableDiskBytes, fileMatches, sha256File,
  downloadAsset, atomicWriteJson, selectorForPlan, configForPlan, renameWithRetry,
} from './setup-core.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const help = `Shiro Go local engine setup (Windows x64 / Node.js 20+)

  node scripts/setup.mjs
  node scripts/setup.mjs --plan
  node scripts/setup.mjs --backend=cpu
  node scripts/setup.mjs --backend=cuda --runtime-dir "E:\\GoRuntime"

--backend auto|cpu|cuda   Default auto: suitable NVIDIA + enough free space, else CPU.
--runtime-dir PATH        Default ./engine. Use another drive for large CUDA libraries.
--plan                    Print a read-only JSON plan; do not download or write files.
--help                    Show this help.

All game calculation uses this computer. Downloads are pinned official binaries/models.
No API key, cloud inference, driver installation, or system PATH changes are required.
CPU uses a compact older model and may be slower; CUDA uses the stronger transformer.
`;

async function detectNvidia() {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { windowsHide: true, timeout: 6000, maxBuffer: 256 * 1024 });
    return parseNvidiaSmi(stdout);
  } catch { return []; }
}

async function reusableInstallation(runtimeDir, backend) {
  const target = path.join(runtimeDir, backend);
  try {
    const receipt = JSON.parse(await readFile(path.join(target, 'install.json'), 'utf8'));
    if (receipt.backend !== backend || receipt.version !== BINARIES[backend].version || !Array.isArray(receipt.runtimeFiles) || receipt.runtimeFiles.length < 2) return false;
    if (!receipt.runtimeFiles.some(file => file.name === 'katago.exe')) return false;
    for (const file of receipt.runtimeFiles) {
      if (typeof file.name !== 'string' || path.basename(file.name) !== file.name || !await fileMatches(path.join(target, file.name), file)) return false;
    }
    return await fileMatches(path.join(runtimeDir, MODELS[backend].filename), MODELS[backend]) && await fileMatches(path.join(runtimeDir, MODELS.human.filename), MODELS.human);
  } catch { return false; }
}

async function extractArchive(archive, destination, name) {
  // Fixed PowerShell source; Unicode/space-containing paths are environment values.
  // Only flat runtime basenames and a separate license folder are extracted.
  const command = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem;
$zip=[System.IO.Compression.ZipFile]::OpenRead($env:SHIRO_SETUP_ARCHIVE);
try { foreach($entry in $zip.Entries) {
  $leaf=[System.IO.Path]::GetFileName($entry.FullName); if(-not $leaf){continue};
  $runtime=$leaf -match '\\.dll$' -or $leaf -eq 'katago.exe';
  $license=$leaf -match '(?i)license|copying|notice|eula|acknowledg';
  if(-not($runtime -or $license)){continue};
  $folder=if($runtime){$env:SHIRO_SETUP_TARGET}else{Join-Path $env:SHIRO_SETUP_TARGET ('licenses/'+$env:SHIRO_SETUP_PACKAGE)};
  [System.IO.Directory]::CreateDirectory($folder)|Out-Null;
  $target=Join-Path $folder $leaf; $source=$entry.Open();
  try { $output=[System.IO.File]::Open($target,[System.IO.FileMode]::Create); try {$source.CopyTo($output)} finally {$output.Dispose()} } finally {$source.Dispose()}
} } finally {$zip.Dispose()}`;
  await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, SHIRO_SETUP_ARCHIVE: archive, SHIRO_SETUP_TARGET: destination, SHIRO_SETUP_PACKAGE: name },
  });
}

async function smoke(directory, plan) {
  const executable = path.join(directory, 'katago.exe');
  const { stdout: version } = await run(executable, ['version'], { cwd: directory, windowsHide: true, timeout: 30_000 });
  console.log(version.trim());
  console.log('Checking a local 9x9 move and HumanSL policy (first model load can take a moment)...');
  const child = spawn(executable, ['analysis', '-config', 'analysis.cfg', '-model', path.relative(directory, plan.paths.model), '-human-model', path.relative(directory, plan.paths.humanModel), '-quit-without-waiting'], {
    cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let logs = '', buffer = '';
  const result = await new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer);
      child.kill(); if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Local engine validation timed out. Try --backend=cpu or check the GPU driver.\n${logs.slice(-3000)}`)), 180_000);
    child.on('error', error => finish(error));
    child.on('exit', code => { if (!finished) finish(new Error(`KataGo exited (${code}) during validation.\n${logs.slice(-3000)}`)); });
    child.stdin.on('error', error => finish(error));
    child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12_000); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { finish(new Error('Unexpectedly large engine validation output.')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.id !== 'setup-check' || value.warning || value.isDuringSearch) continue;
        if (value.error) { finish(new Error(`KataGo validation failed: ${value.error}`)); return; }
        const best = value.moveInfos?.find(move => move.order === 0) ?? value.moveInfos?.[0];
        if (!best || !Array.isArray(value.humanPolicy) || value.humanPolicy.length !== 82) { finish(new Error('KataGo did not return a move and a valid HumanSL policy.')); return; }
        finish(null, { boardSize: 9, move: best.move, visits: value.rootInfo?.visits, humanPolicyLength: value.humanPolicy.length });
      }
    });
    child.stdin.write(JSON.stringify({ id: 'setup-check', moves: [], rules: 'chinese-ogs', komi: 7.5, boardXSize: 9, boardYSize: 9, maxVisits: 2, includePolicy: true, overrideSettings: { maxTime: 0.1, humanSLProfile: 'rank_10k', wideRootNoise: 0 } }) + '\n');
  });
  // Wait for DLL handles to close before promoting a staged Windows directory.
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
  return { version: version.trim(), result };
}

async function removeOwnStage(stage, runtimeDir) {
  const actualRoot = await realpath(runtimeDir), actualStage = await realpath(stage);
  if (path.dirname(actualStage) !== actualRoot || !path.basename(actualStage).startsWith('.staging-')) throw new Error('Refusing to clean a directory outside this setup staging area.');
  await rm(actualStage, { recursive: true, force: true });
}

async function install(plan) {
  if (plan.errors.length) throw new Error(plan.errors.join('\n'));
  for (const explanation of plan.explanations) console.log(explanation);
  console.log(`Backend: ${plan.backend}; local runtime: ${plan.runtimeDir}`);
  console.log(`Planned downloads: ${(plan.downloadBytes / 1024 ** 2).toFixed(1)}MiB. Stop the app before changing its runtime.`);
  await mkdir(plan.runtimeDir, { recursive: true });
  const lockPath = path.join(plan.runtimeDir, '.setup.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another setup is running for this runtime. If an earlier setup crashed, close it and remove only this runtime\'s .setup.lock file.'); throw error; }
  await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  const backendDir = path.dirname(plan.paths.executable);
  const stage = path.join(plan.runtimeDir, `.staging-${plan.backend}-${randomUUID()}`);
  let staged = false;
  try {
    for (const asset of [MODELS[plan.backend], MODELS.human]) await downloadAsset(asset, path.join(plan.runtimeDir, asset.filename), { log: console.log });
    let target = backendDir;
    if (!plan.installed) {
      await mkdir(stage); staged = true; target = stage;
      for (const asset of plan.assets.filter(asset => asset.kind === 'archive')) {
        const archive = path.join(plan.runtimeDir, 'downloads', asset.name);
        await downloadAsset(asset, archive, { log: console.log });
        console.log(`Extracting ${asset.name}`); await extractArchive(archive, stage, asset.name);
      }
    }
    await mkdir(path.join(target, 'cache'), { recursive: true });
    await writeFile(path.join(target, 'analysis.cfg'), configForPlan(plan), 'utf8');
    const verification = await smoke(target, plan);
    const runtimeFiles = [];
    for (const name of await readdir(target)) if (name === 'katago.exe' || /\.dll$/i.test(name)) {
      const filename = path.join(target, name); runtimeFiles.push({ name, size: (await stat(filename)).size, sha256: await sha256File(filename) });
    }
    await atomicWriteJson(path.join(target, 'install.json'), { backend: plan.backend, version: BINARIES[plan.backend].version, runtimeFiles, verification, modelName: plan.model, modelSha256: MODELS[plan.backend].sha256, humanModelSha256: MODELS.human.sha256, settings: plan.settings, installedAt: new Date().toISOString() });
    if (staged) {
      let previous = null;
      try { await stat(backendDir); previous = path.join(plan.runtimeDir, `.previous-${plan.backend}-${randomUUID()}`); await renameWithRetry(backendDir, previous); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot replace the engine directory; stop the app first. ${error.message}`); }
      try { await renameWithRetry(stage, backendDir); staged = false; }
      catch (error) { if (previous) await rename(previous, backendDir).catch(() => {}); throw error; }
      if (previous) console.log(`Previous runtime preserved at ${previous}`);
    }
    const licenseTarget = path.join(plan.runtimeDir, 'licenses'); await mkdir(licenseTarget, { recursive: true });
    for (const name of await readdir(path.join(root, 'scripts', 'licenses'))) await copyFile(path.join(root, 'scripts', 'licenses', name), path.join(licenseTarget, name));
    await atomicWriteJson(plan.selectorPath, selectorForPlan(plan, root));
    console.log(`Local engine ready: ${verification.result.move}; HumanSL policy verified. Run npm start.`);
  } finally {
    if (staged) await removeOwnStage(stage, plan.runtimeDir).catch(error => console.error(`Setup staging cleanup: ${error.message}`));
    await lock.close(); await unlink(lockPath).catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  const runtimeDir = path.resolve(options.runtimeDir ?? path.join(root, 'engine'));
  const [gpus, freeBytes, reusable] = await Promise.all([
    detectNvidia(), availableDiskBytes(runtimeDir).catch(() => null),
    Promise.all(['cpu', 'cuda'].map(async backend => await reusableInstallation(runtimeDir, backend) ? backend : null)),
  ]);
  const plan = buildPlan({ options, root, platform: process.platform, arch: process.arch, logicalCpuThreads: os.cpus().length, gpus, freeBytes, installedBackends: reusable.filter(Boolean) });
  if (options.plan) { console.log(JSON.stringify(plan, null, 2)); return; }
  await install(plan);
}

main().catch(error => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
