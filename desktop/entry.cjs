/* Single-executable bootstrap. Only Node built-ins run before embedded files are extracted. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sea = require('node:sea');
const { pathToFileURL } = require('node:url');
const { execFile, execFileSync } = require('node:child_process');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const args = process.argv.slice(1);
const valueOf = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const dataRoot = path.resolve(valueOf('data-dir') || process.env.SHIRO_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ShiroGo'));

async function main() {
  const raw = sea.isSea() ? sea.getAsset('application.json', 'utf8') : fs.readFileSync(path.join(__dirname, '..', 'build', 'application.json'), 'utf8');
  const payload = JSON.parse(raw);
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const appRoot = path.join(dataRoot, 'app', `${payload.version}-${digest}`);
  for (const [name, encoded] of Object.entries(payload.files)) {
    if (!/^[\w./-]+$/.test(name) || name.split('/').includes('..') || path.isAbsolute(name)) throw new Error('Invalid embedded resource path.');
    const filename = path.join(appRoot, name);
    const content = Buffer.from(encoded, 'base64');
    let current;
    try { current = fs.readFileSync(filename); } catch { /* First launch. */ }
    if (!current?.equals(content)) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, content); }
  }
  process.env.SHIRO_DATA_DIR = dataRoot;
  process.env.SHIRO_DESKTOP = '1';
  if (args.includes('--self-test')) {
    console.log(JSON.stringify({ app: 'shiro-go', version: payload.version, bundledNode: process.version, sea: sea.isSea(), assets: Object.keys(payload.files).length, appRoot, dataRoot, setupAvailable: fs.existsSync(path.join(appRoot, 'scripts', 'setup.mjs')) }));
    return;
  }
  if (args.includes('--internal-setup') || args.includes('--setup')) {
    const marker = args.includes('--internal-setup') ? '--internal-setup' : '--setup';
    const setupArgs = args.slice(args.indexOf(marker) + 1).filter(arg => !arg.startsWith('--data-dir='));
    process.argv = [process.execPath, path.join(appRoot, 'scripts', 'setup.mjs'), ...setupArgs];
    await import(pathToFileURL(path.join(appRoot, 'scripts', 'setup.mjs')).href);
    return;
  }
  if (args.includes('--check')) {
    const { KataGoEngine } = await import(pathToFileURL(path.join(appRoot, 'katago.mjs')).href);
    const status = new KataGoEngine({ root: dataRoot }).status();
    console.log(JSON.stringify({ ...status, desktop: true, version: payload.version, bundledNode: process.version }));
    return;
  }
  const instancePath = path.join(dataRoot, 'instance.json');
  const preferencesPath = path.join(dataRoot, 'desktop.json');
  const openBrowser = port => {
    if (args.includes('--no-browser')) return;
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "Start-Process -FilePath $env:SHIRO_OPEN_URL"], { windowsHide: true, env: { ...process.env, SHIRO_OPEN_URL: `http://127.0.0.1:${port}/` } }, () => {});
  };
  try {
    const previous = JSON.parse(fs.readFileSync(instancePath, 'utf8'));
    if (Number.isInteger(previous.port) && previous.port >= 1024 && previous.port <= 65535) {
      const response = await fetch(`http://127.0.0.1:${previous.port}/api/status`, { signal: AbortSignal.timeout(1200) });
      const status = await response.json();
      if (status.app === 'shiro-go' && status.desktop && response.ok) { openBrowser(previous.port); console.log(JSON.stringify({ existing: true, url: `http://127.0.0.1:${previous.port}/` })); return; }
    }
  } catch { /* A stopped app can leave a stale instance record. */ }
  const { createServer } = await import(pathToFileURL(path.join(appRoot, 'server.mjs')).href);
  let application;
  const cleanup = () => { try { if (JSON.parse(fs.readFileSync(instancePath, 'utf8')).pid === process.pid) fs.unlinkSync(instancePath); } catch {} };
  const quit = () => {
    application?.setup.close(); application?.engine.close();
    application?.server.closeAllConnections();
    application?.server.close(() => { cleanup(); process.exit(0); });
    setTimeout(() => { cleanup(); process.exit(0); }, 1500).unref();
  };
  let preferred = 8765;
  try { const saved = JSON.parse(fs.readFileSync(preferencesPath, 'utf8')); if (Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65000) preferred = saved.port; } catch {}
  for (let attempt = 0; attempt < 20; attempt++) {
    application = createServer({ port: preferred + attempt, desktop: true, dataRoot, onQuit: quit });
    try {
      await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(preferred + attempt, '127.0.0.1', resolve); });
      break;
    } catch (error) { application.engine.close(); if (error.code !== 'EADDRINUSE' || attempt === 19) throw error; }
  }
  const port = application.server.address().port;
  fs.writeFileSync(preferencesPath, JSON.stringify({ port }));
  fs.writeFileSync(instancePath, JSON.stringify({ pid: process.pid, port, version: payload.version }));
  process.on('exit', cleanup); process.on('SIGTERM', quit); process.on('SIGINT', quit);
  console.log(JSON.stringify({ app: 'shiro-go', url: `http://127.0.0.1:${port}/`, pid: process.pid, version: payload.version }));
  openBrowser(port);
}
main().catch(error => {
  try { fs.mkdirSync(dataRoot, { recursive: true }); fs.appendFileSync(path.join(dataRoot, 'launcher-error.log'), `${new Date().toISOString()} ${error.stack || error}\n`); } catch {}
  console.error(error.stack || error);
  if (process.platform === 'win32' && !args.some(arg => ['--self-test', '--no-browser', '--internal-setup', '--setup', '--check'].includes(arg))) {
    try { execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:SHIRO_ERROR,'Shiro Go / 弈间') | Out-Null"], { windowsHide: true, env: { ...process.env, SHIRO_ERROR: `Unable to start / 启动失败\n${error.message}\n\n${dataRoot}` } }); } catch {}
  }
  process.exitCode = 1;
});
