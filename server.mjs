import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { KataGoEngine, EngineError, validateState } from './katago.mjs';
import { SetupManager } from './setup-manager.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function openBrowser(port) {
  const url = `http://127.0.0.1:${port}`;
  const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath '${url}'`] : [url];
  execFile(command, args, { windowsHide: true }, error => { if (error) console.error(`自动打开浏览器失败，请手动打开 ${url}`); });
}

export async function reopenExistingServer(port, open = openBrowser) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
    const status = await response.json();
    if (!response.ok || status.app !== 'shiro-go' || status.engine !== 'KataGo' || typeof status.installed !== 'boolean') return false;
    open(port);
    return true;
  } catch { return false; }
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function isLocalHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function acceptsOrigin(request, port) {
  if (!isLocalHost(request.headers.host, port)) return false;
  if (!request.headers.origin) return true;
  return request.headers.origin === `http://127.0.0.1:${port}` || request.headers.origin === `http://localhost:${port}`;
}

async function readJson(request) {
  const bytes = await new Promise((resolveBody, reject) => {
    let total = 0;
    const chunks = [];
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const onError = error => { cleanup(); reject(error); };
    const onAborted = () => onError(new EngineError('请求已中断。', 400));
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(chunks)); };
    const onData = chunk => {
      total += chunk.length;
      if (total > 512 * 1024) {
        cleanup();
        request.resume();
        reject(new EngineError('请求内容过大。', 413));
      } else chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new EngineError('请求必须是有效的 JSON。', 400); }
}

export function createServer(options = {}) {
  const dataRoot = resolve(options.dataRoot ?? process.env.SHIRO_DATA_DIR ?? ROOT);
  let engine = options.engine ?? new KataGoEngine({ root: dataRoot });
  const setup = options.setup ?? new SetupManager({ appRoot: ROOT, dataRoot, desktop: Boolean(options.desktop),
    beforeStart: () => {
      if (engine.pending?.size) throw new EngineError('Please stop the current search before installation.', 409);
      engine.close();
    },
    onComplete: () => { engine = new KataGoEngine({ root: dataRoot }); },
  });
  const staticRoot = resolve(options.staticRoot ?? resolve(ROOT, 'dist'));
  const port = options.port ?? Number(process.env.PORT || 8765);
  const ephemeral = options.port === 0;
  if (!Number.isInteger(port) || (!ephemeral && port < 1) || port < 0 || port > 65535) throw new Error('PORT 必须为 1 到 65535 的整数。');
  const server = http.createServer(async (request, response) => {
    const boundAddress = server.address();
    const boundPort = boundAddress && typeof boundAddress === 'object' ? boundAddress.port : port;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'");
    const remoteAddress = request.socket.remoteAddress;
    if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(remoteAddress) || !acceptsOrigin(request, boundPort)) { sendJson(response, 403, { error: '只允许从本机页面访问围棋服务。' }); return; }
    try {
      const url = new URL(request.url, `http://127.0.0.1:${boundPort}`);
      if (url.pathname === '/api/status' && request.method === 'GET') {
        sendJson(response, 200, { ...engine.status(), app: 'shiro-go', desktop: Boolean(options.desktop), setupRunning: setup.status().running }); return;
      }
      if (url.pathname === '/api/setup/status' && request.method === 'GET') { sendJson(response, 200, setup.status()); return; }
      if (url.pathname === '/api/setup/plan' && request.method === 'GET') {
        sendJson(response, 200, await setup.plan({ backend: url.searchParams.get('backend') || 'auto', runtimeDir: url.searchParams.get('runtimeDir') || '' })); return;
      }
      if (url.pathname === '/api/setup/start' && request.method === 'POST') {
        if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new EngineError('Use application/json for installation.', 415);
        sendJson(response, 202, await setup.start(await readJson(request))); return;
      }
      if (url.pathname === '/api/desktop/quit' && request.method === 'POST' && options.desktop) {
        if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new EngineError('Use application/json.', 415);
        await readJson(request); sendJson(response, 200, { ok: true });
        setTimeout(() => options.onQuit?.(), 100); return;
      }
      if (url.pathname === '/api/score' && request.method === 'POST') {
        if (setup.status().running) throw new EngineError('Installation is running. Please wait.', 409);
        if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new EngineError('Use application/json.', 415);
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EngineError('Invalid scoring request.', 400);
        const controller = new AbortController();
        const onDisconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.on('close', onDisconnect);
        try { const result = await engine.score(body.state, body.level ?? 'deep', body.timeLimit, { signal: controller.signal }); if (!response.destroyed) sendJson(response, 200, result); }
        finally { response.off('close', onDisconnect); }
        return;
      }
      if (url.pathname === '/api/analyze' && request.method === 'POST') {
        if (setup.status().running) throw new EngineError('Installation is running. Please wait.', 409);
        if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new EngineError('请以 application/json 发送分析请求。', 415);
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EngineError('分析请求必须为 JSON 对象。', 400);
        validateState(body.state);
        const controller = new AbortController();
        const onDisconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.on('close', onDisconnect);
        if (response.destroyed) controller.abort();
        try {
          const result = await engine.analyze(body.state, body.level ?? 'max', body.timeLimit, { rank: body.rank, purpose: body.purpose ?? 'analyze', signal: controller.signal });
          if (!response.destroyed) sendJson(response, 200, result);
        } finally { response.off('close', onDisconnect); }
        return;
      }
      if (url.pathname.startsWith('/api/')) { sendJson(response, 404, { error: '接口不存在。' }); return; }
      if (!['GET', 'HEAD'].includes(request.method)) { sendJson(response, 405, { error: '请求方法不受支持。' }); return; }
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { throw new EngineError('页面路径无效。', 400); }
      if (decoded.includes('\0') || decoded.includes('\\')) throw new EngineError('页面路径无效。', 400);
      const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
      const file = resolve(staticRoot, relative);
      if (!file.startsWith(staticRoot + sep)) throw new EngineError('无法访问该文件。', 403);
      let info;
      try { info = await stat(file); } catch { sendJson(response, 404, { error: '页面不存在。' }); return; }
      if (!info.isFile()) { sendJson(response, 404, { error: '页面不存在。' }); return; }
      const [actualRoot, actualFile] = await Promise.all([realpath(staticRoot), realpath(file)]);
      if (!actualFile.startsWith(actualRoot + sep)) throw new EngineError('无法访问该文件。', 403);
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.destroyed) return;
      if (!response.headersSent) sendJson(response, error.status ?? 500, { error: error.message || '本地服务发生错误。' });
      else response.end();
    }
  });
  server.requestTimeout = 240000;
  server.headersTimeout = 15000;
  server.on('close', () => { setup.close(); engine.close(); });
  return { server, get engine() { return engine; }, setup, port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const engine = new KataGoEngine();
    const status = engine.status();
    console.log(JSON.stringify({ ...status, configurationOnly: true, bind: '127.0.0.1' }, null, 2));
    process.exitCode = status.installed && !status.error ? 0 : 1;
    engine.close();
  } else {
    const { server, engine, port } = createServer();
    server.on('error', async error => {
      if (error.code === 'EADDRINUSE' && process.argv.includes('--open') && await reopenExistingServer(port)) {
        console.log(`围棋服务已经运行，正在打开：http://127.0.0.1:${port}`);
        engine.close();
        process.exitCode = 0;
        return;
      }
      engine.close();
      console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请关闭占用该端口的程序，或设置其他 PORT。` : error.message);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`围棋 AI 已启动：http://127.0.0.1:${port}`);
      console.log('浏览器打开上面的地址即可对弈。按 Ctrl+C 关闭服务。');
      if (process.argv.includes('--open')) openBrowser(port);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { engine.close(); server.close(() => process.exit(0)); });
  }
}
