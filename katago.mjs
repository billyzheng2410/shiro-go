import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, playMove, legalMoves } from './dist/engine.js';
import { DEFAULT_RANK, getRank } from './dist/ranks.js';
import { deadFromOwnership, countScore } from './dist/scoring.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const COLUMNS = 'ABCDEFGHJKLMNOPQRST';
export const SEARCH_BUDGETS = Object.freeze({
  fast: Object.freeze({ seconds: 1, visits: 10_000_000 }),
  balanced: Object.freeze({ seconds: 3, visits: 10_000_000 }),
  deep: Object.freeze({ seconds: 10, visits: 10_000_000 }),
  max: Object.freeze({ seconds: 30, visits: 10_000_000 }),
  extended: Object.freeze({ seconds: 60, visits: 10_000_000 }),
});
const HUMAN_PASS_VISITS = 64;

export class EngineError extends Error {
  constructor(message, status = 503) { super(message); this.name = 'EngineError'; this.status = status; }
}

export function indexToGtp(index, size) {
  if (index === -1) return 'pass';
  if (!Number.isInteger(index) || index < 0 || index >= size * size) throw new EngineError('落点坐标无效。', 400);
  return COLUMNS[index % size] + (size - Math.floor(index / size));
}

export function gtpToIndex(move, size) {
  if (typeof move !== 'string') throw new EngineError('KataGo 返回了无效的落点。');
  if (move.toLowerCase() === 'pass') return -1;
  const match = /^([A-HJ-T])(\d{1,2})$/i.exec(move);
  if (!match) throw new EngineError(`KataGo 返回了无法识别的落点：${move}`);
  const column = COLUMNS.indexOf(match[1].toUpperCase());
  const row = size - Number(match[2]);
  if (column < 0 || column >= size || row < 0 || row >= size) throw new EngineError('KataGo 返回了棋盘以外的落点。');
  return row * size + column;
}

export function replayState(state, allowFinished = false) {
  if (!state || typeof state !== 'object' || ![9, 13, 19].includes(state.size)) throw new EngineError('棋盘大小必须为 9、13 或 19。', 400);
  if (!Number.isFinite(state.komi) || Math.abs(state.komi) > 100 || !Number.isInteger(state.komi * 2)) throw new EngineError('贴目必须为 -100 到 100 范围内的整数或半目。', 400);
  if (![1, 2].includes(state.toPlay)) throw new EngineError('轮到的棋手无效。', 400);
  if (!Array.isArray(state.board) || state.board.length !== state.size ** 2 || state.board.some(value => ![0, 1, 2].includes(value))) throw new EngineError('棋盘数据无效。', 400);
  if (!Array.isArray(state.moves) || state.moves.length > 2000) throw new EngineError('棋谱数据无效或过长。', 400);
  let expected = 1;
  for (const move of state.moves) {
    if (!move || !Number.isInteger(move.index) || move.index < -1 || move.index >= state.size ** 2 || move.player !== expected || (move.pass != null && (typeof move.pass !== 'boolean' || move.pass !== (move.index === -1)))) throw new EngineError('棋谱次序或落点无效。', 400);
    expected = 3 - expected;
  }
  if (state.toPlay !== expected) throw new EngineError('棋谱与当前行棋方不一致。', 400);
  let replay = createGame(state.size, state.komi);
  for (const move of state.moves) {
    const played = playMove(replay, move.index);
    if (!played.ok) throw new EngineError(`棋谱中有非法落子：${played.error}`, 400);
    replay = played.state;
  }
  if (state.board.some((value, index) => value !== replay.board[index])) throw new EngineError('棋盘与棋谱不一致，请重新开始或恢复有效棋谱。', 400);
  if (!allowFinished && (state.over || replay.over)) throw new EngineError('对局已经结束，请悔棋或开始新对局。', 400);
  return replay;
}

export function validateState(state) {
  replayState(state);
  return state;
}

export function resolveRankSelection(rank = DEFAULT_RANK, purpose = 'analyze') {
  const requested = getRank(rank);
  if (!requested) throw new EngineError('对手段级位无效。', 400);
  if (!['play', 'analyze'].includes(purpose)) throw new EngineError('请求用途必须为 play 或 analyze。', 400);
  return { requested, effective: purpose === 'play' ? requested : getRank(DEFAULT_RANK), purpose };
}

/** Local, user-owned selector: relative paths use engine/; absolute runtime paths are supported. */
export function readEngineSelection(root = ROOT) {
  const engineDir = resolve(root, 'engine');
  const selectorPath = resolve(engineDir, 'active.json');
  if (!existsSync(selectorPath)) return null;
  let selection;
  try { selection = JSON.parse(readFileSync(selectorPath, 'utf8')); }
  catch { throw new EngineError('engine/active.json 不是有效的引擎配置。'); }
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new EngineError('当前引擎选择配置无效。');
  const files = {};
  for (const [key, fallback] of [['executable', null], ['config', null], ['model', 'model.bin.gz'], ['humanModel', 'human-model.bin.gz']]) {
    const value = selection[key] ?? fallback;
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new EngineError(`当前引擎配置中的 ${key} 路径无效。`);
    const target = resolve(engineDir, value);
    if (!isAbsolute(value) && !target.startsWith(resolve(root) + sep)) throw new EngineError('相对引擎路径必须留在围棋应用目录内；外部运行库请填写绝对路径。');
    files[key] = target;
  }
  return { ...selection, ...files };
}

/** Full-temperature sampling, conditioned only on legal moves and pass handling. */
export function sampleHumanMove(state, policy, { allowPass = false, random = Math.random } = {}) {
  const canonical = replayState(state);
  const legal = legalMoves(canonical);
  if (legal.length === 1 && legal[0] === -1) return -1;
  if (!Array.isArray(policy) || policy.length !== state.size ** 2 + 1 || policy.some(weight => !Number.isFinite(weight))) throw new EngineError('HumanSL 没有返回有效的人类落子分布，请检查人类模型是否加载。');
  const weighted = legal.filter(index => allowPass || index !== -1).map(index => ({ index, weight: policy[index === -1 ? state.size ** 2 : index] })).filter(item => item.weight > 0);
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0) || !Number.isFinite(total)) throw new EngineError('HumanSL 当前没有可用的合法落子概率，请重试分析。');
  const unit = random();
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) throw new EngineError('人类棋风采样随机数无效。');
  let threshold = unit * total;
  for (const item of weighted) {
    threshold -= item.weight;
    if (threshold < 0) return item.index;
  }
  return weighted.at(-1).index;
}

export function buildQuery(id, state, level = 'balanced', timeLimit, options = {}) {
  validateState(state);
  if (!Object.hasOwn(SEARCH_BUDGETS, level)) throw new EngineError('搜索档位无效。', 400);
  if (timeLimit != null && (!Number.isFinite(timeLimit) || timeLimit < 0.1 || timeLimit > 60)) throw new EngineError('搜索时间必须为 0.1 到 60 秒。', 400);
  const selection = resolveRankSelection(options.rank, options.purpose);
  const human = Boolean(selection.effective.profile);
  const budget = SEARCH_BUDGETS[level];
  const seconds = timeLimit ?? budget.seconds;
  return {
    id,
    moves: state.moves.map(move => [move.player === 1 ? 'B' : 'W', indexToGtp(move.index, state.size)]),
    initialPlayer: 'B',
    rules: { ko: 'POSITIONAL', scoring: 'AREA', suicide: false, tax: 'NONE', hasButton: false, whiteHandicapBonus: 'N', friendlyPassOk: true },
    komi: state.komi,
    boardXSize: state.size,
    boardYSize: state.size,
    analyzeTurns: [state.moves.length],
    maxVisits: human ? HUMAN_PASS_VISITS : budget.visits,
    analysisPVLen: 12,
    includeOwnership: true,
    ...(human ? { includePolicy: true } : {}),
    overrideSettings: {
      maxTime: seconds,
      wideRootNoise: 0,
      rootNoiseEnabled: false,
      humanSLProfile: human ? selection.effective.profile : '',
      humanSLRootExploreProbWeightless: 0,
      humanSLRootExploreProbWeightful: 0,
      humanSLPlaExploreProbWeightless: 0,
      humanSLPlaExploreProbWeightful: 0,
      humanSLOppExploreProbWeightless: 0,
      humanSLOppExploreProbWeightful: 0,
      ...(human ? { ignorePreRootHistory: false } : {}),
    },
  };
}

export class KataGoEngine {
  constructor(options = {}) {
    this.root = resolve(options.root ?? process.env.SHIRO_DATA_DIR ?? ROOT);
    this.selectionError = '';
    try { this.selection = readEngineSelection(this.root); }
    catch (error) { this.selection = null; this.selectionError = error.message; }
    this.executable = resolve(options.executable ?? process.env.KATAGO_PATH ?? this.selection?.executable ?? resolve(this.root, 'engine', process.platform === 'win32' ? 'katago.exe' : 'katago'));
    this.modelPath = resolve(options.modelPath ?? process.env.KATAGO_MODEL ?? this.selection?.model ?? resolve(this.root, 'engine', 'model.bin.gz'));
    this.configPath = resolve(options.configPath ?? process.env.KATAGO_CONFIG ?? this.selection?.config ?? resolve(this.root, 'engine', 'analysis.cfg'));
    this.humanModelPath = resolve(options.humanModelPath ?? process.env.KATAGO_HUMAN_MODEL ?? this.selection?.humanModel ?? resolve(this.root, 'engine', 'human-model.bin.gz'));
    this.engineCwd = options.engineCwd ?? dirname(resolve(this.executable));
    this.random = options.random ?? Math.random;
    this.humanModelLoaded = false;
    this.child = null;
    this.pending = new Map();
    this.counter = 0;
    this.logs = '';
    this.lastError = '';
    this.starting = false;
    this.ready = false;
    this.closed = false;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 600000;
  }

  status() {
    let metadata = {};
    try { metadata = JSON.parse(readFileSync(resolve(this.root, 'engine', 'install.json'), 'utf8')); } catch { /* An existing custom engine does not need metadata. */ }
    metadata = { ...metadata, ...this.selection };
    const installed = [this.executable, this.modelPath, this.configPath].every(existsSync);
    const humanAvailable = existsSync(this.humanModelPath);
    return {
      installed,
      ready: this.ready,
      starting: this.starting,
      engine: 'KataGo',
      model: metadata.modelName ?? (this.selection ? basename(this.modelPath).replace(/\.bin\.gz$/i, '') : metadata.model) ?? basename(this.modelPath),
      backend: metadata.backend ?? '本地引擎',
      version: metadata.version ?? '',
      ...(metadata.device != null ? { device: metadata.device } : {}),
      ...(metadata.searchThreads != null ? { searchThreads: metadata.searchThreads } : {}),
      ...(metadata.batchSize != null ? { batchSize: metadata.batchSize } : {}),
      runtime: this.selection ? 'selected' : 'default',
      ranksAvailable: humanAvailable && installed && !this.selectionError,
      humanModel: humanAvailable ? basename(this.humanModelPath) : null,
      humanModelLoaded: this.ready && this.humanModelLoaded,
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(!installed ? { error: '本地引擎尚未就绪。请在上方安装面板完成安装；源码版也可运行 npm run setup。' } : {}),
      ...(this.selectionError ? { error: this.selectionError } : {}),
    };
  }

  start(requireHuman = false) {
    if (this.closed) throw new EngineError('KataGo 服务已经关闭。');
    if (this.selectionError) throw new EngineError(this.selectionError);
    if (requireHuman && !existsSync(this.humanModelPath)) throw new EngineError('人类棋风模型尚未安装，无法使用段级位对手。请运行 npm run setup 安装 HumanSL 模型后重试。');
    if (this.child && requireHuman && !this.humanModelLoaded) {
      if (this.pending.size) throw new EngineError('正在计算其他局面，请稍后重试以载入人类棋风模型。', 429);
      this.fail(new EngineError('正在重新载入人类棋风模型。'));
    }
    if (this.child) return;
    if (!this.status().installed) throw new EngineError(this.status().error);
    this.logs = '';
    this.lastError = '';
    this.ready = false;
    this.starting = true;
    const engineCwd = this.engineCwd;
    this.humanModelLoaded = existsSync(this.humanModelPath);
    const args = ['analysis', '-config', relative(engineCwd, this.configPath), '-model', relative(engineCwd, this.modelPath), '-override-config', 'reportAnalysisWinratesAs=SIDETOMOVE', '-quit-without-waiting'];
    if (this.humanModelLoaded) args.push('-human-model', relative(engineCwd, this.humanModelPath));
    const child = spawn(this.executable, args, {
      cwd: engineCwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { this.fail(new EngineError('KataGo 输出数据过长。')); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.receiveLine(line);
      }
    });
    child.stderr.on('data', chunk => {
      if (this.child !== child) return;
      this.logs = (this.logs + chunk).slice(-8000);
      if (/ready to begin handling requests/i.test(this.logs)) { this.starting = false; this.ready = true; }
    });
    child.stdin.on('error', error => { if (this.child === child) this.fail(new EngineError(`无法向 KataGo 发送请求：${error.message}`)); });
    child.on('error', error => {
      if (this.child === child) this.fail(new EngineError(`无法启动 KataGo：${error.message}。请运行 npm run setup 重新安装，或检查引擎路径。`));
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      const tail = this.logs.trim().split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
      this.fail(new EngineError(`KataGo 已停止（${signal || code}）。${tail ? '\n' + tail : '请检查模型、配置文件或显卡驱动。'}`));
    });
  }

  receiveLine(line) {
    let result;
    try { result = JSON.parse(line); } catch { this.logs = (this.logs + '\n' + line).slice(-8000); return; }
    if (result.warning) {
      this.logs = (this.logs + '\n' + result.warning).slice(-8000);
      if (!result.error && !result.moveInfos) return;
    }
    const pending = this.pending.get(result.id);
    if (result.error) {
      if (pending) this.finish(result.id, new EngineError(`KataGo：${result.error}`, 400));
      else { this.lastError = String(result.error); if (!result.id) this.fail(new EngineError(`KataGo：${result.error}`)); }
      return;
    }
    if (!pending || result.isDuringSearch) return;
    this.ready = true;
    this.starting = false;
    let rankedMoves = [...(Array.isArray(result.moveInfos) ? result.moveInfos : [])].sort((a, b) => a.order - b.order);
    const legal = pending.state ? legalMoves(pending.state) : null;
    const onlyPass = legal?.length === 1 && legal[0] === -1;
    if (onlyPass) rankedMoves = [{ move: 'pass', order: 0, pv: ['pass'], visits: result.rootInfo?.visits }];
    const best = rankedMoves[0];
    if (!best || !result.rootInfo) { this.finish(result.id, new EngineError('KataGo 没有返回可用落点。')); return; }
    try {
      const root = result.rootInfo;
      if (!Number.isFinite(root.winrate) || root.winrate < 0 || root.winrate > 1 || !Number.isFinite(root.scoreLead) || !Number.isInteger(root.visits) || root.visits < 1) throw new EngineError('KataGo 返回了无效的局面评估。');
      const selection = pending.selection ?? resolveRankSelection();
      const mainIndex = gtpToIndex(best.move, pending.size);
      let index = mainIndex;
      const human = Boolean(selection.effective.profile);
      if (human && !onlyPass) {
        if (!Array.isArray(result.humanPolicy) || result.humanPolicy.length !== pending.size ** 2 + 1 || result.humanPolicy.some(weight => !Number.isFinite(weight))) throw new EngineError('HumanSL 模型未返回有效的人类落子分布，请检查人类模型是否正确加载。');
        index = mainIndex === -1 ? -1 : sampleHumanMove(pending.state, result.humanPolicy, { random: this.random });
      }
      if (pending.state && !playMove(pending.state, index).ok) throw new EngineError('引擎着法未通过本地合法性检查，请重试。');
      const selectedInfo = rankedMoves.find(move => gtpToIndex(move.move, pending.size) === index);
      const selectedMove = indexToGtp(index, pending.size);
      this.finish(result.id, null, {
        index,
        move: selectedMove,
        player: pending.player,
        winrate: root.winrate,
        scoreLead: root.scoreLead,
        visits: root.visits,
        pv: selectedInfo?.pv?.length ? selectedInfo.pv : [selectedMove],
        analysisMove: best.move,
        analysisPv: best.pv ?? [],
        // reportAnalysisWinratesAs=SIDETOMOVE also applies to ownership.
        ownership: Array.isArray(result.ownership) ? result.ownership.map(value => pending.player === 2 ? -value : value) : null,
        ownershipPerspective: 'BLACK',
        candidates: rankedMoves.slice(0, 5).map(move => ({ index: gtpToIndex(move.move, pending.size), move: move.move, visits: move.visits, winrate: move.winrate, scoreLead: move.scoreLead, order: move.order })),
        engine: 'KataGo',
        purpose: selection.purpose,
        requestedRank: selection.requested.id,
        opponentRank: selection.effective.id,
        opponentRankLabel: selection.effective.label,
        selectionMethod: human ? 'human-policy' : 'search',
        humanSLProfile: selection.effective.profile ?? null,
        rankApproximate: human,
        rankCalibration: human ? 'kgs-style-19x19' : null,
        rankExperimental: human && pending.size !== 19,
        analysisSource: 'KataGo',
        ...(human ? { passCheckVisits: root.visits } : {}),
        elapsedMs: Math.round(performance.now() - pending.started),
      });
    } catch (error) { this.finish(result.id, error); }
  }

  finish(id, error, result) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.cleanup?.();
    this.pending.delete(id);
    if (error) pending.reject(error); else pending.resolve(result);
  }

  fail(error) {
    this.lastError = error.message;
    this.ready = false;
    this.starting = false;
    this.humanModelLoaded = false;
    const child = this.child;
    this.child = null;
    for (const id of this.pending.keys()) this.finish(id, error);
    if (child) child.kill();
  }

  cancel(id) {
    if (!this.pending.has(id)) return;
    try {
      this.child?.stdin?.write(JSON.stringify({ id: `cancel-${++this.counter}`, action: 'terminate', terminateId: id }) + '\n');
    } catch { /* The original request still needs its cancellation result. */ }
    const error = new EngineError('分析已取消。', 499);
    error.name = 'AbortError';
    this.finish(id, error);
  }

  async score(state, level = 'deep', timeLimit, { signal } = {}) {
    const canonical = replayState(state, true);
    let position = canonical;
    if (canonical.over) {
      // Analyze the same board just before the two ending passes. This avoids
      // terminal search short-circuiting while preserving all actual stone moves.
      position = createGame(canonical.size, canonical.komi);
      for (const move of canonical.moves.slice(0, -2)) position = playMove(position, move.index).state;
    }
    const result = await this.analyze(position, level, timeLimit, { purpose: 'analyze', rank: 'max', signal });
    const { dead, uncertainGroups } = deadFromOwnership(canonical, result.ownership);
    const area = countScore(canonical, dead);
    const estimatedBlackLead = result.player === 1 ? result.scoreLead : -result.scoreLead;
    return { ...result, purpose: 'score', scoring: { ...area, suggestedDead: dead, uncertainGroups, estimatedBlackLead, requiresReview: !canonical.over || uncertainGroups > 0 || Math.abs(area.blackLead - estimatedBlackLead) > 2, method: 'AI ownership + Chinese area count', estimateOnly: true } };
  }

  analyze(state, level = 'balanced', timeLimit, options = {}) {
    const id = `go-${Date.now()}-${++this.counter}`;
    const query = buildQuery(id, state, level, timeLimit, options);
    const selection = resolveRankSelection(options.rank, options.purpose);
    if (options.signal?.aborted) {
      const error = new EngineError('分析已取消。', 499);
      error.name = 'AbortError';
      return Promise.reject(error);
    }
    if (this.pending.size >= 2) throw new EngineError('KataGo 正在计算，请稍后再试。', 429);
    this.start(Boolean(selection.effective.profile));
    const timeout = this.ready ? (timeLimit ?? SEARCH_BUDGETS[level].seconds) * 1000 + 30000 : this.startupTimeoutMs;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => this.fail(new EngineError('KataGo 启动或计算超时。首次启动可能需要调优；请检查引擎日志或重试。')), timeout);
      const onAbort = () => this.cancel(id);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, size: state.size, player: state.toPlay, state: replayState(state), selection, started: performance.now(), cleanup: () => options.signal?.removeEventListener('abort', onAbort) });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) { this.cancel(id); return; }
      this.child.stdin.write(JSON.stringify(query) + '\n', error => { if (error) this.finish(id, new EngineError(`无法发送分析请求：${error.message}`)); });
    });
  }

  close() {
    this.closed = true;
    this.fail(new EngineError('本地围棋服务已关闭。'));
  }
}
