import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer, reopenExistingServer } from '../server.mjs';
import { createGame, playMove } from '../dist/engine.js';

function removeOwnedFixture(directory) {
  const actual = resolve(directory);
  assert.ok(actual.startsWith(resolve(tmpdir()) + sep) && basename(actual).startsWith('shiro-server-'));
  rmSync(actual, { recursive: true, force: true });
}

function mockEngine(overrides = {}) {
  return {
    status: () => ({ installed: false, ready: false, engine: 'KataGo', ranksAvailable: false, error: 'Run npm run setup first.' }),
    analyze: async () => ({ engine: 'KataGo', index: 40 }),
    close() {},
    ...overrides,
  };
}

async function fixture(t, engine = mockEngine(), options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shiro-server-'));
  const publicRoot = join(root, 'public');
  mkdirSync(publicRoot);
  writeFileSync(join(publicRoot, 'index.html'), '<!doctype html><title>Local Go</title>');
  writeFileSync(join(publicRoot, 'app.js'), 'export const local = true;');
  writeFileSync(join(root, 'private.txt'), 'PRIVATE_DO_NOT_SERVE');
  const { server } = createServer({ engine, port: 0, staticRoot: publicRoot, ...options });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    removeOwnedFixture(root);
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  return { root, publicRoot, server, port: address.port };
}

test('desktop saves migrate once and keep the game and language across different ports', async t => {
  const root = mkdtempSync(join(tmpdir(), 'shiro-server-'));
  t.after(() => removeOwnedFixture(root));
  const game = { schema: 2, size: 9, komi: 7.5, moves: [40, 20, -1] };
  const first = await fixture(t, mockEngine(), { desktop: true, dataRoot: root });
  const write = (port, changes) => request(port, '/api/desktop/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  });
  assert.equal((await write(first.port, { game, language: 'zh', migrate: true })).status, 200);
  assert.equal((await write(first.port, { game: { ...game, moves: [] }, language: 'en', migrate: true })).status, 200);
  const second = await fixture(t, mockEngine(), { desktop: true, dataRoot: root });
  assert.notEqual(first.port, second.port);
  assert.deepEqual(JSON.parse((await request(second.port, '/api/desktop/save')).body), { game, language: 'zh' });
  assert.equal((await write(second.port, { language: 'en' })).status, 200);
  assert.equal((await write(second.port, { game: { ...game, moves: [81] } })).status, 400);
  assert.deepEqual(JSON.parse((await request(second.port, '/api/desktop/save')).body), { game, language: 'en' });
});

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveResponse, reject) => {
    const client = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    client.on('error', reject);
    client.end(body);
  });
}

test('scoring API accepts finished games and passes its search settings and signal', async t => {
  let observed;
  const engine = mockEngine({ score: async (state, level, timeLimit, options) => {
    observed = { state, level, timeLimit, signal: options.signal };
    return { purpose: 'score', scoring: { black: 0, white: 7.5, suggestedDead: [] } };
  } });
  const { port } = await fixture(t, engine);
  const ended = playMove(playMove(createGame(9), -1).state, -1).state;
  const response = await request(port, '/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: ended, level: 'fast', timeLimit: .1 }) });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).purpose, 'score');
  assert.equal(observed.state.over, true); assert.equal(observed.level, 'fast'); assert.equal(observed.signal.aborted, false);
  assert.equal((await request(port, '/api/score', { method: 'POST', body: '{}' })).status, 415);
});

test('an engine-free checkout serves local HTML, HEAD and actionable setup status without spawning a model', async t => {
  const { port } = await fixture(t);
  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(page.body, /Local Go/);
  const head = await request(port, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], page.headers['content-length']);
  const status = await request(port, '/api/status');
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), { ...mockEngine().status(), app: 'shiro-go', desktop: false, setupRunning: false });
});

test('the local HTTP boundary rejects foreign hosts/origins and traversal paths', async t => {
  const { port } = await fixture(t);
  assert.equal((await request(port, '/', { headers: { Host: `unrelated.invalid:${port}` } })).status, 403);
  assert.equal((await request(port, '/api/status', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await request(port, '/api/status', { headers: { Origin: `http://localhost:${port}` } })).status, 200);
  for (const path of ['/%2e%2e%5cprivate.txt', '/../private.txt', '/%2e%2e/private.txt', '/%00index.html', '/%FF']) {
    const response = await request(port, path);
    assert.notEqual(response.status, 200, path);
    assert.equal(response.body.includes('PRIVATE_DO_NOT_SERVE'), false);
  }
  assert.equal((await request(port, '/', { method: 'POST' })).status, 405);
});

test('a symlink inside the public directory cannot expose a private file outside it', async t => {
  const { port, root, publicRoot } = await fixture(t);
  const privateDirectory = join(root, 'private-directory');
  mkdirSync(privateDirectory);
  writeFileSync(join(privateDirectory, 'private.txt'), 'PRIVATE_DO_NOT_SERVE');
  try { symlinkSync(privateDirectory, join(publicRoot, 'private-link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Creating symlinks requires additional OS privileges.'); return; } throw error; }
  const response = await request(port, '/private-link/private.txt');
  assert.equal(response.status, 403);
  assert.equal(response.body.includes('PRIVATE_DO_NOT_SERVE'), false);
});

test('JSON validation and size errors stay HTTP responses, and valid analysis settings reach the local engine', async t => {
  let received;
  const engine = mockEngine({ analyze: async (state, level, timeLimit, options) => { received = { state, level, timeLimit, options }; return { index: 40, engine: 'KataGo' }; } });
  const { port } = await fixture(t, engine);
  const post = body => request(port, '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal((await post('{invalid')).status, 400);
  assert.equal((await post('null')).status, 400);
  assert.equal((await post(JSON.stringify({ state: null }))).status, 400);
  assert.equal((await post(JSON.stringify({ large: 'x'.repeat(600_000) }))).status, 413);
  assert.equal((await request(port, '/api/analyze', { method: 'POST', body: '{}' })).status, 415);
  const state = createGame(9);
  const response = await post(JSON.stringify({ state, rank: '3d', purpose: 'play', timeLimit: 30 }));
  assert.equal(response.status, 200);
  assert.equal(received.level, 'max');
  assert.equal(received.timeLimit, 30);
  assert.equal(received.options.rank, '3d');
  assert.equal(received.options.purpose, 'play');
  assert.equal(received.options.signal.aborted, false);
  assert.deepEqual(received.state.board, state.board);
});

test('a disconnected HTTP client cancels exactly its pending analysis', async t => {
  let enteredResolve, abortedResolve;
  const entered = new Promise(resolveEntered => { enteredResolve = resolveEntered; });
  const aborted = new Promise(resolveAborted => { abortedResolve = resolveAborted; });
  let pending = 0;
  const engine = mockEngine({ analyze: (_state, _level, _time, { signal }) => {
    pending++;
    enteredResolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      pending--;
      abortedResolve();
      const error = new Error('Cancelled'); error.name = 'AbortError'; reject(error);
    }, { once: true }));
  } });
  const { port } = await fixture(t, engine);
  const client = http.request({ hostname: '127.0.0.1', port, path: '/api/analyze', method: 'POST', headers: { 'Content-Type': 'application/json' }, agent: false });
  client.on('error', () => {});
  client.end(JSON.stringify({ state: createGame(9) }));
  await entered;
  client.destroy();
  let timeout;
  try { await Promise.race([aborted, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('HTTP cancellation did not reach the engine.')), 2000); })]); }
  finally { clearTimeout(timeout); }
  assert.equal(pending, 0);
});

test('repeated-open detection reuses only an identified Shiro Go service', async t => {
  const existing = await fixture(t);
  const opened = [];
  assert.equal(await reopenExistingServer(existing.port, port => opened.push(port)), true);
  assert.deepEqual(opened, [existing.port]);
  assert.equal((await request(existing.port, '/api/status')).status, 200, 'the original listener stays alive');
  const other = await fixture(t, mockEngine({ status: () => ({ engine: 'Other', installed: true }) }));
  assert.equal(await reopenExistingServer(other.port, port => opened.push(port)), false);
  assert.deepEqual(opened, [existing.port]);
});

test('--check is read-only, works from another directory, and explains missing installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'shiro-server-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--check'], {
      cwd: root,
      env: { ...process.env, KATAGO_PATH: join(root, 'absent-engine'), KATAGO_MODEL: join(root, 'absent-model'), KATAGO_CONFIG: join(root, 'absent-config'), KATAGO_HUMAN_MODEL: join(root, 'absent-human') },
      encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    const status = JSON.parse(result.stdout);
    assert.equal(status.installed, false);
    assert.equal(status.ready, false);
    assert.equal(status.configurationOnly, true);
    assert.equal(status.bind, '127.0.0.1');
    assert.match(status.error, /npm run setup/);
  } finally { removeOwnedFixture(root); }
});
