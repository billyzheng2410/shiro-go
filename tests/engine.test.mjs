import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLACK, WHITE, createGame, playMove, legalMoves, scoreGame, selectAIMove,
} from '../dist/engine.js';

function position(size, board, toPlay = BLACK, komi = 7.5) {
  return { ...createGame(size, komi), board, toPlay, history: [board.join('')] };
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

test('a legal action creates a new state without changing a frozen position', () => {
  const game = freeze(createGame(9));
  const result = playMove(game, 40);
  assert.equal(result.ok, true);
  assert.equal(game.board[40], 0);
  assert.equal(game.moves.length, 0);
  assert.equal(result.state.board[40], BLACK);
  assert.equal(result.state.toPlay, WHITE);
  assert.equal(result.state.moves[0].player, BLACK);
  assert.equal(result.state.history.length, 2);
  assert.notEqual(result.state.board, game.board);
});

test('occupied, out-of-range and non-integer actions are rejected unchanged', () => {
  const game = playMove(createGame(9), 40).state;
  for (const index of [40, -2, 81, 3.5, NaN, '4', null]) {
    const result = playMove(game, index);
    assert.equal(result.ok, false, `unexpectedly accepted ${String(index)}`);
    assert.equal(result.state, game);
    assert.equal(typeof result.error, 'string');
  }
});

test('one move can capture four distinct neighboring groups', () => {
  const board = new Array(25).fill(0);
  for (const point of [2, 6, 8, 10, 14, 16, 18, 22]) board[point] = BLACK;
  for (const point of [7, 11, 13, 17]) board[point] = WHITE;
  const game = freeze(position(5, board));
  const result = playMove(game, 12);
  assert.equal(result.ok, true);
  assert.equal(result.state.captures[BLACK], 4);
  assert.equal(result.state.captures[WHITE], 0);
  assert.deepEqual([...result.state.moves[0].removed].sort((a, b) => a - b), [7, 11, 13, 17]);
  for (const point of [7, 11, 13, 17]) assert.equal(result.state.board[point], 0);
  assert.equal(result.state.board[12], BLACK);
});

test('capture removes an entire connected group and permits an otherwise surrounded move', () => {
  const board = new Array(25).fill(0);
  for (const point of [6, 7, 10, 16, 17]) board[point] = BLACK;
  for (const point of [11, 12]) board[point] = WHITE;
  const result = playMove(position(5, board), 13);
  assert.equal(result.ok, true);
  assert.equal(result.state.captures[BLACK], 2);
  assert.equal(result.state.board[11], 0);
  assert.equal(result.state.board[12], 0);

  const corner = playMove(position(3, [WHITE, 0, 0, BLACK, 0, 0, 0, 0, 0]), 1);
  assert.equal(corner.ok, true);
  assert.equal(corner.state.board[0], 0);
});

test('suicide is illegal unless the placement captures an opponent group', () => {
  const game = position(3, [0, WHITE, 0, WHITE, 0, WHITE, 0, WHITE, 0]);
  assert.equal(playMove(game, 4).ok, false);
  assert.equal(legalMoves(game).includes(4), false);
  const capture = playMove(position(3, [0, BLACK, 0, BLACK, WHITE, BLACK, 0, 0, 0]), 7);
  assert.equal(capture.ok, true);
  assert.equal(capture.state.captures[BLACK], 1);
});

test('positional superko rejects immediate recapture; a ko threat permits recapture', () => {
  const board = new Array(25).fill(0);
  for (const point of [7, 11, 17]) board[point] = BLACK;
  for (const point of [8, 12, 14, 18]) board[point] = WHITE;
  const original = position(5, board);
  const capture = playMove(original, 13);
  assert.equal(capture.ok, true);
  assert.equal(capture.state.board[12], 0);
  assert.equal(playMove(capture.state, 12).ok, false);
  assert.equal(legalMoves(capture.state).includes(12), false);
  const whitePass = playMove(capture.state, -1).state;
  const blackThreat = playMove(whitePass, 0).state;
  const recapture = playMove(blackThreat, 12);
  assert.equal(recapture.ok, true);
  assert.equal(recapture.state.board[13], 0);
  assert.equal(recapture.state.board[12], WHITE);

  const olderRepetition = { ...original, history: [capture.state.board.join(''), ...original.history] };
  assert.equal(playMove(olderRepetition, 13).ok, false, 'must check all prior boards, not just the previous board');
});

test('a stone resets the pass count; two passes end the game and prevent further play', () => {
  const game = freeze(createGame(9));
  const first = playMove(game, -1).state;
  assert.equal(first.passes, 1);
  assert.equal(first.over, false);
  assert.equal(first.toPlay, WHITE);
  assert.deepEqual(first.board, game.board);
  assert.equal(playMove(first, 0).state.passes, 0);
  const ended = playMove(first, -1).state;
  assert.equal(ended.over, true);
  assert.deepEqual(legalMoves(ended), []);
  assert.equal(playMove(ended, 0).ok, false);
  assert.equal(playMove(ended, -1).ok, false);
});

test('area count includes stones, surrounded empties and komi, leaving mixed borders neutral', () => {
  const mixed = scoreGame(position(3, [BLACK, 0, 0, 0, 0, 0, 0, 0, WHITE]));
  assert.equal(mixed.black, 1);
  assert.equal(mixed.white, 8.5);
  assert.equal(mixed.neutral, 7);
  assert.equal(mixed.winner, WHITE);
  assert.equal(mixed.margin, 7.5);
  const surrounded = scoreGame(position(3, [0, 0, 0, 0, BLACK, 0, 0, 0, 0], BLACK, 0));
  assert.equal(surrounded.blackStones, 1);
  assert.equal(surrounded.blackTerritory, 8);
  assert.equal(surrounded.black, 9);
  assert.equal(surrounded.white, 0);
  assert.equal(surrounded.territory[4], 0, 'territory ownership describes empty intersections only');
  const empty = scoreGame(createGame(9, 0));
  assert.equal(empty.winner, 0);
  assert.equal(empty.neutral, 81);
});

test('offline practice AI returns legal moves for all supported board sizes and sees an urgent capture', () => {
  for (const size of [9, 13, 19]) {
    const game = createGame(size);
    const before = JSON.stringify(game);
    const result = selectAIMove(game, { level: 'medium', timeLimitMs: 15 });
    assert.equal(legalMoves(game).includes(result.index), true);
    assert.equal(JSON.stringify(game), before);
    assert.equal(Number.isFinite(result.elapsedMs), true);
    assert.equal(Number.isInteger(result.simulations), true);
  }
  const capture = position(3, [0, BLACK, 0, BLACK, WHITE, BLACK, 0, 0, 0]);
  assert.equal(selectAIMove(capture, { timeLimitMs: 0 }).index, 7);
});

test('seeded random legal games preserve liberties, non-repetition and total board area', () => {
  let seed = 424;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (const size of [5, 9, 13, 19]) {
    let game = createGame(size);
    const seen = new Set(game.history);
    for (let turn = 0; turn < 40 && !game.over; turn++) {
      const moves = legalMoves(game).filter(index => index >= 0);
      const index = moves.length ? moves[Math.floor(random() * moves.length)] : -1;
      const result = playMove(game, index);
      assert.equal(result.ok, true);
      game = result.state;
      if (index >= 0) {
        const key = game.board.join('');
        assert.equal(seen.has(key), false);
        seen.add(key);
      }
      const score = scoreGame(game);
      assert.equal(score.black + score.white - score.komi + score.neutral, size * size);
      // Independent flood-fill oracle: no occupied connected component may
      // survive a legal move with zero orthogonally adjacent empty points.
      const checked = new Set();
      for (let point = 0; point < game.board.length; point++) {
        if (!game.board[point] || checked.has(point)) continue;
        const color = game.board[point];
        const queue = [point];
        checked.add(point);
        let hasLiberty = false;
        while (queue.length) {
          const current = queue.pop();
          const row = Math.floor(current / size);
          const col = current % size;
          const adjacent = [row ? current - size : -1, row + 1 < size ? current + size : -1, col ? current - 1 : -1, col + 1 < size ? current + 1 : -1];
          for (const next of adjacent) {
            if (next < 0) continue;
            if (game.board[next] === 0) hasLiberty = true;
            else if (game.board[next] === color && !checked.has(next)) { checked.add(next); queue.push(next); }
          }
        }
        assert.equal(hasLiberty, true);
      }
    }
  }
});
