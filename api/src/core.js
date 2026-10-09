// DRAFTPUMP game rules: pure functions (no I/O), shared by the server and the tests.

export const TEAM_SIZE = 5;
export const ROUND_MS = 24 * 3600 * 1000;      // a team is scored over the 24 h after it locks in
export const POOL_SIZE = 40;                   // coins offered in the draft at any moment
export const MAX_GAIN = 5000;                  // one coin can add at most +5000 % (a single moonshot can't decide everything)

// draftable: launched 20 min – 24 h ago, real liquidity and trading, a price
export const RULES = { minAgeMs: 20 * 60 * 1000, maxAgeMs: 24 * 3600 * 1000, minLiq: 8000, minVol1h: 3000, deadLiq: 300 };

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** DexScreener pairs → one entry per token (its deepest-liquidity pair). */
export function bestPairs(pairs) {
  const out = new Map();
  for (const p of pairs || []) {
    if (!p || p.chainId !== 'solana' || !p.baseToken?.address) continue;
    const mint = p.baseToken.address;
    const c = {
      mint,
      name: String(p.baseToken.name || '').slice(0, 40),
      symbol: String(p.baseToken.symbol || '').slice(0, 16),
      price: num(p.priceUsd),
      liq: num(p.liquidity?.usd),
      mcap: num(p.marketCap ?? p.fdv),
      vol1h: num(p.volume?.h1),
      vol24h: num(p.volume?.h24),
      chg1h: num(p.priceChange?.h1),
      chg24h: num(p.priceChange?.h24),
      created: num(p.pairCreatedAt),
      image: typeof p.info?.imageUrl === 'string' ? p.info.imageUrl : '',
      url: typeof p.url === 'string' ? p.url : `https://dexscreener.com/solana/${mint}`,
    };
    const prev = out.get(mint);
    if (!prev || c.liq > prev.liq) out.set(mint, { ...c, created: prev ? Math.min(prev.created || c.created, c.created || prev.created) : c.created });
  }
  return out;
}

export function eligible(c, now = Date.now()) {
  if (!c || !(c.price > 0) || !c.created) return false;
  const age = now - c.created;
  return age >= RULES.minAgeMs && age <= RULES.maxAgeMs && c.liq >= RULES.minLiq && c.vol1h >= RULES.minVol1h;
}

/** Rank the draft pool: busiest trading first (1 h volume, a little boost for liquidity). */
export function rankPool(coins, now = Date.now()) {
  return [...coins].filter((c) => eligible(c, now))
    .sort((a, b) => (b.vol1h + b.liq * 0.2) - (a.vol1h + a.liq * 0.2))
    .slice(0, POOL_SIZE);
}

/** % change of one pick, clamped to [-100, MAX_GAIN]. A coin whose liquidity is gone counts as -100 %. */
export function pickScore(start, cur, dead = false) {
  if (dead) return -100;
  if (!(start > 0) || !(cur >= 0)) return 0;
  return Math.max(-100, Math.min(MAX_GAIN, (cur / start - 1) * 100));
}

/** A team's score: the average of its picks' % changes, rounded to 0.1. */
export function teamScore(picks) {
  if (!picks.length) return 0;
  const s = picks.reduce((t, p) => t + pickScore(p.start, p.cur, p.dead), 0) / picks.length;
  return Math.round(s * 10) / 10;
}

export const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

/** Nicknames: 3–16 letters, digits or underscore. */
export function cleanName(s) {
  const n = String(s || '').trim();
  return /^[A-Za-z0-9_]{3,16}$/.test(n) ? n : null;
}

const BAD = /(nigg|fag|retard|kike|hitler|nazi)/i;
export const nameAllowed = (n) => !!n && !BAD.test(n);

/** Draft validation: exactly TEAM_SIZE distinct mints, all from the current pool. Returns an error string or null. */
export function draftError(mints, poolSet) {
  if (!Array.isArray(mints) || mints.length !== TEAM_SIZE) return `Pick exactly ${TEAM_SIZE} coins`;
  if (new Set(mints).size !== TEAM_SIZE) return 'Each coin only once';
  for (const m of mints) if (!poolSet.has(m)) return 'One of your coins left the draft list — pick again';
  return null;
}
