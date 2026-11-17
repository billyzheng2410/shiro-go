// Opt-in Windows integration check; downloads the CPU engine into an isolated fixture.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, playMove } from '../dist/engine.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const exe = path.join(root, 'release', `Shiro-Go-${version}-windows-x64.exe`);
const dataRoot = path.resolve(process.argv.find(arg => arg.startsWith('--data-dir='))?.slice(11) || path.join(root, 'test-output', `exe-${Date.now()}`));
await mkdir(dataRoot, { recursive: true });
const env = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32') };
const self = JSON.parse(execFileSync(exe, ['--self-test', `--data-dir=${dataRoot}`], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 }));
assert.ok(self.sea && self.setupAvailable); assert.equal(self.version, version);
console.log(`Bundled runtime works without Node on PATH: ${self.bundledNode}`);
const child = spawn(exe, ['--no-browser', `--data-dir=${dataRoot}`], { cwd: root, env, windowsHide: true, stdio: 'ignore', detached: process.argv.includes('--keep-open') });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let base;
for (let attempt = 0; attempt < 100; attempt++) {
  try { const instance = JSON.parse(await readFile(path.join(dataRoot, 'instance.json'), 'utf8')); base = `http://127.0.0.1:${instance.port}`; break; } catch { await pause(100); }
}
assert.ok(base, 'Desktop server did not start');
const api = async (route, body) => {
  const response = await fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) } : { signal: AbortSignal.timeout(30000) });
  const result = await response.json(); assert.ok(response.ok, result.error); return result;
};
try {
  const status = await api('/api/status'); assert.equal(status.desktop, true); assert.equal(status.installed, false);
  const plan = await api('/api/setup/plan?backend=cpu'); assert.equal(plan.backend, 'cpu'); assert.equal(plan.errors.length, 0);
  console.log(`Fresh EXE setup: ${(plan.downloadBytes / 1048576).toFixed(1)} MiB`);
  await api('/api/setup/start', { backend: 'cpu' });
  let setup, deadline = Date.now() + 600000, previous = '';
  do {
    await pause(1000); setup = await api('/api/setup/status');
    const last = setup.log.trim().split(/\r?\n/).at(-1);
    if (last && last !== previous) { console.log(last); previous = last; }
  } while (setup.running && Date.now() < deadline);
  assert.equal(setup.phase, 'completed', JSON.stringify(setup));
  assert.equal((await api('/api/status')).installed, true);
  let state = createGame(9);
  for (const index of [20, 60, 21, 59]) state = playMove(state, index).state;
  const played = await api('/api/analyze', { state, level: 'fast', timeLimit: .2, rank: 'max', purpose: 'play' });
  assert.ok(playMove(state, played.index).ok && played.visits > 0);
  for (const index of [-1, -1]) state = playMove(state, index).state;
  const result = await api('/api/score', { state, level: 'fast', timeLimit: .5 });
  assert.equal(result.purpose, 'score'); assert.equal(result.ownership.length, 81);
  assert.ok(Number.isFinite(result.scoring.blackLead) && result.scoring.estimateOnly);
  console.log(JSON.stringify({ PASS: true, url: base, dataRoot, move: played.move, scoreVisits: result.visits, estimatedBlackLead: result.scoring.estimatedBlackLead }));
  if (process.argv.includes('--keep-open')) { child.unref(); base = null; }
} finally {
  if (base) await api('/api/desktop/quit', {}).catch(() => child.kill());
}
