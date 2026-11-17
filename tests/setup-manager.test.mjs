import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SetupManager } from '../setup-manager.mjs';

const plan = { errors: [], backend: 'cpu', downloadBytes: 1, runtimeDir: 'engine' };
test('installer reserves one job before async detection and invokes the bundled EXE in desktop mode', async () => {
  let resume, spawned, complete = 0;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const manager = new SetupManager({ appRoot: '.', dataRoot: '.', executable: 'Shiro.exe', desktop: true,
    inspect: () => new Promise(resolve => { resume = resolve; }), onComplete: () => complete++,
    spawnProcess: (exe, args, options) => { spawned = { exe, args, options }; return child; },
  });
  const pending = manager.start({ backend: 'cpu' });
  await assert.rejects(manager.start({ backend: 'cuda' }), /already running/);
  resume(plan); await pending;
  assert.equal(spawned.exe, 'Shiro.exe'); assert.deepEqual(spawned.args, ['--internal-setup', '--backend=cpu']);
  assert.equal(spawned.options.windowsHide, true);
  child.stdout.write('Installed'); child.emit('close', 0);
  assert.equal(manager.status().phase, 'completed'); assert.equal(manager.status().log, 'Installed'); assert.equal(complete, 1);
});

test('installer refreshes the engine after a spawn failure and allows retry', async () => {
  let refreshed = 0;
  const manager = new SetupManager({ appRoot: '.', inspect: async () => plan,
    onComplete: () => refreshed++, spawnProcess: () => { throw new Error('Cannot start'); },
  });
  await assert.rejects(manager.start({ backend: 'cpu' }), /Cannot start/);
  assert.equal(refreshed, 1); assert.equal(manager.status().running, false);
  await assert.rejects(manager.start({ backend: 'cpu' }), /Cannot start/);
  assert.equal(refreshed, 2);
  assert.throws(() => manager.arguments({ backend: 'remote' }), /Choose auto/);
});
