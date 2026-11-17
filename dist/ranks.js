/** HumanSL profiles describe approximate KGS-like play, not certified ranks. */
export const DEFAULT_RANK = 'max';

const humanRanks = [
  ...Array.from({ length: 20 }, (_, i) => `${20 - i}k`),
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}d`),
];

export const RANKS = Object.freeze([
  Object.freeze({ id: 'max', label: '最强 · KataGo', description: '使用完整 KataGo 搜索，发挥当前硬件与思考时间允许的棋力。' }),
  ...humanRanks.map(id => Object.freeze({
    id,
    label: `${Number.parseInt(id)}${id.endsWith('k') ? '级' : '段'}（近似）`,
    description: `模仿 KGS ${id} 棋手的落子分布；为近似段级位风格，不是认证棋力。`,
    profile: `rank_${id}`,
  })),
]);

export function getRank(id = DEFAULT_RANK) {
  return RANKS.find(rank => rank.id === id);
}
