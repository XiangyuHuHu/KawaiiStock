import { evaluateCov } from './cov.js';

const STRATEGIES = [
  {
    id: 'cov',
    name: 'COV 波动一致性',
    summary: '波形重复 + 波动扩张 + 期权 EV。方向对不等于 Call 赚钱。',
    evaluate: evaluateCov
  }
];

export function listStrategies() {
  return STRATEGIES.map(({ evaluate, ...rest }) => rest);
}

export function getStrategy(id) {
  const key = String(id || 'cov').toLowerCase();
  return STRATEGIES.find((row) => row.id === key) || STRATEGIES[0];
}
