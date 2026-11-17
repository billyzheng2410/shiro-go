/** Opt-in GPU integration: node tests/real-ranks.mjs. Requires both model files. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createGame, playMove } from '../dist/engine.js';
import { KataGoEngine, gtpToIndex } from '../katago.mjs';

const engine = new KataGoEngine();
const policies = [];
const receive = engine.receiveLine.bind(engine);
engine.receiveLine = line => {
  try {
    const result = JSON.parse(line);
    if (!result.isDuringSearch && Array.isArray(result.humanPolicy)) policies.push(result.humanPolicy);
  } catch { /* Normal adapter parsing will handle non-JSON log lines. */ }
  receive(line);
};

function after(size, moves) {
  let state = createGame(size);
  for (const vertex of moves) {
    const move = playMove(state, gtpToIndex(vertex, size));
    assert.ok(move.ok, vertex);
    state = move.state;
  }
  return state;
}

function validateResult(state, result) {
  assert.ok(playMove(state, result.index).ok, 'recommendation must pass independent Go legality checking');
  assert.ok(Number.isFinite(result.winrate) && result.winrate >= 0 && result.winrate <= 1);
  assert.ok(Number.isFinite(result.scoreLead));
  assert.ok(result.visits > 0);
  assert.equal(result.pv[0].toLowerCase(), result.move.toLowerCase(), 'PV must start with the actually selected move');
}

const summaries = [];
try {
  assert.ok(engine.status().ranksAvailable, 'Install the actual HumanSL model before this test.');
  const state = after(19, ['D16', 'Q4', 'D4', 'Q16', 'C14', 'R6']);
  for (const rank of ['20k', '3d', '9d']) {
    console.log(`Testing actual HumanSL ${rank} on a nonempty 19x19 position...`);
    const result = await engine.analyze(state, 'balanced', undefined, { rank, purpose: 'play' });
    validateResult(state, result);
    assert.equal(result.opponentRank, rank);
    assert.equal(result.humanSLProfile, `rank_${rank}`);
    assert.equal(result.selectionMethod, 'human-policy');
    assert.equal(result.rankExperimental, false);
    summaries.push({ rank, move: result.move, visits: result.visits, elapsedMs: result.elapsedMs });
  }
  assert.equal(policies.length, 3);
  const distances = [];
  for (let a = 0; a < policies.length; a++) for (let b = a + 1; b < policies.length; b++) {
    const distance = policies[a].reduce((sum, value, i) => sum + Math.abs(value - policies[b][i]), 0);
    assert.ok(distance > 1e-6, 'distinct rank profiles must produce distinct actual policy distributions');
    distances.push({ profiles: [['20k', '3d', '9d'][a], ['20k', '3d', '9d'][b]], policyL1Distance: Number(distance.toFixed(6)) });
  }
  const small = after(9, ['E5', 'C3', 'G7', 'C7']);
  const experimental = await engine.analyze(small, 'balanced', undefined, { rank: '3d', purpose: 'play' });
  validateResult(small, experimental);
  assert.equal(experimental.rankExperimental, true);
  assert.equal(experimental.selectionMethod, 'human-policy');
  summaries.push({ rank: '3d', board: 9, move: experimental.move, visits: experimental.visits, elapsedMs: experimental.elapsedMs });

  const hint = await engine.analyze(state, 'fast', 0.5, { rank: '20k', purpose: 'analyze' });
  validateResult(state, hint);
  assert.equal(hint.opponentRank, 'max');
  assert.equal(hint.selectionMethod, 'search');
  assert.equal(hint.humanSLProfile, null);

  const warmChild = engine.child;
  const controller = new AbortController();
  const stopped = engine.analyze(state, 'max', undefined, { rank: 'max', purpose: 'analyze', signal: controller.signal });
  const rejection = assert.rejects(stopped, error => error.name === 'AbortError');
  const timer = setTimeout(() => controller.abort(), 200);
  await rejection;
  clearTimeout(timer);
  assert.equal(engine.pending.size, 0);
  assert.equal(engine.child, warmChild, 'cancel must retain the warm neural model process');
  const resumed = await engine.analyze(state, 'fast', 0.5, { rank: 'max', purpose: 'analyze' });
  validateResult(state, resumed);
  assert.equal(engine.child, warmChild);
  assert.equal(engine.pending.size, 0);
  const report = { testedAt: new Date().toISOString(), runtimeDirectory: engine.engineCwd, searches: summaries, policyDistances: distances, fullStrengthHint: hint.move, resumedAfterCancel: resumed.move, pendingAfterCancelAndResume: engine.pending.size, reusedWarmProcess: engine.child === warmChild };
  const outputOption = process.argv.indexOf('--output');
  if (outputOption !== -1) {
    assert.ok(process.argv[outputOption + 1], '--output requires a file path');
    const output = resolve(process.argv[outputOption + 1]);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS: real HumanSL profiles, different policy distributions, experimental small board, full-strength hints, cancellation and warm-process reuse.');
} catch (error) {
  console.error(error.stack ?? error);
  console.error(engine.logs.slice(-6000));
  process.exitCode = 1;
} finally {
  engine.close();
}
