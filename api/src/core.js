// DRAFTPUMP game rules: pure functions (no I/O), shared by the server and the tests.

export const TEAM_SIZE = 5;
export const ROUND_MS = 24 * 3600 * 1000;      // a team is scored over the 24 h after it locks in
export const POOL_SIZE = 60;                   // coins offered to a draft room (8 players × 5 picks = 40, plus choice)
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
export function rankPool(coins, now = Date.now(), size = POOL_SIZE) {
  return [...coins].filter((c) => eligible(c, now))
    .sort((a, b) => (b.vol1h + b.liq * 0.2) - (a.vol1h + a.liq * 0.2))
    .slice(0, size);
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

// ---------------------------------------------------------------- draft rooms
export const SEATS = 8;
export const ROUNDS = TEAM_SIZE;
export const ROUND_SEC = 25;                    // seconds per pick round (everyone picks at once)
export const LOBBY_SEC = 30;                    // a room starts this long after its first player joins, or when full
export const MODES = { sprint: { label: '1-hour sprint', ms: 3600e3 }, daily: { label: '24-hour', ms: 24 * 3600e3 } };
export const POINTS = [100, 50, 25];            // room places 1-3 (people only; bots never score points)

/** Priority order of seats for round r: snake (round 1 seat 0 first, round 2 reversed, …), so it evens out. */
export function roundOrder(nSeats, r) {
  const o = Array.from({ length: nSeats }, (_, i) => i);
  return r % 2 === 0 ? o : o.reverse();
}

/**
 * Resolve one simultaneous pick round. `wants[seat]` is the mint that seat asked for (or null). Seats that chose go in
 * priority order; then seats whose coin was taken (sniped) or who didn't pick get the best remaining coin by list rank.
 * Mutates `taken` (mint → seat) and returns [{ seat, mint, wanted, sniped, auto }].
 */
export function resolveRound(nSeats, r, wants, poolOrder, taken) {
  const out = [], order = roundOrder(nSeats, r), later = [];
  // pass 1: everyone who chose a coin, in priority order (an idle seat never takes a coin someone actually asked for)
  for (const seat of order) {
    const w = wants[seat] || null;
    if (w && !taken.has(w) && poolOrder.includes(w)) { taken.set(w, seat); out.push({ seat, mint: w, wanted: w, sniped: false, auto: false }); }
    else later.push({ seat, w });
  }
  // pass 2: sniped and idle seats get the best coin left, still in priority order
  for (const { seat, w } of later) {
    const mint = poolOrder.find((m) => !taken.has(m));
    if (!mint) continue;
    taken.set(mint, seat);
    out.push({ seat, mint, wanted: w, sniped: !!w, auto: !w });
  }
  return out;
}

/** A bot's wish for a round: one of the best few coins still free (a little random, so bots aren't predictable). */
export function botWish(poolOrder, taken, rnd = Math.random) {
  const free = poolOrder.filter((m) => !taken.has(m));
  if (!free.length) return null;
  return free[Math.min(free.length - 1, Math.floor(rnd() * Math.min(8, free.length)))];
}

/** Places in a room: seats sorted by score (ties: lower seat first). Returns [{ seat, score, place }]. */
export function placings(scores) {
  return scores.map((score, seat) => ({ seat, score })).sort((a, b) => b.score - a.score || a.seat - b.seat).map((x, i) => ({ ...x, place: i + 1 }));
}
