import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { inspectSetup } from './scripts/setup.mjs';

export class SetupManager {
  constructor({ appRoot, dataRoot = appRoot, executable = process.execPath, desktop = false, beforeStart = () => {}, onComplete = () => {}, spawnProcess = spawn, inspect = inspectSetup }) {
    Object.assign(this, { appRoot, dataRoot, executable, desktop, beforeStart, onComplete, spawnProcess, inspect });
    this.child = null;
    this.state = { phase: 'idle', running: false, log: '', error: null };
  }
  arguments(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Invalid setup request.'), { status: 400 });
    const backend = body.backend || 'auto';
    if (!['auto', 'cpu', 'cuda'].includes(backend)) throw Object.assign(new Error('Choose auto, cpu or cuda.'), { status: 400 });
    const args = [`--backend=${backend}`];
    if (body.runtimeDir != null && body.runtimeDir !== '') {
      if (typeof body.runtimeDir !== 'string' || body.runtimeDir.length > 2048 || body.runtimeDir.includes('\0')) throw Object.assign(new Error('Invalid installation directory.'), { status: 400 });
      args.push(`--runtime-dir=${resolve(this.dataRoot, body.runtimeDir)}`);
    }
    return args;
  }
  async plan(body) { return this.inspect(this.arguments(body), this.dataRoot); }
  status() { return { ...this.state }; }
  async start(body) {
    if (this.state.running) throw Object.assign(new Error('An installation is already running.'), { status: 409 });
    // Reserve synchronously before awaiting detection so two tabs cannot start two installers.
    this.state = { phase: 'planning', running: true, log: '', error: null };
    let prepared = false;
    try {
      const args = this.arguments(body);
      const plan = await this.inspect(args, this.dataRoot);
      if (plan.errors.length) throw new Error(plan.errors.join('\n'));
      await this.beforeStart();
      prepared = true;
      this.state = { phase: 'running', running: true, log: '', error: null, backend: plan.backend, downloadBytes: plan.downloadBytes, runtimeDir: plan.runtimeDir };
      const childArgs = this.desktop ? ['--internal-setup', ...args] : [resolve(this.appRoot, 'scripts', 'setup.mjs'), ...args];
      const child = this.spawnProcess(this.executable, childArgs, { cwd: this.appRoot, windowsHide: true, env: { ...process.env, SHIRO_DATA_DIR: this.dataRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      const append = chunk => { this.state.log = (this.state.log + chunk).slice(-24000); };
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', append); child.stderr?.on('data', append);
      let finished = false;
      const finish = (code, error) => {
        if (finished) return; finished = true; this.child = null;
        this.state = { ...this.state, running: false, phase: code === 0 && !error ? 'completed' : 'failed', exitCode: code, error: error?.message || (code === 0 ? null : 'Installation failed. See the log and retry or choose CPU.') };
        this.onComplete();
      };
      child.once('error', error => finish(null, error));
      child.once('close', code => finish(code));
      return this.status();
    } catch (error) { this.state = { ...this.state, phase: 'failed', running: false, error: error.message }; if (prepared) this.onComplete(); throw error; }
  }
  close() { this.child?.kill(); }
}
