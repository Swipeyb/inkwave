// Market data: discover fresh Solana launches and read prices (DexScreener + GeckoTerminal public APIs).
import { bestPairs } from './core.js';

const DS = 'https://api.dexscreener.com';
// Jupiter's token API: works from Cloudflare (DexScreener / GeckoTerminal rate-limit Cloudflare's shared IPs). With a
// JUP_API_KEY secret it uses the keyed host; without one, the free lite host.
const jupBase = (key) => (key ? 'https://api.jup.ag' : 'https://lite-api.jup.ag');
const jupHeaders = (key) => (key ? { 'x-api-key': key } : {});
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export function fromJupiter(t) {
  if (!t || !t.id) return null;
  const s1 = t.stats1h || {};
  return {
    mint: t.id, name: String(t.name || '').slice(0, 40), symbol: String(t.symbol || '').slice(0, 16),
    price: num(t.usdPrice), liq: num(t.liquidity), mcap: num(t.mcap ?? t.fdv),
    vol1h: num(s1.buyVolume) + num(s1.sellVolume), vol24h: num(t.stats24h?.buyVolume) + num(t.stats24h?.sellVolume),
    chg1h: num(s1.priceChange), chg24h: num(t.stats24h?.priceChange),
    created: Date.parse(t.firstPool?.createdAt || '') || 0,
    image: typeof t.icon === 'string' && /^https:\/\//.test(t.icon) ? t.icon : '',
    url: `https://dexscreener.com/solana/${t.id}`,
  };
}
const GT = 'https://api.geckoterminal.com/api/v2';

async function getJSON(fetchFn, url, headers = {}) {
  const r = await fetchFn(url, { headers: { accept: 'application/json', 'user-agent': 'draftpump/1.0', ...headers } });
  if (!r.ok) throw new Error(`${url.split('?')[0]} → HTTP ${r.status}`);
  return r.json();
}

const isMint = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** Candidate mints from several "new / hot on Solana" feeds. One feed failing never stops the others. */
export async function discover(fetchFn = fetch, key = '') {
  const mints = new Set(), coins = new Map();
  const jup = (path) => getJSON(fetchFn, `${jupBase(key)}${path}`, jupHeaders(key)).then((a) => {
    for (const t of Array.isArray(a) ? a : []) { const c = fromJupiter(t); if (c) { coins.set(c.mint, c); mints.add(c.mint); } }
  });
  const jobs = [
    jup('/tokens/v2/recent'),
    ...['toptrending', 'toptraded', 'toporganicscore'].map((c) => jup(`/tokens/v2/${c}/1h?limit=100`)),
    getJSON(fetchFn, `${DS}/token-profiles/latest/v1`).then((a) => { for (const x of a || []) if (x.chainId === 'solana' && isMint(x.tokenAddress)) mints.add(x.tokenAddress); }),
    getJSON(fetchFn, `${DS}/token-boosts/latest/v1`).then((a) => { for (const x of a || []) if (x.chainId === 'solana' && isMint(x.tokenAddress)) mints.add(x.tokenAddress); }),
    getJSON(fetchFn, `${DS}/token-boosts/top/v1`).then((a) => { for (const x of a || []) if (x.chainId === 'solana' && isMint(x.tokenAddress)) mints.add(x.tokenAddress); }),
    // DexScreener search: fresh pump.fun / PumpSwap pairs
    ...['pump', 'pumpswap', 'solana meme'].map((q) => getJSON(fetchFn, `${DS}/latest/dex/search?q=${encodeURIComponent(q)}`).then((j) => { for (const p of j?.pairs || []) if (p.chainId === 'solana' && isMint(p.baseToken?.address)) mints.add(p.baseToken.address); })),
    ...[1, 2, 3, 4, 5, 6].map((page) => getJSON(fetchFn, `${GT}/networks/solana/new_pools?page=${page}`).then(addGT)),
    ...[1, 2].map((page) => getJSON(fetchFn, `${GT}/networks/solana/dexes/pumpswap/pools?page=${page}&sort=h24_volume_usd_desc`).then(addGT)),
    getJSON(fetchFn, `${GT}/networks/solana/trending_pools?page=1&duration=1h`).then(addGT),
  ];
  function addGT(j) {
    for (const p of j?.data || []) {
      const id = p?.relationships?.base_token?.data?.id || '';
      const m = id.startsWith('solana_') ? id.slice(7) : '';
      if (isMint(m) && m !== 'So11111111111111111111111111111111111111112') mints.add(m);
    }
  }
  const res = await Promise.allSettled(jobs);
  const errors = res.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  return { mints: [...mints], coins, errors };
}

/** Current market data for up to any number of mints (DexScreener allows 30 per call). Map mint → coin. */
export async function quotes(mints, fetchFn = fetch, key = '') {
  const out = new Map();
  const list = [...new Set(mints)].filter(isMint);
  for (let i = 0; i < list.length; i += 100) {
    try {
      const a = await getJSON(fetchFn, `${jupBase(key)}/tokens/v2/search?query=${list.slice(i, i + 100).join(',')}`, jupHeaders(key));
      for (const t of Array.isArray(a) ? a : []) { const c = fromJupiter(t); if (c && list.includes(c.mint)) out.set(c.mint, c); }
    } catch { /* fall back below */ }
  }
  // anything Jupiter didn't answer: DexScreener (30 per call)
  const rest = list.filter((m) => !out.has(m));
  for (let i = 0; i < rest.length; i += 30) {
    try {
      const r = await getJSON(fetchFn, `${DS}/tokens/v1/solana/${rest.slice(i, i + 30).join(',')}`);
      for (const [k, v] of bestPairs(Array.isArray(r) ? r : r?.pairs)) out.set(k, v);
    } catch { /* rate-limited: keep the last prices */ }
  }
  return out;
}
