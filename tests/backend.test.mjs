import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGame, playMove } from '../dist/engine.js';
import { buildQuery, validateState, indexToGtp, gtpToIndex, EngineError, KataGoEngine } from '../katago.mjs';

test('GTP coordinates round-trip on 9, 13 and 19 lines, omitting column I', () => {
  for (const size of [9, 13, 19]) {
    for (let index = 0; index < size * size; index++) {
      const vertex = indexToGtp(index, size);
      assert.equal(vertex.startsWith('I'), false);
      assert.equal(gtpToIndex(vertex, size), index);
      assert.equal(gtpToIndex(vertex.toLowerCase(), size), index);
    }
    assert.equal(indexToGtp(0, size), `A${size}`);
    assert.equal(indexToGtp(size * size - 1, size), size === 19 ? 'T1' : size === 13 ? 'N1' : 'J1');
    assert.equal(indexToGtp(-1, size), 'pass');
    assert.equal(gtpToIndex('PASS', size), -1);
  }
  for (const vertex of ['I9', 'A0', 'T20', 'resign', '', null]) assert.throws(() => gtpToIndex(vertex, 19), EngineError);
  assert.throws(() => indexToGtp(81, 9), EngineError);
});

test('analysis query replays the actual history and uses the same rules as the board', () => {
  let game = createGame(9);
  for (const index of [0, 80, -1, 40]) game = playMove(game, index).state;
  const query = buildQuery('test-analysis', game, 'balanced', 2.5);
  assert.equal(query.id, 'test-analysis');
  assert.deepEqual(query.moves, [['B', 'A9'], ['W', 'J1'], ['B', 'pass'], ['W', 'E5']]);
  assert.equal(query.boardXSize, 9);
  assert.equal(query.boardYSize, 9);
  assert.deepEqual(query.analyzeTurns, [4]);
  assert.equal(query.komi, 7.5);
  assert.equal(query.rules.ko, 'POSITIONAL');
  assert.equal(query.rules.scoring, 'AREA');
  assert.equal(query.rules.suicide, false);
  assert.equal(query.overrideSettings.maxTime, 2.5);
  assert.equal(query.includeOwnership, true);
  assert.ok(buildQuery('fast', game, 'fast').maxVisits >= 1_000_000);
  assert.equal(buildQuery('max', game, 'max').overrideSettings.maxTime, 30);
  assert.equal(buildQuery('extended', game, 'extended').overrideSettings.maxTime, 60);
});

test('backend rejects invalid board data, turns, moves, search budgets and finished games', () => {
  const game = createGame(9);
  const invalid = [
    null,
    { ...game, size: 8 },
    { ...game, komi: Infinity },
    { ...game, komi: 7.2 },
    { ...game, board: [] },
    { ...game, board: game.board.map((value, index) => index === 0 ? 3 : value) },
    { ...game, toPlay: 2 },
    { ...game, moves: [{ index: 0, player: 2 }] },
    { ...game, moves: [{ index: 81, player: 1 }], toPlay: 2 },
    { ...game, moves: [{ index: 0, player: 1, pass: true }], toPlay: 2 },
    { ...game, over: true },
  ];
  for (const state of invalid) {
    assert.throws(() => validateState(state), error => error instanceof EngineError && error.status === 400);
  }
  assert.throws(() => buildQuery('invalid-level', game, 'impossible'), EngineError);
  for (const seconds of [0, -1, 61, NaN, '1']) assert.throws(() => buildQuery('invalid-time', game, 'balanced', seconds), EngineError);
});

test('backend replays moves rather than trusting a forged board or game-over flag', () => {
  const game = createGame(9);
  const played = playMove(game, 0).state;
  const changedBoard = played.board.slice();
  changedBoard[1] = 2;
  assert.throws(() => validateState({ ...played, board: changedBoard }), /棋盘与棋谱不一致/);
  assert.throws(() => validateState({ ...game, moves: [{ index: 0, player: 1 }, { index: 0, player: 2 }] }), /非法落子/);
  const suicideHistory = [70, 1, 71, 9, 72, 11, 73, 19, 10].map((index, move) => ({ index, player: move % 2 + 1 }));
  assert.throws(() => validateState({ ...game, moves: suicideHistory, toPlay: 2 }), /非法落子/);
  const ended = playMove(playMove(game, -1).state, -1).state;
  assert.throws(() => validateState({ ...ended, over: false }), /对局已经结束/);
});

test('KataGo JSON parser ignores intermediate results and converts the final principal variation', async () => {
  const engine = new KataGoEngine();
  const response = new Promise((resolve, reject) => {
    engine.pending.set('parser-test', { resolve, reject, size: 9, player: 2, started: performance.now() });
  });
  const rootInfo = { winrate: 0.63, scoreLead: 2.5, visits: 123 };
  const moveInfos = [
    { move: 'A9', order: 1, visits: 23, winrate: 0.55, scoreLead: 1, pv: ['A9', 'B8'] },
    { move: 'E5', order: 0, visits: 100, winrate: 0.63, scoreLead: 2.5, pv: ['E5', 'D5'] },
  ];
  engine.receiveLine(JSON.stringify({ id: 'parser-test', isDuringSearch: true, rootInfo, moveInfos }));
  assert.equal(engine.pending.has('parser-test'), true);
  engine.receiveLine(JSON.stringify({ id: 'parser-test', rootInfo, moveInfos, ownership: new Array(81).fill(0) }));
  const result = await response;
  assert.equal(result.index, 40);
  assert.equal(result.player, 2);
  assert.equal(result.winrate, 0.63);
  assert.equal(result.scoreLead, 2.5);
  assert.equal(result.visits, 123);
  assert.deepEqual(result.pv, ['E5', 'D5']);
  assert.equal(result.ownership.length, 81);
  assert.equal(engine.pending.size, 0);
  engine.close();
});

test('an unavailable custom engine reports actionable status without spawning a process', () => {
  const engine = new KataGoEngine({
    root: fileURLToPath(new URL('../tests/not-installed/', import.meta.url)),
    executable: 'does-not-exist-katago-for-test',
    modelPath: 'does-not-exist-model-for-test',
    configPath: 'does-not-exist-config-for-test',
  });
  const status = engine.status();
  assert.equal(status.installed, false);
  assert.equal(status.ready, false);
  assert.equal(status.engine, 'KataGo');
  assert.equal(typeof status.error, 'string');
  assert.match(status.error, /npm run setup/);
  assert.throws(() => engine.analyze(createGame(9)), EngineError);
  assert.equal(engine.child, null);
  engine.close();
});
