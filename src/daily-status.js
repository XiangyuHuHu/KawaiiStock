// Completion is independent of file dates and independent of financial outcomes.
// A fresh report can still contain stale inputs or failed downstream steps.
// 必选：叙事日报、模拟结算、Grok 推荐、核验文件。其余辅助步骤失败只记 warnings，不让每日任务失败。
const REQUIRED = { narrative: '叙事日报', sim: '模拟结算' };
const OPTIONAL = { tradable: '今日买卖', posters: '价位图', options: '期权扫描', oracle: '算卦', watchlist: '美股观察', watchlistCn: 'A股观察', brief: 'Agentic意见', risk: '风控读取', events: '事件日历', guards: '止损检查', paper: '纸上实验' };

export function summarizeDailyJob(payload) {
  const errors = [], warnings = [];
  const check = (stages, required) => {
    for (const [key, label] of Object.entries(stages)) {
      const step = payload[key];
      const error = Array.isArray(step?.error) ? step.error.join('；') : step?.error;
      if (!step || step.ok === false || error) {
        const reason = error || '未完成或没有返回结果';
        if (required) errors.push({ step: key, label, reason });
        else warnings.push(`${label}未完成：${reason}`);
      } else if (step.stale) warnings.push(`${label}使用了过期数据`);
    }
  };
  check(REQUIRED, true);
  check(OPTIONAL, false);
  if (!payload.recommendations?.grok || payload.recommendations.grokError) errors.push({ step: 'grokRecommendation', label: 'Grok推荐', reason: payload.recommendations?.grokError || '未生成' });
  if (payload.calendarWarning) warnings.push(payload.calendarWarning);
  if (!payload.recommendations?.chatgpt) warnings.push(`ChatGPT推荐未生成：${payload.recommendations?.chatgptNote || '今日仅 Grok'}`);
  if (payload.verify?.complete !== true) errors.push({ step: 'files', label: '输出文件', reason: payload.verify?.missing?.join('；') || '未完成文件核验' });
  for (const [account, book] of Object.entries(payload.holdings || {})) {
    if (book.stale || book.ok === false) warnings.push(`${account} 持仓缺少最新可靠扫描`);
  }
  return { ok: errors.length === 0, status: errors.length ? 'partial' : warnings.length ? 'completed_with_warnings' : 'complete', errors, warnings };
}
