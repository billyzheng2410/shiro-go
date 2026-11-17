import { createGame, playMove, BLACK, WHITE } from './engine.js';
import { initLanguage, getLanguage, translateText } from './i18n.js';
import { initSetupUI } from './first-run.js';
import { showScore } from './score-ui.js';
import { RANKS, DEFAULT_RANK, getRank } from './ranks.js';

const $ = id => document.getElementById(id);
const letters = 'ABCDEFGHJKLMNOPQRST';
const canvas = $('board');
const ctx = canvas.getContext('2d');
const STORAGE_KEY = 'shiro-go-v1';
let state = createGame(19, 7.5);
let human = BLACK;
let mode = 'play';
let opponentRank = DEFAULT_RANK;
let busy = false;
let generation = 0;
let requestController;
let engineStatus = null;
let evaluation = null;
let evaluations = [];
let suggestion = -2;
let hover = -1;
let focusPoint = -1;
let resigned = false;
let newSize = 19;
let newColor = BLACK;
let toastTimer;
let autoScorePending = false;
const setupUI = initSetupUI(getStatus, toast);

function rankLabel(id = opponentRank) { return getRank(id)?.label || '最强 · 不限段位'; }

function fillRankOptions(select) {
  const groups = new Map();
  for (const rank of RANKS) {
    const groupName = rank.id === DEFAULT_RANK ? 'KataGo 全力' : rank.id.endsWith('k') ? 'KGS 级位 · 近似' : 'KGS 段位 · 近似';
    if (!groups.has(groupName)) {
      const group = document.createElement('optgroup'); group.label = groupName;
      groups.set(groupName, group);
    }
    const option = document.createElement('option'); option.value = rank.id; option.textContent = rank.label;
    groups.get(groupName).append(option);
  }
  select.replaceChildren(...groups.values());
}

fillRankOptions($('opponent-rank'));
fillRankOptions($('new-rank'));

function coord(index) {
  return index === -1 ? '停一手' : letters[index % state.size] + (state.size - Math.floor(index / state.size));
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500);
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 2, size: state.size, komi: state.komi, moves: state.moves.map(({ index }) => index), human, mode, opponentRank, level: $('strength').value, resigned, evaluations: evaluations.slice(-120) }));
  } catch { /* Gameplay remains available when browser storage is disabled. */ }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || ![9, 13, 19].includes(saved.size) || !Number.isFinite(saved.komi) || !Array.isArray(saved.moves) || saved.moves.length > 2000) return;
    let restored = createGame(saved.size, saved.komi);
    for (const index of saved.moves) {
      const result = playMove(restored, index);
      if (!result.ok) return;
      restored = result.state;
    }
    state = restored;
    human = saved.human === WHITE ? WHITE : BLACK;
    mode = saved.mode === 'analysis' ? 'analysis' : 'play';
    resigned = !!saved.resigned;
    if (saved.schema >= 2 && ['fast', 'balanced', 'deep', 'max', 'extended'].includes(saved.level)) $('strength').value = saved.level;
    opponentRank = getRank(saved.opponentRank)?.id || DEFAULT_RANK;
    evaluations = Array.isArray(saved.evaluations) ? saved.evaluations.filter(e => Number.isFinite(e.blackWinrate) && Number.isInteger(e.ply) && e.ply <= state.moves.length) : [];
    evaluation = evaluations.findLast(e => e.ply === state.moves.length)?.result ?? null;
  } catch { /* Ignore an outdated or incomplete saved game. */ }
}

function canPlay() { return !busy && !state.over && !resigned && (mode === 'analysis' || state.toPlay === human); }

function geometry() {
  const width = canvas.getBoundingClientRect().width;
  const margin = width * (state.size === 19 ? .063 : .08);
  return { width, margin, step: (width - 2 * margin) / (state.size - 1) };
}

function drawStone(x, y, radius, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = '#302a2760';
  ctx.shadowBlur = radius * .36;
  ctx.shadowOffsetX = radius * .07;
  ctx.shadowOffsetY = radius * .15;
  const gradient = ctx.createRadialGradient(x - radius * .3, y - radius * .38, radius * .08, x + radius * .1, y + radius * .14, radius * 1.1);
  if (color === BLACK) { gradient.addColorStop(0, '#626560'); gradient.addColorStop(.4, '#373c36'); gradient.addColorStop(1, '#1e251e'); }
  else { gradient.addColorStop(0, '#ffffff'); gradient.addColorStop(.65, '#f4f4ed'); gradient.addColorStop(1, '#d0d1c7'); }
  ctx.fillStyle = gradient;
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = color === BLACK ? '#1d261d50' : '#a2a58d60';
  ctx.lineWidth = .6; ctx.stroke();
  ctx.restore();
}

function renderBoard() {
  const { width, margin, step } = geometry();
  if (!width) return;
  const scale = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * scale)) { canvas.width = Math.round(width * scale); canvas.height = canvas.width; }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, width);
  const wood = ctx.createLinearGradient(0, 0, width, width);
  wood.addColorStop(0, '#ddc994'); wood.addColorStop(.48, '#d7c18a'); wood.addColorStop(1, '#d2bb83');
  ctx.fillStyle = wood; ctx.fillRect(0, 0, width, width);
  for (let line = 0; line < 85; line++) {
    const y = line * width / 85;
    ctx.strokeStyle = line % 3 ? '#8e75420b' : '#fff6d70a';
    ctx.lineWidth = .45;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(width * .3, y + Math.sin(line * 1.73) * 3, width * .7, y + Math.cos(line) * 2, width, y); ctx.stroke();
  }
  ctx.strokeStyle = '#695c3e9e'; ctx.lineWidth = .7;
  for (let i = 0; i < state.size; i++) {
    const pos = margin + i * step;
    ctx.beginPath(); ctx.moveTo(margin, pos); ctx.lineTo(width - margin, pos); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pos, margin); ctx.lineTo(pos, width - margin); ctx.stroke();
  }
  ctx.lineWidth = 1.1; ctx.strokeRect(margin, margin, width - margin * 2, width - margin * 2);
  ctx.fillStyle = '#695e42';
  ctx.font = `${Math.max(8, Math.min(11, width / 53))}px Georgia, serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < state.size; i++) {
    const pos = margin + i * step;
    ctx.fillText(letters[i], pos, margin * .42);
    ctx.fillText(letters[i], pos, width - margin * .4);
    ctx.fillText(String(state.size - i), margin * .4, pos);
    ctx.fillText(String(state.size - i), width - margin * .38, pos);
  }
  const star = state.size === 19 ? [3, 9, 15] : state.size === 13 ? [3, 6, 9] : [2, 4, 6];
  for (const row of star) for (const col of star) {
    if (state.size !== 19 && row !== col && row !== state.size - 1 - col) continue;
    ctx.beginPath(); ctx.arc(margin + col * step, margin + row * step, Math.max(1.6, step * .075), 0, Math.PI * 2); ctx.fill();
  }
  state.board.forEach((color, index) => {
    if (color) drawStone(margin + (index % state.size) * step, margin + Math.floor(index / state.size) * step, step * .46, color);
  });
  const last = state.moves.at(-1);
  if (last && last.index >= 0) {
    const x = margin + (last.index % state.size) * step;
    const y = margin + Math.floor(last.index / state.size) * step;
    ctx.strokeStyle = last.player === BLACK ? '#d7ddc1' : '#66745b'; ctx.lineWidth = 1.1;
    ctx.strokeRect(x - step * .12, y - step * .12, step * .24, step * .24);
  }
  if (suggestion >= 0 && !state.board[suggestion]) {
    const x = margin + (suggestion % state.size) * step;
    const y = margin + Math.floor(suggestion / state.size) * step;
    ctx.fillStyle = '#638956df'; ctx.beginPath(); ctx.arc(x, y, step * .4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#edf1df'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x - step * .14, y); ctx.lineTo(x, y + step * .1); ctx.lineTo(x + step * .16, y - step * .14); ctx.stroke();
  }
  if (hover >= 0 && !state.board[hover] && canPlay()) drawStone(margin + hover % state.size * step, margin + Math.floor(hover / state.size) * step, step * .46, state.toPlay, .35);
  if (focusPoint >= 0 && document.activeElement === canvas) {
    const x = margin + focusPoint % state.size * step;
    const y = margin + Math.floor(focusPoint / state.size) * step;
    ctx.strokeStyle = '#52794c'; ctx.lineWidth = 1.6; ctx.setLineDash([3, 2]);
    ctx.strokeRect(x - step * .49, y - step * .49, step * .98, step * .98); ctx.setLineDash([]);
  }
}

function render() {
  $('size-label').textContent = ({ 9: '九路棋盘', 13: '十三路棋盘', 19: '十九路棋盘' })[state.size];
  $('komi-label').textContent = state.komi;
  $('move-number').textContent = state.moves.length;
  const opponentName = opponentRank === DEFAULT_RANK ? 'KataGo · 全力' : `KataGo · ${rankLabel()}`;
  $('black-name').textContent = mode === 'analysis' ? '黑棋' : human === BLACK ? '你' : opponentName;
  $('white-name').textContent = mode === 'analysis' ? '白棋' : human === WHITE ? '你' : opponentName;
  document.querySelectorAll('.player-line small')[2].textContent = `执白 · 贴 ${state.komi} 目`;
  $('black-captures').textContent = state.captures[BLACK];
  $('white-captures').textContent = state.captures[WHITE];
  $('turn-stone').className = `mini-stone ${state.toPlay === BLACK ? 'black' : 'white'}`;
  $('thinking').hidden = !busy;
  $('stop-thinking').hidden = !busy;
  $('turn-text').textContent = resigned ? '对局已结束 · 认输' : state.over ? '双方停一手 · 对局结束' : busy ? 'KataGo 正在思考' : mode === 'analysis' ? `轮到${state.toPlay === BLACK ? '黑棋' : '白棋'} · 自由摆谱` : state.toPlay === human ? '轮到你落子' : '轮到 KataGo 落子';
  $('undo-button').disabled = !state.moves.length || busy;
  $('pass-button').disabled = !canPlay();
  $('hint-button').disabled = busy || state.over || resigned;
  $('hint-button').innerHTML = `<span>✧</span> ${mode === 'analysis' ? '分析局面' : state.toPlay !== human && !state.over && !resigned ? '继续落子' : 'AI 提示'}`;
  $('score-button').disabled = busy || !state.moves.length;
  $('resign-button').disabled = busy || state.over || resigned || mode === 'analysis';
  $('opponent-rank').value = opponentRank;
  $('opponent-rank').disabled = busy || mode === 'analysis';
  $('strength').disabled = busy;
  $('budget-label').textContent = opponentRank === DEFAULT_RANK && mode === 'play' ? '每手思考' : '分析用时';
  $('rank-note').textContent = mode === 'analysis' ? '局面分析始终使用全力引擎。' : opponentRank === DEFAULT_RANK ? '全力搜索；长考提供更多计算时间。' : engineStatus && !engineStatus.ranksAvailable ? '人类棋风模型未就绪，请重新安装模型。' : state.size === 19 ? '近似 KGS 网络棋风，非认证段位。' : '小棋盘为实验性模仿，段位未校准。';
  $('page-label').textContent = mode === 'analysis' ? '棋局分析' : '人机对弈';
  $('page-title').textContent = mode === 'analysis' ? '在每一手，读懂棋局。' : '好棋，从这一手开始。';
  $('page-subtitle').textContent = mode === 'analysis' ? '自由落子，随时请 KataGo 看看局面的可能。' : '与 KataGo 对弈，在黑白之间，找到自己的节奏。';
  $('play-tab').classList.toggle('active', mode === 'play');
  $('analyze-tab').classList.toggle('active', mode === 'analysis');
  renderEvaluation();
  renderBoard();
}

function renderEvaluation() {
  const entry = evaluations.findLast(e => e.ply <= state.moves.length);
  const result = evaluation || entry?.result;
  if (!result) {
    $('winrate').innerHTML = '—<small> %</small>';
    $('winrate-fill').style.width = '50%';
    $('eval-label').textContent = '等待分析';
    $('score-label').textContent = '点击 AI 提示，获取实时判断';
    $('visits').textContent = '—'; $('recommendation').textContent = '—';
    $('pv-line').textContent = '每一步判断，来自真正的 KataGo 搜索。';
  } else {
    const black = result.player === BLACK ? result.winrate : 1 - result.winrate;
    const blackLead = result.player === BLACK ? result.scoreLead : -result.scoreLead;
    const isCurrent = evaluation != null;
    $('winrate').innerHTML = `${(black * 100).toFixed(1)}<small> %</small>`;
    $('winrate-fill').style.width = `${Math.max(0, Math.min(100, black * 100))}%`;
    $('eval-label').textContent = isCurrent ? '当前局面' : `第 ${entry?.ply ?? 0} 手时`;
    $('score-label').textContent = `${blackLead >= 0 ? '黑棋' : '白棋'}预计领先 ${Math.abs(blackLead).toFixed(1)} 目`;
    $('visits').textContent = Number(result.visits).toLocaleString();
    $('recommendation').textContent = isCurrent ? coord(result.index) : '—';
    $('pv-line').textContent = isCurrent && result.pv?.length ? `参考变化：${result.pv.slice(0, 7).map(x => x.toLowerCase() === 'pass' ? '停一手' : x).join(' → ')}` : '落子前的局面判断；点击 AI 提示可重新分析。';
  }
  const points = evaluations.filter(e => e.ply <= state.moves.length).slice(-60);
  $('chart-line').setAttribute('d', points.length > 1 ? points.map((e, i) => `${i ? 'L' : 'M'}${(i / (points.length - 1) * 260).toFixed(1)} ${(62 - e.blackWinrate * 56).toFixed(1)}`).join(' ') : '');
}

function handleMove(index) {
  if (!canPlay()) {
    if (busy) toast('KataGo 正在思考，请稍等。');
    else if (!state.over && !resigned && state.toPlay !== human) requestAI(true);
    return;
  }
  const result = playMove(state, index);
  if (!result.ok) { toast(result.error); return; }
  state = result.state; evaluation = null; suggestion = -2; hover = -1;
  save(); render();
  if (state.over) showEnd();
  else if (mode === 'play') requestAI(true);
}

async function getStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('无法连接本地围棋服务。');
    engineStatus = await response.json();
    setupUI.update(engineStatus);
    const good = engineStatus.installed && !engineStatus.error;
    $('engine-state').classList.toggle('error', !good);
    $('engine-state').innerHTML = `<i></i> ${!good ? '未就绪' : engineStatus.ready ? '已连接' : engineStatus.starting ? '启动中' : '已安装'}`;
    const device = /^(?:eigen|cpu)/i.test(String(engineStatus.backend)) ? 'CPU' : 'GPU';
    $('model-label').textContent = good ? `${engineStatus.version} · ${String(engineStatus.backend).toUpperCase()} ${device}` : '等待本地引擎';
    $('model-label').title = engineStatus.model || '';
    $('engine-note').textContent = !good ? engineStatus.error || '请先安装 KataGo。' : engineStatus.starting ? '正在加载模型与显卡缓存，首次可能较久。' : `本地 ${device} 搜索 · 分析始终使用全力模型`;
    for (const select of [$('opponent-rank'), $('new-rank')]) {
      for (const option of select.options) option.disabled = option.value !== DEFAULT_RANK && !engineStatus.ranksAvailable;
    }
    $('retry-engine').hidden = good;
    $('rail-status').textContent = good ? `本地 KataGo · ${device}` : '本地引擎 · 待连接';
    $('rail-dot').style.background = good ? '#8baa78' : '#c6a371';
    render();
  } catch (error) {
    engineStatus = { installed: false, error: error.message };
    $('engine-state').classList.add('error');
    $('engine-state').innerHTML = '<i></i> 连接失败';
    $('engine-note').textContent = '请保持「启动围棋」窗口打开，再重新连接。';
    $('retry-engine').hidden = false;
    $('rail-status').textContent = '本地引擎 · 未连接';
  }
}

async function requestAI(play = false) {
  if (busy || state.over || resigned || (play && (mode !== 'play' || state.toPlay === human))) return;
  const token = generation;
  busy = true; render();
  requestController = new AbortController();
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: requestController.signal,
      body: JSON.stringify({ state: { size: state.size, komi: state.komi, board: state.board, toPlay: state.toPlay, moves: state.moves, over: state.over }, level: $('strength').value, rank: opponentRank, purpose: play ? 'play' : 'analyze' }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'KataGo 分析失败，请重试。');
    if (generation !== token) return;
    if (!Number.isInteger(result.index) || !Number.isFinite(result.winrate) || !Number.isFinite(result.scoreLead)) throw new Error('引擎返回了无效的分析数据。');
    result.player = state.toPlay;
    evaluation = result;
    evaluations = evaluations.filter(e => e.ply !== state.moves.length);
    evaluations.push({ ply: state.moves.length, blackWinrate: result.player === BLACK ? result.winrate : 1 - result.winrate, result });
    evaluations.sort((a, b) => a.ply - b.ply);
    if (play) {
      const move = playMove(state, result.index);
      if (!move.ok) throw new Error(`KataGo 着法被规则检查拒绝：${move.error}`);
      state = move.state; evaluation = null; suggestion = -2;
      if (result.index === -1) toast('KataGo 选择停一手。');
    } else {
      suggestion = result.index;
      toast(`KataGo 推荐：${coord(result.index)} · 搜索 ${Number(result.visits).toLocaleString()} 次`);
    }
    $('tip-title').textContent = play ? `${rankLabel(result.opponentRank || opponentRank)} · ${coord(result.index)}` : `全力分析 · 可以考虑 ${coord(result.index)}`;
    $('tip-text').textContent = `${result.selectionMethod === 'human-policy' ? '人类棋风模拟 · ' : ''}用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒 · 局面评估仅供参考。`;
    save();
    getStatus();
    if (state.over) showEnd();
  } catch (error) {
    if (error.name !== 'AbortError' && generation === token) {
      toast(error.message.length > 160 ? error.message.slice(0, 160) + '…' : error.message);
      $('tip-title').textContent = '引擎暂时无法计算';
      $('tip-text').textContent = error.message;
      $('retry-engine').hidden = false;
      getStatus();
    }
  } finally {
    if (generation === token) { busy = false; render(); if (autoScorePending) { autoScorePending = false; requestScore(); } }
  }
}

function rebuild(moves) {
  let next = createGame(state.size, state.komi);
  for (const move of moves) {
    const result = playMove(next, move.index);
    if (!result.ok) throw new Error(result.error);
    next = result.state;
  }
  return next;
}

function undo() {
  if (busy || !state.moves.length) return;
  let target = state.moves.length - 1;
  if (mode === 'play') {
    while (target > 0 && state.moves[target]?.player !== human) target--;
    if (state.moves[target]?.player !== human) { toast('这局还没有你的落子，可以开始新对局。'); return; }
  }
  state = rebuild(state.moves.slice(0, target));
  evaluations = evaluations.filter(e => e.ply <= target);
  evaluation = evaluations.findLast(e => e.ply === target)?.result ?? null;
  suggestion = -2; resigned = false; generation++;
  $('tip-title').textContent = `回到第 ${state.moves.length} 手，重新思考。`;
  $('tip-text').textContent = '可以继续落子，或请全力引擎重新分析。';
  save(); render(); toast(mode === 'analysis' ? '已撤回上一手。' : '已回到你落子之前。');
}

function info(title, paragraphs) {
  $('info-title').textContent = title;
  $('info-content').replaceChildren(...paragraphs.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  if (!$('info-dialog').open) $('info-dialog').showModal();
}

function showEnd() {
  if (busy) autoScorePending = true;
  else requestScore();
}

async function requestScore() {
  if (busy || !state.moves.length) return;
  const token = generation;
  busy = true; render();
  requestController = new AbortController();
  toast('正在分析死活并数子…');
  try {
    const response = await fetch('/api/score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: requestController.signal,
      body: JSON.stringify({ state, level: $('strength').value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'AI 数子失败，请重试。');
    if (generation !== token) return;
    if (!result.scoring || !Array.isArray(result.scoring.suggestedDead)) throw new Error('Invalid scoring response.');
    showScore(state, result);
  } catch (error) { if (error.name !== 'AbortError' && generation === token) toast(error.message); }
  finally { if (generation === token) { busy = false; render(); } }
}

function exportSgf() {
  const escape = text => String(text).replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
  const aiName = `KataGo (${rankLabel()})`;
  const blackName = mode === 'analysis' ? 'Black' : human === BLACK ? 'Human' : aiName;
  const whiteName = mode === 'analysis' ? 'White' : human === WHITE ? 'Human' : aiName;
  const date = new Date();
  const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const result = resigned ? `RE[${human === BLACK ? 'W' : 'B'}+R]` : '';
  const profileNote = mode === 'analysis' ? '自由分析棋谱。' : `导出时的对手档位：${rankLabel()}。中途调整档位仅影响后续落子；段级位为 KGS 近似棋风，不是认证段位。`;
  let text = `(;GM[1]FF[4]CA[UTF-8]AP[ShiroGo:1.3]SZ[${state.size}]KM[${state.komi}]RU[Chinese]DT[${localDate}]PB[${escape(blackName)}]PW[${escape(whiteName)}]C[${escape(translateText(profileNote, getLanguage()))}]${result}`;
  for (const move of state.moves) {
    const point = move.index < 0 ? '' : String.fromCharCode(97 + move.index % state.size) + String.fromCharCode(97 + Math.floor(move.index / state.size));
    text += `;${move.player === BLACK ? 'B' : 'W'}[${point}]`;
  }
  text += ')';
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-go-sgf;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = getLanguage() === 'en' ? `Shiro-Go-${localDate}-${state.size}x${state.size}.sgf` : `弈间-${localDate}-${state.size}路.sgf`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('棋谱已导出为 SGF 文件。');
}

function switchMode(next) {
  if (busy) { toast('请等 KataGo 完成当前计算。'); return; }
  if (mode === next) return;
  mode = next; suggestion = -2; save(); render();
  if (mode === 'play') requestAI(true);
  else toast('已进入分析模式，你可以为双方落子。');
}

function pointAt(event) {
  const box = canvas.getBoundingClientRect();
  const { margin, step } = geometry();
  const row = Math.round((event.clientY - box.top - margin) / step);
  const col = Math.round((event.clientX - box.left - margin) / step);
  return row < 0 || row >= state.size || col < 0 || col >= state.size ? -1 : row * state.size + col;
}

canvas.addEventListener('pointermove', event => { const point = pointAt(event); if (point !== hover) { hover = point; renderBoard(); } });
canvas.addEventListener('pointerleave', () => { hover = -1; renderBoard(); });
canvas.addEventListener('click', event => { const point = pointAt(event); if (point >= 0) handleMove(point); });
canvas.addEventListener('keydown', event => {
  const directions = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -state.size, ArrowDown: state.size };
  if (event.key in directions) {
    event.preventDefault();
    if (focusPoint < 0) focusPoint = Math.floor(state.size ** 2 / 2);
    else {
      const row = Math.floor(focusPoint / state.size), col = focusPoint % state.size;
      if (event.key === 'ArrowLeft' && col > 0 || event.key === 'ArrowRight' && col < state.size - 1 || event.key === 'ArrowUp' && row > 0 || event.key === 'ArrowDown' && row < state.size - 1) focusPoint += directions[event.key];
    }
    canvas.setAttribute('aria-label', `围棋棋盘，光标位于 ${coord(focusPoint)}。方向键移动，回车落子。`);
    renderBoard();
  } else if ((event.key === 'Enter' || event.key === ' ') && focusPoint >= 0) { event.preventDefault(); handleMove(focusPoint); }
});
canvas.addEventListener('focus', () => { if (focusPoint < 0) focusPoint = Math.floor(state.size ** 2 / 2); renderBoard(); });
canvas.addEventListener('blur', renderBoard);
new ResizeObserver(renderBoard).observe(canvas);
$('undo-button').addEventListener('click', undo);
$('pass-button').addEventListener('click', () => handleMove(-1));
$('hint-button').addEventListener('click', () => requestAI(mode === 'play' && state.toPlay !== human));
$('score-button').addEventListener('click', requestScore);
$('export-button').addEventListener('click', exportSgf);
$('strength').addEventListener('change', () => { save(); render(); });
$('stop-thinking').addEventListener('click', () => {
  if (!busy) return;
  generation++; requestController?.abort(); busy = false; autoScorePending = false;
  render(); toast('已停止思考，棋局已保留。');
});
$('opponent-rank').addEventListener('change', () => {
  const chosen = getRank($('opponent-rank').value);
  if (!chosen) return;
  opponentRank = chosen.id;
  save(); render();
  toast(`后续 AI 落子使用：${rankLabel()}。`);
  if (mode === 'play' && state.toPlay !== human) requestAI(true);
});
$('play-tab').addEventListener('click', () => switchMode('play'));
$('analyze-tab').addEventListener('click', () => switchMode('analysis'));
$('retry-engine').addEventListener('click', async () => { await getStatus(); if (mode === 'play' && state.toPlay !== human) requestAI(true); else requestAI(false); });
$('resign-button').addEventListener('click', () => {
  if (busy || state.over || resigned || mode === 'analysis') return;
  resigned = true; save(); render();
  info('对局结束', [`${human === BLACK ? '黑棋' : '白棋'}认输，KataGo 获胜。`, '每局棋都有值得回味的地方。可以导出棋谱，或悔棋回到上一手。']);
});
$('help-button').addEventListener('click', () => info('关于弈间', [
  '最强档使用 KataGo 全力模型。思考预算可选 1、3、10、30、60 秒；增加时间能增加搜索量。首次启动含模型加载或显卡缓存构建，实际用时可能超过预算。',
  '20 级到 9 段使用官方 HumanSL 模型模拟 KGS 相应水平的落子分布，不等同于中国业余段位证书或职业段位；高段棋风采样也不保证达到对应玩家的实战棋力。9／13 路为实验性模仿，段位没有校准。可中途修改，对之后的 AI 落子生效。',
  'AI 提示和棋局分析始终使用全力模型，不受对手段位限制；分析时间由“分析用时”控制。',
  '点击棋盘交叉点落子；支持提子、禁自杀、全局同形和双方停一手终局。使用中国面积规则，白棋默认贴 7.5 目。键盘可用方向键选择位置、回车落子。',
  'AI 提示会显示候选点、胜率、预计领先目数与参考变化。棋局分析模式可为双方落子，再请求 KataGo 分析；这些数据都是估计。',
  'AI 数子使用全力 KataGo 分析死活，按中国面积规则计算。可点击棋块修正死活；未定型局面、双活和劫争需要人工复核。双方停一手后自动数子。',
  '棋局自动保存在此浏览器，可导出标准 SGF。关闭「启动围棋」窗口会停止本地服务。所有对弈计算均在本机进行。',
]));
$('close-info').addEventListener('click', () => $('info-dialog').close());
$('new-game').addEventListener('click', () => {
  newSize = state.size; newColor = human; $('komi-input').value = state.komi;
  $('new-rank').value = opponentRank;
  document.querySelectorAll('[data-size]').forEach(b => b.classList.toggle('selected', Number(b.dataset.size) === newSize));
  document.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('selected', Number(b.dataset.color) === newColor));
  $('new-dialog').showModal();
});
$('cancel-new').addEventListener('click', () => $('new-dialog').close());
document.querySelectorAll('[data-size]').forEach(button => button.addEventListener('click', () => { newSize = Number(button.dataset.size); document.querySelectorAll('[data-size]').forEach(b => b.classList.toggle('selected', b === button)); }));
document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => { newColor = Number(button.dataset.color); document.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('selected', b === button)); }));
$('new-form').addEventListener('submit', event => {
  event.preventDefault();
  const komi = Number($('komi-input').value);
  if (!Number.isFinite(komi) || komi < -50 || komi > 50 || !Number.isInteger(komi * 2)) { toast('贴目须为 -50 到 50 之间的整数或半目。'); return; }
  if (!getRank($('new-rank').value)) { toast('请选择有效的对手水平。'); return; }
  generation++; requestController?.abort(); busy = false; autoScorePending = false;
  opponentRank = $('new-rank').value;
  state = createGame(newSize, komi); human = newColor; resigned = false; evaluation = null; evaluations = []; suggestion = -2; hover = -1; focusPoint = -1;
  $('tip-title').textContent = '留一点空间，给思考。';
  $('tip-text').textContent = '落子前，看看自己的气，也看看对手的意图。';
  $('new-dialog').close(); save(); render(); requestAI(true);
});

restore(); render();
initLanguage();
await getStatus();
if (mode === 'play' && state.toPlay !== human && !state.over && !resigned) requestAI(true);
setInterval(() => { if (busy || engineStatus?.starting) getStatus(); }, 4000);
