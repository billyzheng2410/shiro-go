/**
 * Opt-in integration test. Requires the downloaded KataGo executable and model.
 * Run from go-ai with: node tests/real-katago.mjs
 * The first run can spend several minutes tuning the GPU. Nothing is downloaded
 * or installed by this test; its engine subprocess is always closed afterward.
 */
import assert from 'node:assert/strict';
import { createGame, playMove } from '../dist/engine.js';
import { KataGoEngine, indexToGtp, validateState } from '../katago.mjs';

const engine = new KataGoEngine();
const results = [];

async function checkPosition(state, label) {
  validateState(state);
  const before = JSON.stringify(state);
  console.log(`Analyzing ${label}; the first request includes local model initialization...`);
  const result = await engine.analyze(state, 'fast', 0.5);
  assert.equal(result.engine, 'KataGo');
  assert.equal(result.player, state.toPlay);
  assert.ok(Number.isFinite(result.winrate) && result.winrate >= 0 && result.winrate <= 1, 'winrate must be a finite probability');
  assert.ok(Number.isFinite(result.scoreLead), 'scoreLead must be finite');
  assert.ok(Number.isInteger(result.visits) && result.visits > 0, 'the actual neural search must visit positions');
  assert.ok(playMove(state, result.index).ok, 'the KataGo recommendation must be legal under the UI rules');
  assert.equal(JSON.stringify(state), before, 'analysis must leave the input position unchanged');
  assert.equal(engine.status().ready, true);
  const summary = { position: label, move: indexToGtp(result.index, state.size), visits: result.visits, winrate: Number(result.winrate.toFixed(4)), scoreLead: Number(result.scoreLead.toFixed(2)), elapsedMs: result.elapsedMs };
  results.push(summary);
  console.log(JSON.stringify(summary));
}

try {
  assert.ok(engine.status().installed, 'KataGo is not installed. Run npm run setup first.');
  for (const size of [9, 13, 19]) {
    const initial = createGame(size, 7.5);
    await checkPosition(initial, `${size}x${size} black`);
    const center = Math.floor(size / 2) * size + Math.floor(size / 2);
    const opening = playMove(initial, center);
    assert.ok(opening.ok);
    await checkPosition(opening.state, `${size}x${size} white after opening`);
  }
  const opening = playMove(createGame(9, 7.5), 40).state;
  const passed = playMove(opening, -1).state;
  await checkPosition(passed, '9x9 black after white pass');
  console.log(`PASS: ${results.length} actual KataGo searches on one persistent process, both seats, all board sizes, and pass replay.`);
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  engine.close();
}
