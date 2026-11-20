import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { initSetupUI } from '../dist/first-run.js';

test('a stale setup response cannot override the current backend or enable an invalid plan', async t => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', handlers: {},
      addEventListener(event, handler) { this.handlers[event] = handler; },
    });
    return elements.get(id);
  };
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  });
  globalThis.document = { getElementById: get };
  const pendingPlans = new Map();
  const sendPlan = (backend, errors = []) => pendingPlans.get(backend)({
    ok: true, json: async () => ({ backend, errors, explanations: [], downloadBytes: 0, runtimeDir: 'fixture' }),
  });
  let sendStatus;
  globalThis.fetch = url => {
    if (url === '/api/setup/status') return new Promise(resolve => { sendStatus = resolve; });
    const backend = new URL(url, 'http://localhost').searchParams.get('backend');
    return new Promise(resolve => pendingPlans.set(backend, resolve));
  };
  get('setup-backend').value = 'cuda';
  initSetupUI(() => {}, () => {}).update({ installed: false });
  get('setup-backend').value = 'cpu';
  const current = get('setup-backend').handlers.change();
  assert.equal(get('setup-start').disabled, true);
  sendPlan('cpu');
  await current;
  sendPlan('cuda', ['GPU unavailable']);
  await setImmediate();
  assert.match(get('setup-plan').textContent, /^CPU/);
  assert.equal(get('setup-start').disabled, false);

  get('setup-backend').value = 'cuda';
  const invalid = get('setup-backend').handlers.change();
  sendPlan('cuda', ['GPU unavailable']);
  await invalid;
  sendStatus({ ok: true, json: async () => ({ phase: 'idle', running: false, log: '' }) });
  await setImmediate();
  assert.equal(get('setup-start').disabled, true);
});
