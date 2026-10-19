/** 八本纸上账的会话、宇宙和是否还会被挡在成交外面。给日报和测试用，不发单。 */
export function paperDeskAudit() {
  return [
    {
      id: '0a',
      market: 'us',
      session: '美东 9:30–16:00',
      universe: '当日主账户推荐和机会',
      auto: '每日任务、paper:daemon、POST /api/paper/auto',
      status: '可跑',
      note: '推荐缺失时只处理已有仓的止损和止盈，不开新仓。'
    },
    {
      id: '0b',
      market: 'us',
      session: '美东 9:30–16:00',
      universe: '当日进攻推荐和机会',
      auto: '每日任务、paper:daemon、POST /api/paper/auto',
      status: '可跑',
      note: '和 0A 一样，没有推荐就不新开。'
    },
    {
      id: '0c',
      market: 'us',
      session: '美东 9:30–16:00',
      universe: 'Agentic / Cycle 推荐',
      auto: '每日任务、paper:daemon、POST /api/paper/auto',
      status: '可跑',
      note: '没有 A 级或追高就空仓，这是策略，不是故障。'
    },
    {
      id: '0d',
      market: 'us',
      session: '美东 9:30–16:00',
      universe: '奇门和卦象的美股名单',
      auto: '每日任务、paper:daemon、POST /api/paper/auto',
      status: '可跑',
      note: '卦象服务失败就跳过新开，已有仓仍按当日方向处理。'
    },
    {
      id: '0e',
      market: 'us',
      session: '美东 9:30–16:00',
      universe: '不再按扫描开新仓',
      auto: '每日任务、paper:daemon、POST /api/paper/auto',
      status: '按设计不开新仓',
      note: '已有合约仍走权利金止损、止盈和到期。研究台关闭不是会话故障。'
    },
    {
      id: '0f',
      market: 'us',
      session: '美东 9:30–16:00',
      universe: '美股清单；清单缺失时回退 public-demo',
      auto: '每日任务、paper:daemon、POST /api/paper/auto',
      status: '可跑',
      note: 'SPY 或 QQQ 在 200 日线下不开新仓。清单缺失时 demo 池仍能跑动量，不会空转成零只股票。'
    },
    {
      id: '0g',
      market: 'cn',
      session: '北京时间 9:30–11:30、13:00–15:00',
      universe: 'lists/cn/小孟中小盘.md，外加本机留下的涨停池快照',
      auto: '每日任务、paper:daemon、POST /api/paper/auto',
      status: '已修',
      note: '原先所有账本都卡在美股时段，A 股开市时这本不跑。自选里的 600519、300750、000001 也不再当宇宙。报价走东财，不送去 Nasdaq。'
    },
    {
      id: '0h',
      market: 'us',
      session: '美东 9:30–16:00',
      universe: '美股清单；不足 8 只或清单缺失时用 lists/us/小孟美股.md',
      auto: '每日任务、paper:daemon、POST /api/paper/auto',
      status: '已修',
      note: '大涨从 8% 放到 5%，总市值从约 $0.7B–$2.8B 放到 $0.5B–$20B，共振从 3 只放到 2 只。盘口和集合竞价缺失记为中性。市值读 Nasdaq summary，不再读已经空掉的 Yahoo chart marketCap。'
    }
  ];
}
