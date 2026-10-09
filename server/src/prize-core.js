// Prize pool rules — pure functions, no I/O (unit-tested in server/test/prize-core.test.mjs).
//
// Each online match is a "round". At match start the ledger draws a 32-byte random seed and publishes only
// commit = sha256(seedHex). At the end it reveals seedHex; everything random is derived from it, so anyone can check
// that the amount and the recipient follow from a seed fixed before the result was known:
//   u      = first 8 bytes of sha256(`${seedHex}:amount`) as a big-endian integer / 2^64     (uniform in [0, 1))
//   pct    = PRIZE_MIN_PCT + u · (PRIZE_MAX_PCT − PRIZE_MIN_PCT)
//   prize  = min(floor(pool · pct / 100), PRIZE_MAX_SOL, pool − PRIZE_RESERVE_SOL − fee)   (0 if < MIN_PRIZE)
//   winner = candidates sorted by wallet address [ first 8 bytes of sha256(`${seedHex}:winner`) mod n ]
import { sha256Hex, parsePubkey, LAMPORTS_PER_SOL } from './solana.js';

export const TX_FEE_LAMPORTS = 5000;
// a transfer that leaves a brand-new recipient account below the rent-exempt minimum (~0.00089 SOL) is rejected by
// the chain, so prizes below 0.001 SOL are skipped
export const MIN_PRIZE_LAMPORTS = 1_000_000;

const num = (v, d) => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? d : n; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Read the prize configuration from the Worker env. The feature is OFF unless both SOLANA_RPC_URL and
 * TREASURY_PUBLIC_KEY are set; payouts are dry-run unless PAYOUT_MODE is exactly "live".
 */
export function prizeConfig(env = {}) {
  const treasury = env.TREASURY_PUBLIC_KEY && parsePubkey(env.TREASURY_PUBLIC_KEY) ? String(env.TREASURY_PUBLIC_KEY).trim() : null;
  const rpcUrl = env.SOLANA_RPC_URL ? String(env.SOLANA_RPC_URL).trim() : null;
  const mint = env.TOKEN_MINT && parsePubkey(env.TOKEN_MINT) ? String(env.TOKEN_MINT).trim() : null;
  let minPct = clamp(num(env.PRIZE_MIN_PCT, 1), 0, 100), maxPct = clamp(num(env.PRIZE_MAX_PCT, 5), 0, 100);
  if (maxPct < minPct) [minPct, maxPct] = [maxPct, minPct];
  // PRIZE_PCT: a fixed share of the pool every match (overrides the MIN/MAX range)
  const fixed = num(env.PRIZE_PCT, null);
  if (fixed !== null) minPct = maxPct = clamp(fixed, 0, 100);
  const cfg = {
    enabled: !!(rpcUrl && treasury),
    rpcUrl, treasury, mint,
    mode: String(env.PAYOUT_MODE || '').trim() === 'live' ? 'live' : 'dry-run',
    hasSecret: !!env.TREASURY_SECRET_KEY,
    minPct, maxPct,
    maxLamports: Math.floor(Math.max(0, num(env.PRIZE_MAX_SOL, 1)) * LAMPORTS_PER_SOL),
    reserveLamports: Math.floor(Math.max(0, num(env.PRIZE_RESERVE_SOL, 0.05)) * LAMPORTS_PER_SOL),
    minHumans: Math.max(1, Math.floor(num(env.MIN_HUMAN_PLAYERS, 2))),
    minHolding: Math.max(0, num(env.MIN_TOKEN_HOLDING, 0)),
    // MIN_HOLDING_USD: the minimum is a dollar value (token count = USD / live price), so it gets *easier* in tokens as
    // the price rises. MIN_TOKEN_HOLDING then is the most it can ever ask for, and the fallback when no price is known.
    minHoldingUsd: Math.max(0, num(env.MIN_HOLDING_USD, 0)),
    priceUrl: String(env.PRICE_API_URL || 'https://lite-api.jup.ag/price/v3?ids=').trim(),
    cooldownMs: Math.max(0, num(env.PRIZE_COOLDOWN_SEC, 3600)) * 1000,
    // PRIZE_SPLIT: "all" (default) = every eligible holder on the winning team gets an equal share; "one" = one random holder
    split: String(env.PRIZE_SPLIT || 'all').trim() === 'one' ? 'one' : 'all',
    problems: [],
  };
  if ((env.TREASURY_PUBLIC_KEY || env.SOLANA_RPC_URL) && !cfg.enabled) cfg.problems.push('SOLANA_RPC_URL and a valid TREASURY_PUBLIC_KEY are both required');
  if (env.TOKEN_MINT && !mint) cfg.problems.push('TOKEN_MINT is not a valid base58 public key');
  if (cfg.minHolding > 0 && !mint) cfg.problems.push('MIN_TOKEN_HOLDING is set but TOKEN_MINT is missing: the holding check is skipped');
  if (cfg.mode === 'live' && !cfg.hasSecret) cfg.problems.push('PAYOUT_MODE=live without TREASURY_SECRET_KEY: payouts will fail');
  return cfg;
}

/** The public view of the config (no URLs that may carry an API key, never anything secret). */
export function publicConfig(cfg) {
  return {
    enabled: cfg.enabled, mode: cfg.mode, treasury: cfg.treasury, mint: cfg.mint,
    minPct: cfg.minPct, maxPct: cfg.maxPct, maxSol: cfg.maxLamports / LAMPORTS_PER_SOL, reserveSol: cfg.reserveLamports / LAMPORTS_PER_SOL,
    minHumans: cfg.minHumans, minHolding: cfg.minHolding, minHoldingUsd: cfg.minHoldingUsd, cooldownSec: cfg.cooldownMs / 1000, split: cfg.split,
  };
}

export function newSeedHex() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const commitOf = (seedHex) => sha256Hex(seedHex);

/** 64 bits of the seed for one purpose, as a BigInt. */
export async function draw64(seedHex, label) {
  return BigInt('0x' + (await sha256Hex(`${seedHex}:${label}`)).slice(0, 16));
}
export async function drawUnit(seedHex, label) { return Number(await draw64(seedHex, label)) / 2 ** 64; }
export async function drawIndex(seedHex, label, n) { return Number((await draw64(seedHex, label)) % BigInt(n)); }

/** Prize in lamports for a pool balance and a uniform draw u ∈ [0, 1). */
export function prizeLamports(poolLamports, cfg, u) {
  const pct = cfg.minPct + u * (cfg.maxPct - cfg.minPct);
  const raw = Math.floor((poolLamports * pct) / 100);
  const spendable = poolLamports - cfg.reserveLamports - TX_FEE_LAMPORTS;
  const prize = Math.min(raw, cfg.maxLamports, spendable);
  return { pct, lamports: prize >= MIN_PRIZE_LAMPORTS ? prize : 0 };
}

/**
 * Is this match a prize round at all? `humans` = human players (connected sockets) at match start, `wallets` = how
 * many of them have a verified wallet (bots are irrelevant: offline matches never reach the relay). A match needs
 * MIN_HUMAN_PLAYERS humans, and as many verified wallets, to carry a prize.
 */
export function roundBlock(cfg, humansAtStart, walletsAtStart = humansAtStart) {
  if (!cfg.enabled) return 'prizes disabled';
  if (humansAtStart < cfg.minHumans) return `needs ${cfg.minHumans}+ human players`;
  if (walletsAtStart < cfg.minHumans) return `needs ${cfg.minHumans}+ players with a verified wallet`;
  return null;
}

/**
 * A prize needs a verified wallet on BOTH teams (so nobody farms the pool with two wallets on one side).
 * `players` = humans still connected [{ id, wallet }], `winners` = the winning team's human ids.
 */
export function bothSidesBlock(players, winners) {
  const win = new Set(winners);
  const w = players.filter((p) => p.wallet && win.has(p.id)).length, l = players.filter((p) => p.wallet && !win.has(p.id)).length;
  return w && l ? null : 'needs a wallet holder on each team';
}

/**
 * Tokens a wallet must hold right now. With MIN_HOLDING_USD and a live price: ceil(USD / price), never more than
 * MIN_TOKEN_HOLDING (when that is set). Without a price: MIN_TOKEN_HOLDING.
 */
export function effectiveMinHolding(cfg, priceUsd) {
  if (!(cfg.minHoldingUsd > 0) || !(priceUsd > 0)) return cfg.minHolding;
  const t = Math.ceil(cfg.minHoldingUsd / priceUsd);
  return cfg.minHolding > 0 ? Math.min(t, cfg.minHolding) : t;
}

/** What the next match would pay at this pool balance: the low and high end of the draw (equal with PRIZE_PCT). */
export function prizeEstimate(poolLamports, cfg) {
  const lo = prizeLamports(poolLamports, cfg, 0).lamports, hi = prizeLamports(poolLamports, cfg, 1).lamports;
  return { minSol: lo / LAMPORTS_PER_SOL, maxSol: hi / LAMPORTS_PER_SOL };
}

/**
 * Agree on the winners from every human's own result report. Returns { winners: [ids] } or { error }.
 * `expected` = ids of the round's humans still connected; each must have reported and all reports must match.
 */
export function consensus(reports, expected) {
  if (!expected.length) return { error: 'no players left' };
  const keys = new Map();
  for (const id of expected) {
    const r = reports.get(id);
    if (!r) return { error: 'missing result reports' };
    keys.set(id, [...new Set(r)].sort().join(','));
  }
  const vals = new Set(keys.values());
  if (vals.size !== 1) return { error: 'players disagree on the result' };
  const [v] = vals;
  return { winners: v ? v.split(',') : [] };
}

/**
 * Filter the winning team's humans down to prize candidates.
 * players: [{ id, name, wallet }] (wallet = verified base58 address or null), winners: Set/array of ids,
 * cooldowns: Map wallet → last prize time (ms), holdings: Map wallet → token amount (only consulted if minHolding).
 * Returns { candidates: [{ id, name, wallet }] sorted by wallet, rejected: [{ id, reason }] }.
 */
export function eligibleCandidates({ players, winners, cooldowns = new Map(), holdings = new Map(), now = Date.now(), cfg }) {
  const win = new Set(winners), seen = new Set(), candidates = [], rejected = [];
  for (const p of [...players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!win.has(p.id)) continue;
    const why = !p.wallet ? 'no verified wallet'
      : p.wallet === cfg.treasury ? 'treasury wallet'
        : seen.has(p.wallet) ? 'wallet already in this round'
          : cfg.cooldownMs && cooldowns.has(p.wallet) && now - cooldowns.get(p.wallet) < cfg.cooldownMs ? 'wallet on cooldown'
            : cfg.mint && cfg.minHolding > 0 && !((holdings.get(p.wallet) ?? 0) >= cfg.minHolding) ? 'token holding below minimum'
              : null;
    if (why) { rejected.push({ id: p.id, reason: why }); continue; }
    seen.add(p.wallet);
    candidates.push({ id: p.id, name: p.name, wallet: p.wallet });
  }
  candidates.sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  return { candidates, rejected };
}

/** The full, deterministic draw for a revealed seed (what anyone re-runs to audit a round). */
export async function drawRound(seedHex, poolLamports, candidates, cfg) {
  if (!candidates.length) return { lamports: 0, pct: 0, winner: null, reason: 'no eligible winners' };
  const u = await drawUnit(seedHex, 'amount');
  const { pct, lamports } = prizeLamports(poolLamports, cfg, u);
  if (!lamports) return { lamports: 0, pct, winner: null, reason: 'pool too small' };
  const idx = await drawIndex(seedHex, 'winner', candidates.length);
  return { lamports, pct, winner: candidates[idx], index: idx };
}
