// Opt-in Windows integration check; downloads the CPU engine into an isolated fixture.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
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
const children = [];
function launch() {
  const child = spawn(exe, ['--no-browser', `--data-dir=${dataRoot}`], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.argv.includes('--keep-open'),
  });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  const exit = new Promise(resolve => {
    child.once('error', error => resolve({ code: null, errors: error.message }));
    child.once('exit', code => resolve({ code, errors }));
  });
  const result = { child, exit };
  children.push(result);
  return result;
}
async function locateInstance() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return JSON.parse(await readFile(path.join(dataRoot, 'instance.json'), 'utf8')); }
    catch { await pause(100); }
  }
  throw new Error('Desktop server did not start');
}
async function exited(instance) {
  const result = await Promise.race([instance.exit, pause(15000, null, { ref: false })]);
  assert.ok(result, 'The executable did not exit');
  assert.equal(result.code, 0, result.errors);
}
let base;
const api = async (route, body) => {
  const response = await fetch(base + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) } : { signal: AbortSignal.timeout(30000) });
  const result = await response.json(); assert.ok(response.ok, result.error); return result;
};
let current;
let blocker;
try {
  const first = launch();
  const second = launch();
  const instance = await locateInstance();
  base = `http://127.0.0.1:${instance.port}`;
  current = [first, second].find(candidate => candidate.child.pid === instance.pid);
  assert.ok(current, 'The test must own the desktop instance');
  await exited(current === first ? second : first);
  assert.equal(JSON.parse(await readFile(path.join(dataRoot, 'instance.json'), 'utf8')).pid, instance.pid);
  console.log('Simultaneous launches reuse one desktop instance.');
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
  const saved = { game: { size: state.size, komi: state.komi, moves: state.moves.map(move => move.index) }, language: 'en' };
  await api('/api/desktop/save', saved);
  await api('/api/desktop/quit', {});
  await exited(current);
  base = null;

  blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(instance.port, '127.0.0.1', resolve);
  });
  current = launch();
  const restarted = await locateInstance();
  assert.equal(restarted.pid, current.child.pid);
  assert.notEqual(restarted.port, instance.port);
  base = `http://127.0.0.1:${restarted.port}`;
  assert.deepEqual(await api('/api/desktop/save'), saved);
  assert.equal((await api('/api/status')).installed, true);
  console.log('A restart on a new port retains the game, language and installed engine.');
  console.log(JSON.stringify({ PASS: true, url: base, dataRoot, move: played.move, scoreVisits: result.visits, estimatedBlackLead: result.scoring.estimatedBlackLead }));
  if (process.argv.includes('--keep-open')) {
    current.child.stderr.destroy();
    current.child.unref();
    children.splice(children.indexOf(current), 1);
    base = null;
  }
} finally {
  blocker?.close();
  try {
    if (base && current) { await api('/api/desktop/quit', {}); await exited(current); }
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
}
