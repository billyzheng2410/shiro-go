import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY, translateText } from '../dist/i18n.js';

test('English translations cover static copy and scoring values without changing Chinese sources', () => {
  for (const [source, target] of Object.entries(COPY)) {
    assert.equal(translateText(source, 'zh'), source);
    assert.equal(translateText(source, 'en'), target);
  }
  const dynamic = ['AI 预计：黑棋领先 7.5 目', '白棋盘面多 2.5 目', '标记死子：黑 3，白 2', '黑棋：23 子 + 14 空；白棋：20 子 + 12 空 + 7.5 贴目。中立点 12。', '轮到白棋 · 自由摆谱', 'KataGo · 9段（近似）', 'B8 · 黑棋 · 死子'];
  for (const source of dynamic) assert.doesNotMatch(translateText(source), /[\u4e00-\u9fff]/, source);
  assert.equal(translateText('  AI 数子  '), '  AI score  ');
});
