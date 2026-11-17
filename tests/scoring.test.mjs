import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, playMove } from '../dist/engine.js';
import { countScore, deadFromOwnership, groupMembers } from '../dist/scoring.js';
import { KataGoEngine } from '../katago.mjs';

test('dead-stone judgment requires opponent ownership for the entire connected group', () => {
  const state = createGame(9); state.board[0] = state.board[1] = 1; state.board[80] = 2;
  const ownership = Array(81).fill(0); ownership[0] = ownership[1] = -0.99; ownership[80] = -0.99;
  assert.deepEqual(deadFromOwnership(state, ownership), { dead: [0, 1], uncertainGroups: 0 });
  ownership[1] = 0;
  assert.deepEqual(deadFromOwnership(state, ownership), { dead: [], uncertainGroups: 1 });
  assert.throws(() => deadFromOwnership(state, []), /Invalid ownership/);
  assert.throws(() => deadFromOwnership(state, Array(81).fill(NaN)), /Invalid ownership/);
  assert.deepEqual(groupMembers(state.board, 9, 80), [80]);
});

test('Chinese area removes marked stones once, includes komi, and preserves the game', () => {
  const state = createGame(9); state.board.fill(1); state.board[40] = 2; state.board[41] = 0;
  const before = JSON.stringify(state);
  const score = countScore(state, [40, 40]);
  assert.equal(score.black, 81); assert.equal(score.white, 7.5);
  assert.equal(score.whiteDead, 1); assert.equal(score.blackStones, 79);
  assert.equal(score.blackTerritory, 2); assert.equal(score.blackLead, 73.5);
  assert.equal(JSON.stringify(state), before);
  assert.throws(() => countScore(state, [41]), /Invalid dead/);
});

test('ownership is normalized from the current player to black for both seats', async () => {
  for (const player of [1, 2]) {
    const engine = new KataGoEngine();
    const promise = new Promise((resolve, reject) => engine.pending.set('ownership', { resolve, reject, size: 9, player, started: performance.now() }));
    engine.receiveLine(JSON.stringify({ id: 'ownership', rootInfo: { winrate: .5, scoreLead: 1, visits: 1 }, moveInfos: [{ move: 'E5', order: 0 }], ownership: Array(81).fill(.9) }));
    const result = await promise;
    assert.equal(result.ownership[0], player === 1 ? .9 : -.9);
    assert.equal(result.ownershipPerspective, 'BLACK'); engine.close();
  }
});

test('scoring accepts two-pass endings, replays legal history, and always uses full-strength analysis', async () => {
  let state = createGame(9);
  for (const index of [0, 80, -1, -1]) state = playMove(state, index).state;
  const before = JSON.stringify(state);
  const engine = new KataGoEngine(); let called = false;
  engine.analyze = async (position, level, limit, options) => {
    called = true; assert.equal(position.over, false); assert.equal(position.moves.length, 2);
    assert.deepEqual(position.board, state.board); assert.equal(level, 'fast');
    assert.equal(options.rank, 'max'); assert.equal(options.purpose, 'analyze');
    const ownership = Array(81).fill(0); ownership[0] = .99; ownership[80] = -.99;
    return { player: position.toPlay, scoreLead: 2, ownership };
  };
  const result = await engine.score(state, 'fast', .1);
  assert.ok(called); assert.equal(result.purpose, 'score'); assert.equal(result.scoring.estimatedBlackLead, 2);
  assert.equal(result.scoring.estimateOnly, true); assert.equal(JSON.stringify(state), before);
  const forged = { ...state, board: state.board.slice() }; forged.board[1] = 1;
  await assert.rejects(engine.score(forged), /棋盘与棋谱不一致/); engine.close();
});

test('midgame scoring retains white perspective for estimates but never declares a final result', async () => {
  const state = playMove(createGame(9), 0).state;
  const engine = new KataGoEngine();
  engine.analyze = async () => ({ player: 2, scoreLead: 5, ownership: Array(81).fill(.99) });
  const result = await engine.score(state);
  assert.equal(result.scoring.estimatedBlackLead, -5); assert.equal(result.scoring.requiresReview, true); engine.close();
});
