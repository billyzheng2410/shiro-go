/**
 * Dependency-free Go rules and a small offline practice opponent.
 * Rules: area scoring, positional superko, no suicide, two passes to finish.
 * Strong play is provided separately by the local KataGo service.
 */
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

const neighborCache = new Map();

function neighborsFor(size) {
  if (neighborCache.has(size)) return neighborCache.get(size);
  const neighbors = Array.from({ length: size * size }, (_, index) => {
    const row = Math.floor(index / size);
    const col = index % size;
    const points = [];
    if (row > 0) points.push(index - size);
    if (row + 1 < size) points.push(index + size);
    if (col > 0) points.push(index - 1);
    if (col + 1 < size) points.push(index + 1);
    return points;
  });
  neighborCache.set(size, neighbors);
  return neighbors;
}

function boardKey(board) {
  return board.join('');
}

function groupAt(board, index, neighbors) {
  const color = board[index];
  const stones = [index];
  const seen = new Set(stones);
  const liberties = new Set();
  for (let cursor = 0; cursor < stones.length; cursor++) {
    for (const next of neighbors[stones[cursor]]) {
      if (board[next] === EMPTY) liberties.add(next);
      else if (board[next] === color && !seen.has(next)) {
        seen.add(next);
        stones.push(next);
      }
    }
  }
  return { color, stones, liberties };
}

function positionGroups(board, neighbors) {
  const groupByPoint = new Array(board.length);
  const groups = [];
  for (let index = 0; index < board.length; index++) {
    if (!board[index] || groupByPoint[index]) continue;
    const group = groupAt(board, index, neighbors);
    groups.push(group);
    for (const stone of group.stones) groupByPoint[stone] = group;
  }
  return { groups, groupByPoint };
}

function tryBoardMove(board, size, player, index, forbidden = null) {
  if (!Number.isInteger(index) || index < 0 || index >= board.length) {
    return { ok: false, error: '落点不在棋盘内。' };
  }
  if (board[index] !== EMPTY) return { ok: false, error: '这个位置已有棋子。' };
  const neighbors = neighborsFor(size);
  const next = board.slice();
  const removed = [];
  next[index] = player;
  for (const adjacent of neighbors[index]) {
    if (next[adjacent] !== 3 - player) continue;
    const group = groupAt(next, adjacent, neighbors);
    if (group.liberties.size === 0) {
      for (const stone of group.stones) {
        next[stone] = EMPTY;
        removed.push(stone);
      }
    }
  }
  const ownGroup = groupAt(next, index, neighbors);
  if (ownGroup.liberties.size === 0) return { ok: false, error: '禁入点：这手棋会使自己的棋子无气。' };
  const key = boardKey(next);
  if (forbidden?.has(key)) return { ok: false, error: '此处涉及打劫或全局同形，请先在其他位置落子。' };
  return { ok: true, board: next, captured: removed.length, removed, key, ownGroup };
}

/** All state is plain serializable data; black moves first. */
export function createGame(size = 9, komi = 7.5) {
  if (!Number.isInteger(size) || size < 2 || size > 25) throw new RangeError('棋盘边长必须是 2 至 25 的整数。');
  if (!Number.isFinite(komi)) throw new TypeError('贴目必须是有限数字。');
  const board = new Array(size * size).fill(EMPTY);
  return {
    size,
    komi,
    board,
    toPlay: BLACK,
    captures: { [BLACK]: 0, [WHITE]: 0 },
    passes: 0,
    over: false,
    history: [boardKey(board)],
    moves: [],
  };
}

/** Returns a new state; an illegal action returns the original, unchanged state. */
export function playMove(state, index) {
  if (state.over) return { ok: false, error: '棋局已结束，请开始新棋局或悔棋。', state };
  const player = state.toPlay;
  if (index === -1) {
    const passes = state.passes + 1;
    return {
      ok: true,
      error: null,
      state: {
        ...state,
        board: state.board.slice(),
        captures: { ...state.captures },
        toPlay: 3 - player,
        passes,
        over: passes >= 2,
        history: [...state.history, boardKey(state.board)],
        moves: [...state.moves, { index: -1, player, captured: 0, removed: [], pass: true }],
      },
    };
  }
  const result = tryBoardMove(state.board, state.size, player, index, new Set(state.history));
  if (!result.ok) return { ok: false, error: result.error, state };
  return {
    ok: true,
    error: null,
    state: {
      ...state,
      board: result.board,
      captures: { ...state.captures, [player]: state.captures[player] + result.captured },
      toPlay: 3 - player,
      passes: 0,
      over: false,
      history: [...state.history, result.key],
      moves: [...state.moves, { index, player, captured: result.captured, removed: result.removed, pass: false }],
    },
  };
}

/** Legal indices, followed by -1 (pass). Finished games have no legal actions. */
export function legalMoves(state) {
  if (state.over) return [];
  const forbidden = new Set(state.history);
  const moves = [];
  for (let index = 0; index < state.board.length; index++) {
    if (!state.board[index] && tryBoardMove(state.board, state.size, state.toPlay, index, forbidden).ok) moves.push(index);
  }
  moves.push(-1);
  return moves;
}

/**
 * Counts stones plus surrounded empty intersections. white includes komi.
 * This is a mechanical area count: it does not automatically adjudicate dead
 * groups. Finish captures or use KataGo's estimate when groups remain unsettled.
 */
export function scoreGame(state) {
  const { board, size, komi } = state;
  const neighbors = neighborsFor(size);
  const territory = new Array(board.length).fill(EMPTY);
  const visited = new Set();
  let blackStones = 0;
  let whiteStones = 0;
  let blackTerritory = 0;
  let whiteTerritory = 0;
  let neutral = 0;
  for (let index = 0; index < board.length; index++) {
    if (board[index] === BLACK) { blackStones++; continue; }
    if (board[index] === WHITE) { whiteStones++; continue; }
    if (visited.has(index)) continue;
    const region = [index];
    const border = new Set();
    visited.add(index);
    for (let cursor = 0; cursor < region.length; cursor++) {
      for (const next of neighbors[region[cursor]]) {
        if (board[next]) border.add(board[next]);
        else if (!visited.has(next)) {
          visited.add(next);
          region.push(next);
        }
      }
    }
    const owner = border.size === 1 ? border.values().next().value : EMPTY;
    if (owner === BLACK) blackTerritory += region.length;
    else if (owner === WHITE) whiteTerritory += region.length;
    else neutral += region.length;
    for (const point of region) territory[point] = owner;
  }
  const black = blackStones + blackTerritory;
  const white = whiteStones + whiteTerritory + komi;
  return {
    black, white, komi,
    blackStones, whiteStones, blackTerritory, whiteTerritory, neutral,
    territory,
    winner: black === white ? EMPTY : black > white ? BLACK : WHITE,
    margin: Math.abs(black - white),
  };
}

function isOwnEye(board, index, player, size, neighbors) {
  if (!neighbors[index].every(point => board[point] === player)) return false;
  const row = Math.floor(index / size);
  const col = index % size;
  let hostile = 0;
  let diagonals = 0;
  for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || r >= size || c < 0 || c >= size) continue;
    diagonals++;
    if (board[r * size + c] === 3 - player) hostile++;
  }
  return diagonals === 4 ? hostile < 2 : hostile === 0;
}

function rankedMoves(board, size, player, forbidden, lastIndex = -1) {
  const neighbors = neighborsFor(size);
  const { groupByPoint } = positionGroups(board, neighbors);
  const candidates = [];
  let occupied = 0;
  for (const value of board) if (value) occupied++;
  for (let index = 0; index < board.length; index++) {
    if (board[index]) continue;
    const result = tryBoardMove(board, size, player, index, forbidden);
    if (!result.ok) continue;
    const groups = new Set(neighbors[index].map(point => groupByPoint[point]).filter(Boolean));
    let priority = result.captured * 8;
    for (const group of groups) {
      if (group.color === player && group.liberties.size === 1 && result.ownGroup.liberties.size > 1) {
        priority += 7 + Math.min(group.stones.length, 8) * 2;
      } else if (group.color !== player && group.liberties.size === 2) {
        priority += 1.5 + Math.min(group.stones.length, 6) * 0.5;
      }
    }
    if (result.ownGroup.liberties.size === 1 && !result.captured) priority -= 16 + result.ownGroup.stones.length * 2;
    if (isOwnEye(board, index, player, size, neighbors) && !result.captured) priority -= 40;
    const row = Math.floor(index / size);
    const col = index % size;
    const edge = Math.min(row, col, size - row - 1, size - col - 1);
    if (occupied < size * size * 0.3) priority += Math.min(edge, 2) * 0.8;
    let nearest = size;
    for (let point = 0; point < board.length; point++) {
      if (!board[point]) continue;
      const distance = Math.abs(row - Math.floor(point / size)) + Math.abs(col - point % size);
      nearest = Math.min(nearest, distance);
      if (distance === 1) priority += board[point] === player ? 0.15 : 0.5;
    }
    if (nearest >= 3 && nearest <= 5) priority += 1;
    if (lastIndex >= 0 && occupied > size) {
      const distance = Math.abs(row - Math.floor(lastIndex / size)) + Math.abs(col - lastIndex % size);
      if (distance <= 3) priority += 0.25;
    }
    // Break symmetric openings without giving noise priority over urgent tactics.
    priority += Math.random() * 0.2;
    candidates.push({ index, priority, ...result });
  }
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

function evaluateBoard(board, size, komi, player) {
  const counted = scoreGame({ board, size, komi });
  let difference = counted.black - counted.white;
  const { groups } = positionGroups(board, neighborsFor(size));
  for (const group of groups) {
    if (group.liberties.size !== 1) continue;
    const penalty = Math.min(group.stones.length, 10) * 1.25;
    difference += group.color === BLACK ? -penalty : penalty;
  }
  return (player === BLACK ? difference : -difference) / Math.max(5, size);
}

/**
 * Lightweight practice AI: tactical move ordering plus bounded Monte Carlo
 * sampling. This is deliberately not advertised as a strong Go engine.
 */
export function selectAIMove(state, { level = 'medium', timeLimitMs } = {}) {
  const start = performance.now();
  const budget = Math.max(0, timeLimitMs ?? ({ easy: 100, medium: 350, hard: 800 }[level] ?? 350));
  const deadline = start + budget;
  const forbidden = new Set(state.history);
  if (state.over) return { index: -1, simulations: 0, elapsedMs: performance.now() - start };
  const lastMove = state.moves.at(-1)?.index ?? -1;
  const candidates = rankedMoves(state.board, state.size, state.toPlay, forbidden, lastMove);
  if (!candidates.length) return { index: -1, simulations: 0, elapsedMs: performance.now() - start };
  // Match a pass when settled, but don't abandon an urgent capture or rescue.
  if (state.passes && candidates[0].priority < 0) {
    return { index: -1, simulations: 0, elapsedMs: performance.now() - start };
  }
  const width = level === 'easy' ? 4 : level === 'hard' ? 10 : 7;
  const options = candidates.slice(0, width).map(candidate => ({ ...candidate, visits: 0, total: 0 }));
  let simulations = 0;
  while (performance.now() < deadline) {
    let choice = options.find(option => option.visits === 0);
    if (!choice) {
      choice = options.reduce((best, option) => {
        const value = option.total / option.visits + 0.8 * Math.sqrt(Math.log(simulations + 1) / option.visits) + option.priority * 0.07;
        return !best || value > best.value ? { option, value } : best;
      }, null).option;
    }
    let board = choice.board;
    let player = 3 - state.toPlay;
    let lastIndex = choice.index;
    const seen = new Set(forbidden);
    seen.add(choice.key);
    const rolloutDepth = level === 'easy' ? 2 : level === 'hard' ? 8 : 4;
    for (let ply = 0; ply < rolloutDepth && performance.now() < deadline; ply++) {
      const replies = rankedMoves(board, state.size, player, seen, lastIndex);
      if (!replies.length || replies[0].priority < -10) break;
      const spread = Math.min(3, replies.length);
      const move = replies[0].priority - replies[spread - 1].priority > 5 ? replies[0] : replies[Math.floor(Math.random() * spread)];
      board = move.board;
      seen.add(move.key);
      lastIndex = move.index;
      player = 3 - player;
    }
    choice.total += Math.tanh(evaluateBoard(board, state.size, state.komi, state.toPlay));
    choice.visits++;
    simulations++;
  }
  const best = options.reduce((selected, option) => {
    const value = (option.visits ? option.total / option.visits : 0) + option.priority * 0.1;
    return !selected || value > selected.value ? { index: option.index, value } : selected;
  }, null);
  // In a nearly filled position, avoid unnecessary moves into safe own eyes.
  const index = candidates[0].priority < -12 ? -1 : best.index;
  return { index, simulations, elapsedMs: performance.now() - start };
}
