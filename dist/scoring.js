import { scoreGame } from './engine.js';

export function groupMembers(board, size, start) {
  if (!board[start]) return [];
  const color = board[start], group = [start], seen = new Set(group);
  for (let p = 0; p < group.length; p++) {
    const i = group[p], row = Math.floor(i / size), col = i % size;
    for (const next of [row > 0 ? i - size : -1, row + 1 < size ? i + size : -1, col > 0 ? i - 1 : -1, col + 1 < size ? i + 1 : -1]) {
      if (next >= 0 && board[next] === color && !seen.has(next)) { seen.add(next); group.push(next); }
    }
  }
  return group;
}

/** KataGo ownership is normalized to BLACK's perspective by the adapter. */
export function deadFromOwnership(state, ownership, threshold = 0.85) {
  if (!Array.isArray(ownership) || ownership.length !== state.board.length || ownership.some(n => !Number.isFinite(n) || n < -1.001 || n > 1.001)) throw new Error('Invalid ownership map.');
  const dead = [], visited = new Set(); let uncertainGroups = 0;
  for (let i = 0; i < state.board.length; i++) {
    if (!state.board[i] || visited.has(i)) continue;
    const group = groupMembers(state.board, state.size, i);
    group.forEach(point => visited.add(point));
    const sign = state.board[i] === 1 ? 1 : -1;
    const values = group.map(point => ownership[point] * sign);
    if (values.every(value => value <= -threshold)) dead.push(...group);
    else if (values.some(value => value < threshold)) uncertainGroups++;
  }
  return { dead, uncertainGroups };
}

export function countScore(state, dead = []) {
  const marked = new Set(dead);
  if ([...marked].some(i => !Number.isInteger(i) || i < 0 || i >= state.board.length || !state.board[i])) throw new Error('Invalid dead-stone selection.');
  let blackDead = 0, whiteDead = 0;
  const board = state.board.map((stone, i) => {
    if (!marked.has(i)) return stone;
    if (stone === 1) blackDead++; else if (stone === 2) whiteDead++;
    return 0;
  });
  const score = scoreGame({ ...state, board });
  return { ...score, blackDead, whiteDead, dead: [...marked], blackLead: score.black - score.white };
}
