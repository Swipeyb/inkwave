// Market data: discover fresh Solana launches and read prices (DexScreener + GeckoTerminal public APIs).
import { bestPairs } from './core.js';

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';

async function getJSON(fetchFn, url) {
  const r = await fetchFn(url, { headers: { accept: 'application/json', 'user-agent': 'draftpump/1.0' } });
  if (!r.ok) throw new Error(`${url.split('?')[0]} → HTTP ${r.status}`);
  return r.json();
}

const isMint = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** Candidate mints from several "new / hot on Solana" feeds. One feed failing never stops the others. */
export async function discover(fetchFn = fetch) {
  const mints = new Set();
  const jobs = [
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
  return { mints: [...mints], errors };
}

/** Current market data for up to any number of mints (DexScreener allows 30 per call). Map mint → coin. */
export async function quotes(mints, fetchFn = fetch) {
  const out = new Map();
  const list = [...new Set(mints)].filter(isMint);
  const batches = [];
  for (let i = 0; i < list.length; i += 30) batches.push(list.slice(i, i + 30));
  // a few at a time: DexScreener allows ~300 requests / minute
  for (let i = 0; i < batches.length; i += 4) {
    const res = await Promise.allSettled(batches.slice(i, i + 4).map((b) => getJSON(fetchFn, `${DS}/tokens/v1/solana/${b.join(',')}`)));
    for (const r of res) if (r.status === 'fulfilled') for (const [k, v] of bestPairs(Array.isArray(r.value) ? r.value : r.value?.pairs)) out.set(k, v);
  }
  return out;
}
