import { selectAIMove } from './engine.js';

self.onmessage = event => {
  const { id, state, level, timeLimitMs } = event.data;
  try {
    self.postMessage({ id, ...selectAIMove(state, { level, timeLimitMs }) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
