import { countScore, groupMembers } from './scoring.js';

export function showScore(state, result) {
  const dialog = document.getElementById('score-dialog');
  const board = document.getElementById('score-board');
  const original = new Set(result.scoring.suggestedDead);
  let dead = new Set(original);
  const render = () => {
    const score = countScore(state, [...dead]);
    document.getElementById('score-black').textContent = score.black.toFixed(1);
    document.getElementById('score-white').textContent = score.white.toFixed(1);
    document.getElementById('score-result').textContent = score.blackLead === 0 ? '盘面持平' : `${score.blackLead > 0 ? '黑棋' : '白棋'}盘面多 ${Math.abs(score.blackLead).toFixed(1)} 目`;
    document.getElementById('score-breakdown').textContent = `黑棋：${score.blackStones} 子 + ${score.blackTerritory} 空；白棋：${score.whiteStones} 子 + ${score.whiteTerritory} 空 + ${state.komi} 贴目。中立点 ${score.neutral}。`;
    document.getElementById('score-dead').textContent = `标记死子：黑 ${score.blackDead}，白 ${score.whiteDead}`;
    board.style.setProperty('--board-size', state.size);
    board.replaceChildren(...state.board.map((stone, i) => {
      const point = document.createElement('button');
      point.type = 'button';
      point.className = `score-point ${stone ? stone === 1 ? 'black' : 'white' : 'empty'}${dead.has(i) ? ' dead' : ''}${!stone || dead.has(i) ? score.territory[i] === 1 ? ' black-area' : score.territory[i] === 2 ? ' white-area' : '' : ''}`;
      point.setAttribute('aria-label', `${'ABCDEFGHJKLMNOPQRST'[i % state.size]}${state.size - Math.floor(i / state.size)} · ${stone ? stone === 1 ? '黑棋' : '白棋' : '空点'}${dead.has(i) ? ' · 死子' : ''}`);
      point.disabled = !stone;
      if (stone) point.addEventListener('click', () => {
        const remove = dead.has(i);
        for (const member of groupMembers(state.board, state.size, i)) { if (remove) dead.delete(member); else dead.add(member); }
        render();
      });
      return point;
    }));
  };
  const lead = result.scoring.estimatedBlackLead;
  document.getElementById('score-estimate').textContent = `AI 预计：${lead >= 0 ? '黑棋' : '白棋'}领先 ${Math.abs(lead).toFixed(1)} 目`;
  document.getElementById('score-warning').textContent = result.scoring.requiresReview
    ? '局面仍可能有未定型区域。AI 预计领先与盘面数子可能不同；请核对死活并收完单官，不能直接作为正式终局裁定。'
    : 'AI 已标记可能的死子。请核对双活、劫争与死活；数子结果需要双方确认。';
  document.getElementById('score-reset').onclick = () => { dead = new Set(original); render(); };
  document.getElementById('close-score').onclick = () => dialog.close();
  render();
  if (!dialog.open) dialog.showModal();
}
