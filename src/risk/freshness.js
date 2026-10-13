const DEFAULTS = {
  quoteMaxAgeSec: 180,
  chainMaxAgeSec: 900,
  intraMaxAgeSec: 1800
};

function ageSec(ts, now) {
  if (ts == null) return null;
  const n = typeof ts === 'string' && !/^\d+(\.\d+)?$/.test(ts) ? Date.parse(ts) : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  if (ms > now + 5000) return null;
  return Math.max(0, (now - ms) / 1000);
}

function field(name, { present, age, maxAge, required = false }) {
  let status = 'ok';
  if (!present) status = required ? 'missing' : 'absent';
  else if (age == null || !Number.isFinite(age) || age < 0) status = required ? 'missing' : 'absent';
  else if (age != null && maxAge != null && age > maxAge) status = 'stale';
  return { name, present: Boolean(present), ageSec: Number.isFinite(age) ? Number(age.toFixed(1)) : null, maxAgeSec: maxAge ?? null, status };
}

/** 判断报价 / K 线 / 期权链是否够新鲜。缺字段或过期都算不新鲜。 */
export function evaluateFreshness(input = {}, now = Date.now()) {
  const quoteMax = input.quoteMaxAgeSec ?? DEFAULTS.quoteMaxAgeSec;
  const chainMax = input.chainMaxAgeSec ?? DEFAULTS.chainMaxAgeSec;
  const intraMax = input.intraMaxAgeSec ?? DEFAULTS.intraMaxAgeSec;

  const quoteAge = input.quoteAgeSec ?? ageSec(input.quoteAt, now);
  const chainAge = input.chainAgeSec ?? ageSec(input.chainAt, now);
  const intraAge = input.intraAgeSec ?? ageSec(input.intraLastTs, now);

  const quotePresent = input.hasQuote !== false && (input.quoteAt != null || input.fetchedAt != null || input.quoteAgeSec != null || input.last != null);
  const quoteTimed = input.quoteAt != null || input.fetchedAt != null || input.quoteAgeSec != null;
  const fields = [
    field('quote', {
      present: quotePresent && (quoteTimed || input.allowUntimed === true),
      age: quoteAge,
      maxAge: quoteMax,
      required: input.requireQuote !== false
    }),
    field('intraday', {
      present: input.hasIntra !== false && (input.intraLastTs != null || (input.intraBars ?? 0) > 0),
      age: intraAge,
      maxAge: intraMax,
      required: Boolean(input.requireIntra)
    }),
    field('chain', {
      present: input.hasChain !== false && (input.chainOk || input.chainAt != null),
      age: chainAge,
      maxAge: chainMax,
      required: Boolean(input.requireChain)
    })
  ];

  if (input.errors) {
    for (const [name, error] of Object.entries(input.errors)) {
      if (error) fields.push({ name, present: false, ageSec: null, maxAgeSec: null, status: 'missing', error });
    }
  }

  const missing = fields.filter((row) => row.status === 'missing');
  const stale = fields.filter((row) => row.status === 'stale');
  const fresh = missing.length === 0 && stale.length === 0;
  const worst = missing[0] || stale[0] || null;
  const label = !fresh
    ? (missing.length
      ? `缺 ${missing.map((row) => row.name).join(' / ')}`
      : `${stale.map((row) => row.name).join(' / ')} 过期`)
    : '新鲜';

  return {
    fresh,
    stale: stale.length > 0,
    missing: missing.length > 0,
    ageSec: quoteAge ?? chainAge ?? intraAge,
    label,
    worst: worst?.name || null,
    fields
  };
}

export function freshnessFromContext(ctx = {}, now = Date.now()) {
  const intra = ctx.intra || [];
  const lastBar = intra.at(-1);
  return evaluateFreshness({
    last: ctx.last,
    fetchedAt: ctx.fetchedAt,
    quoteAt: ctx.quoteAt,
    intraLastTs: lastBar?.ts || null,
    intraBars: intra.length,
    hasIntra: intra.length > 0,
    hasChain: Boolean(ctx.chain?.ok),
    chainOk: Boolean(ctx.chain?.ok),
    chainAt: ctx.chain?.quoteAt,
    requireQuote: true,
    requireIntra: true,
    requireChain: true,
    errors: ctx.errors
  }, now);
}
