import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { createGame, playMove } from '../dist/engine.js';
import { RANKS, DEFAULT_RANK, getRank } from '../dist/ranks.js';
import { buildQuery, sampleHumanMove, resolveRankSelection, readEngineSelection, KataGoEngine, EngineError } from '../katago.mjs';

function policyFor(size, entries) {
  const policy = Array(size * size + 1).fill(0);
  for (const [index, weight] of entries) policy[index === -1 ? size * size : index] = weight;
  return policy;
}

function fakeEngine() {
  const writes = [];
  let killed = false;
  const engine = new KataGoEngine({ random: () => 0.5 });
  const child = { stdin: { write(line, callback) { writes.push(JSON.parse(line)); callback?.(); return true; } }, kill() { killed = true; } };
  engine.start = () => { engine.child = child; engine.ready = true; };
  return { engine, writes, wasKilled: () => killed };
}

function finalResult(id, extra = {}) {
  return { id, isDuringSearch: false, rootInfo: { winrate: 0.6, scoreLead: 1.5, visits: 64 }, moveInfos: [{ move: 'E5', order: 0, visits: 64, pv: ['E5', 'D4'], winrate: 0.6, scoreLead: 1.5 }], ...extra };
}

test('all 30 choices map to official modern HumanSL profiles without certified-rank labels', () => {
  assert.equal(DEFAULT_RANK, 'max');
  assert.equal(RANKS.length, 30);
  assert.equal(new Set(RANKS.map(rank => rank.id)).size, 30);
  assert.equal(getRank('max').profile, undefined);
  for (const id of ['20k', '1k', '1d', '9d']) {
    assert.equal(getRank(id).profile, `rank_${id}`);
    assert.match(getRank(id).label, /近似/);
    assert.match(getRank(id).description, /KGS/);
  }
  assert.equal(getRank('professional-9dan'), undefined);
});

test('rank only controls actual opponent moves; analysis remains full-strength and time independent', () => {
  const state = createGame(19);
  const weak = buildQuery('weak', state, 'max', undefined, { rank: '20k', purpose: 'play' });
  const strong = buildQuery('strong', state, 'max', undefined, { rank: 'max', purpose: 'play' });
  const hint = buildQuery('hint', state, 'max', undefined, { rank: '20k', purpose: 'analyze' });
  assert.equal(weak.includePolicy, true);
  assert.equal(weak.overrideSettings.humanSLProfile, 'rank_20k');
  assert.equal(weak.overrideSettings.ignorePreRootHistory, false);
  assert.ok(weak.maxVisits > 50, 'main-model pass safeguard has enough visits when time permits');
  assert.equal(weak.overrideSettings.maxTime, strong.overrideSettings.maxTime);
  assert.ok(strong.maxVisits >= 1_000_000);
  assert.equal(strong.overrideSettings.humanSLProfile, '');
  assert.equal(strong.includePolicy, undefined);
  assert.deepEqual({ ...hint, id: 'same' }, { ...strong, id: 'same' });
  assert.equal(hint.overrideSettings.rootNoiseEnabled, false);
  assert.equal(hint.overrideSettings.humanSLRootExploreProbWeightful, 0);
  assert.throws(() => resolveRankSelection('fake-rank', 'play'), EngineError);
  assert.throws(() => resolveRankSelection('5k', 'unknown'), EngineError);
});

test('HumanSL uses probability sampling rather than selecting only the most likely move', () => {
  const state = createGame(9);
  const policy = policyFor(9, [[0, 0.25], [40, 0.75]]);
  assert.equal(sampleHumanMove(state, policy, { random: () => 0.1 }), 0);
  assert.equal(sampleHumanMove(state, policy, { random: () => 0.9 }), 40);
  let seed = 0x12345678;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
  let first = 0;
  for (let i = 0; i < 4000; i++) if (sampleHumanMove(state, policy, { random }) === 0) first++;
  assert.ok(Math.abs(first / 4000 - 0.25) < 0.03, `sample frequency was ${first / 4000}`);
});

test('HumanSL sampling conditions on actual legality, including superko, and suppresses early passes', () => {
  let state = createGame(9);
  for (const index of [1, 10, 9, 2, 19, 20, 80, 12, 11]) {
    const move = playMove(state, index); assert.ok(move.ok); state = move.state;
  }
  assert.equal(playMove(state, 10).ok, false, 'immediate ko recapture is illegal');
  const policy = policyFor(9, [[10, 100], [1, 100], [-1, 100], [4, 1]]);
  assert.equal(sampleHumanMove(state, policy, { random: () => 0.999 }), 4);
  assert.equal(sampleHumanMove(state, policy, { random: () => 0.999, allowPass: true }), -1);
  assert.throws(() => sampleHumanMove(state, policyFor(9, [[10, 1], [-1, 1]])), /没有可用/);
  assert.throws(() => sampleHumanMove(state, []), /有效/);
});

test('a sampled move gets its own PV and keeps the strong main-model evaluation', async () => {
  const { engine, writes } = fakeEngine();
  const promise = engine.analyze(createGame(9), 'max', undefined, { rank: '5k', purpose: 'play' });
  engine.receiveLine(JSON.stringify(finalResult(writes[0].id, { humanPolicy: policyFor(9, [[0, 1]]) })));
  const result = await promise;
  assert.equal(result.index, 0);
  assert.deepEqual(result.pv, ['A9']);
  assert.deepEqual(result.analysisPv, ['E5', 'D4']);
  assert.equal(result.analysisMove, 'E5');
  assert.equal(result.winrate, 0.6);
  assert.equal(result.scoreLead, 1.5);
  assert.equal(result.opponentRank, '5k');
  assert.equal(result.selectionMethod, 'human-policy');
  assert.equal(result.rankExperimental, true);
  engine.close();
});

test('when pass is the only legal action, a missing searched candidate cannot stall the game', async () => {
  let state = createGame(9);
  const blackPoints = Array.from({ length: 81 }, (_, i) => i).filter(i => i !== 0 && i !== 80);
  for (let i = 0; i < blackPoints.length; i++) {
    const black = playMove(state, blackPoints[i]); assert.ok(black.ok); state = black.state;
    if (i < blackPoints.length - 1) state = playMove(state, -1).state;
  }
  assert.equal(state.toPlay, 2);
  assert.equal(sampleHumanMove(state, []), -1);
  const { engine, writes } = fakeEngine();
  const promise = engine.analyze(state, 'balanced', undefined, { rank: '20k', purpose: 'play' });
  engine.receiveLine(JSON.stringify(finalResult(writes[0].id, { moveInfos: [] })));
  assert.equal((await promise).index, -1);
  assert.equal(engine.pending.size, 0);
  engine.close();
});

test('HumanSL passes only when the main search recommends it and never silently substitutes a missing policy', async () => {
  const { engine, writes } = fakeEngine();
  const passing = engine.analyze(createGame(9), 'balanced', undefined, { rank: '20k', purpose: 'play' });
  engine.receiveLine(JSON.stringify(finalResult(writes[0].id, { moveInfos: [{ move: 'pass', order: 0, visits: 64, pv: ['pass'] }], humanPolicy: policyFor(9, [[0, 1]]) })));
  assert.equal((await passing).index, -1);
  const missing = engine.analyze(createGame(9), 'balanced', undefined, { rank: '20k', purpose: 'play' });
  engine.receiveLine(JSON.stringify(finalResult(writes[1].id)));
  await assert.rejects(missing, /HumanSL/);
  assert.equal(engine.pending.size, 0);
  engine.close();
});

test('AbortSignal terminates only its own query and leaves the warm engine and other requests alive', async () => {
  const { engine, writes, wasKilled } = fakeEngine();
  const controller = new AbortController();
  const first = engine.analyze(createGame(9), 'max', undefined, { signal: controller.signal });
  const second = engine.analyze(createGame(9), 'max');
  const firstId = writes[0].id;
  assert.equal(writes.length, 1, 'the second search waits in the application queue');
  const rejection = assert.rejects(first, error => error.name === 'AbortError');
  controller.abort();
  await rejection;
  assert.equal(writes[1].action, 'terminate');
  assert.equal(writes[1].terminateId, firstId);
  const secondId = writes[2].id;
  assert.equal(engine.pending.has(firstId), false);
  assert.equal(engine.pending.has(secondId), true);
  assert.equal(wasKilled(), false);
  engine.receiveLine(JSON.stringify(finalResult(firstId)));
  assert.equal(engine.pending.has(secondId), true, 'late canceled output is ignored');
  engine.receiveLine(JSON.stringify(finalResult(secondId)));
  assert.equal((await second).selectionMethod, 'search');
  assert.equal(engine.pending.size, 0);
  assert.equal(wasKilled(), false);
  engine.close();
});

test('a short queued search only starts its clock on dispatch and times out independently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, writes, wasKilled } = fakeEngine();
  engine.ready = true;
  t.after(() => engine.close());
  const long = engine.analyze(createGame(9), 'extended');
  const short = engine.analyze(createGame(9), 'fast', 0.1);
  const firstId = writes[0].id;
  assert.equal(writes.length, 1);
  t.mock.timers.tick(45_000);
  assert.equal(engine.pending.size, 2);
  assert.equal(wasKilled(), false);
  engine.receiveLine(JSON.stringify(finalResult(firstId)));
  await long;
  const secondId = writes[1].id;
  const rejection = assert.rejects(short, /超时/);
  t.mock.timers.tick(30_101);
  await rejection;
  assert.equal(writes[2].terminateId, secondId);
  assert.equal(wasKilled(), false);
  const next = engine.analyze(createGame(9), 'fast');
  engine.receiveLine(JSON.stringify(finalResult(writes[3].id)));
  assert.equal((await next).selectionMethod, 'search');
});

test('an already-aborted request never starts an engine process', async () => {
  const engine = new KataGoEngine();
  let started = false;
  engine.start = () => { started = true; };
  const signal = AbortSignal.abort();
  await assert.rejects(engine.analyze(createGame(9), 'max', undefined, { signal }), error => error.name === 'AbortError');
  assert.equal(started, false);
  assert.equal(engine.pending.size, 0);
  engine.close();
});

test('active engine paths support isolated relative runtimes and explicit external absolute model paths', () => {
  const taskTmpRoot = mkdtempSync(join(tmpdir(), 'shiro-selector-'));
  try {
    const engineDir = join(taskTmpRoot, 'engine');
    mkdirSync(engineDir);
    const candidateDir = join(taskTmpRoot, 'engine-cuda');
    mkdirSync(candidateDir);
    const selector = { executable: '../engine-cuda/katago.exe', config: '../engine-cuda/analysis.cfg', backend: 'cuda', version: 'v1.18.2', modelName: 'verified-model', searchThreads: 8, batchSize: 8 };
    writeFileSync(join(engineDir, 'active.json'), JSON.stringify(selector));
    let selection = readEngineSelection(taskTmpRoot);
    assert.equal(selection.executable, resolve(candidateDir, 'katago.exe'));
    assert.equal(selection.model, resolve(engineDir, 'model.bin.gz'));
    assert.equal(selection.humanModel, resolve(engineDir, 'human-model.bin.gz'));
    const externalModel = resolve(tmpdir(), 'explicit-model.bin.gz');
    writeFileSync(join(engineDir, 'active.json'), JSON.stringify({ ...selector, model: externalModel, humanModel: resolve(tmpdir(), 'explicit-human.bin.gz') }));
    selection = readEngineSelection(taskTmpRoot);
    assert.equal(selection.model, externalModel);
    assert.equal(selection.humanModel, resolve(tmpdir(), 'explicit-human.bin.gz'));
    const selected = new KataGoEngine({ root: taskTmpRoot });
    assert.equal(selected.status().backend, 'cuda');
    assert.equal(selected.status().model, 'verified-model');
    assert.equal(selected.status().searchThreads, 8);
    assert.equal(selected.engineCwd, candidateDir);
    selected.close();
    writeFileSync(join(engineDir, 'active.json'), JSON.stringify({ ...selector, executable: '../../outside.exe' }));
    assert.throws(() => readEngineSelection(taskTmpRoot), /绝对路径/);
    writeFileSync(join(engineDir, 'active.json'), '{invalid');
    const invalid = new KataGoEngine({ root: taskTmpRoot });
    assert.match(invalid.status().error, /active.json/);
    assert.throws(() => invalid.start(), /active.json/);
    invalid.close();
  } finally {
    const actual = resolve(taskTmpRoot);
    assert.ok(actual.startsWith(resolve(tmpdir()) + sep) && basename(actual).startsWith('shiro-selector-'));
    rmSync(actual, { recursive: true, force: true });
  }
});
