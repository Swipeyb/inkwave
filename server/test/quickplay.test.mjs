// Quick Play + per-match prize rules: PRIZE_PCT, the verified-wallet minimum, the lobby estimate, and the matchmaker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { prizeConfig, roundBlock, prizeEstimate, prizeLamports, MIN_PRIZE_LAMPORTS } from '../src/prize-core.js';

// index.js imports `cloudflare:workers`: give Node a stand-in DurableObject base class
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
  return next(spec, ctx);
}`));
const { Matchmaker, QUICK_CODE } = await import('../src/index.js');

const base = { SOLANA_RPC_URL: 'https://rpc.example', TREASURY_PUBLIC_KEY: '11111111111111111111111111111112' };
const SOL = 1e9;

test('PRIZE_PCT pays a fixed share; cap and reserve still hold', () => {
  const cfg = prizeConfig({ ...base, PRIZE_PCT: '2', PRIZE_MAX_SOL: '0.5', PRIZE_RESERVE_SOL: '1' });
  assert.equal(cfg.minPct, 2); assert.equal(cfg.maxPct, 2);
  assert.equal(prizeLamports(10 * SOL, cfg, 0).lamports, 0.2 * SOL);
  assert.equal(prizeLamports(10 * SOL, cfg, 0.9).lamports, 0.2 * SOL);            // same at any draw
  assert.equal(prizeLamports(100 * SOL, cfg, 0).lamports, 0.5 * SOL);             // capped
  assert.ok(prizeLamports(1.01 * SOL, cfg, 0).lamports < 0.01 * SOL + 1);        // reserve keeps 1 SOL back
  assert.equal(prizeLamports(1 * SOL, cfg, 0).lamports, 0);                       // never touches the reserve
  // without PRIZE_PCT the old range still works
  const r = prizeConfig({ ...base, PRIZE_MIN_PCT: '1', PRIZE_MAX_PCT: '5' });
  assert.deepEqual([r.minPct, r.maxPct], [1, 5]);
});

test('a prize round needs MIN_HUMAN_PLAYERS players with verified wallets', () => {
  const cfg = prizeConfig(base);
  assert.equal(roundBlock(cfg, 4, 1), 'needs 2+ players with a verified wallet');
  assert.equal(roundBlock(cfg, 4, 2), null);
  assert.equal(roundBlock(cfg, 1, 1), 'needs 2+ human players');
});

test('lobby estimate matches what a match would pay', () => {
  const fixed = prizeConfig({ ...base, PRIZE_PCT: '3' });
  assert.deepEqual(prizeEstimate(10 * SOL, fixed), { minSol: 0.3, maxSol: 0.3 });
  const range = prizeConfig({ ...base, PRIZE_MIN_PCT: '1', PRIZE_MAX_PCT: '5', PRIZE_RESERVE_SOL: '0' });
  const e = prizeEstimate(10 * SOL, range);
  assert.equal(e.minSol, 0.1); assert.ok(Math.abs(e.maxSol - 0.5) < 1e-9);
  assert.deepEqual(prizeEstimate(0.01 * SOL, fixed), { minSol: 0, maxSol: 0 });
  assert.ok(MIN_PRIZE_LAMPORTS > 0);
});

// ---- matchmaker against fake rooms ----
function fakeEnv(rooms) {
  return { ROOMS: { idFromName: (c) => c, get: (c) => ({ status: async () => rooms.get(c) || { humans: 0, locked: false } }) } };
}

test('matchmaker: new code, then fills the same room, skips full / running rooms', async () => {
  const rooms = new Map();
  const mm = new Matchmaker({}, fakeEnv(rooms));
  const a = (await mm.quick()).code;
  assert.match(a, QUICK_CODE);
  assert.equal(a.length, 6);                                   // never collides with 5-character private codes
  assert.equal((await mm.quick()).code, a);                    // second click goes to the same room
  rooms.set(a, { humans: 8, locked: false });
  const b = (await mm.quick()).code;
  assert.notEqual(b, a);                                       // full → new room
  rooms.set(b, { humans: 3, locked: true });
  const c = (await mm.quick()).code;
  assert.ok(c !== a && c !== b);                               // mid-match → new room
  rooms.set(c, { humans: 2, locked: false });
  rooms.set(b, { humans: 5, locked: false });                  // b's match ended with 5 still there: fullest open wins
  assert.equal((await mm.quick()).code, b);
});

test('matchmaker counts players on their way in, so a burst does not overfill', async () => {
  const rooms = new Map();
  const mm = new Matchmaker({}, fakeEnv(rooms));
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await mm.quick()).code);   // nobody has connected yet
  const counts = codes.reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map());
  assert.ok([...counts.values()].every((n) => n <= 8), JSON.stringify([...counts]));
  assert.equal(counts.size, 2);
});

test('a prize needs a verified wallet on each team', async () => {
  const { bothSidesBlock } = await import('../src/prize-core.js');
  const players = [{ id: 'A', wallet: 'w1' }, { id: 'B', wallet: 'w2' }, { id: 'C', wallet: null }, { id: 'D', wallet: null }];
  assert.equal(bothSidesBlock(players, ['A', 'B']), 'needs a wallet holder on each team');   // both wallets won
  assert.equal(bothSidesBlock(players, ['C', 'D']), 'needs a wallet holder on each team');   // both wallets lost
  assert.equal(bothSidesBlock(players, ['A', 'C']), null);                                     // one each side
});

test('holder rooms get their own QH codes, separate from open Quick Play', async () => {
  const { HOLDER_CODE } = await import('../src/index.js');
  const rooms = new Map();
  const mm = new Matchmaker({}, fakeEnv(rooms));
  const open = (await mm.quick('QP')).code, held = (await mm.quick('QH')).code;
  assert.match(open, /^QP/); assert.match(held, HOLDER_CODE); assert.match(held, QUICK_CODE);
  assert.equal((await mm.quick('QH')).code, held);   // holders fill the holder room
  assert.equal((await mm.quick('QP')).code, open);   // and never land in it from open Quick Play
});

test('ledger.holds: no mint → everyone passes; with a mint the on-chain amount decides', async () => {
  const { PrizeLedger } = await import('../src/ledger.js');
  const storage = { get: async () => null, put: async () => {}, list: async () => new Map(), delete: async () => {} };
  const base2 = { SOLANA_RPC_URL: 'http://rpc', TREASURY_PUBLIC_KEY: '11111111111111111111111111111112' };
  assert.equal((await new PrizeLedger({ env: base2, storage }).holds('w')).ok, true);
  const rpcWith = (amount) => async (_u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method !== 'getTokenAccountsByOwner') throw new Error(method);
    if (params[1].programId !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [] } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [{ account: { data: { parsed: { info: { mint: 'So11111111111111111111111111111111111111112', tokenAmount: { amount: String(amount * 1e6), decimals: 6, uiAmount: amount, uiAmountString: String(amount) } } } } } }] } }));
  };
  const env = { ...base2, TOKEN_MINT: 'So11111111111111111111111111111111111111112', MIN_TOKEN_HOLDING: '100000' };
  assert.equal((await new PrizeLedger({ env, storage, fetchFn: rpcWith(150000) }).holds('w')).ok, true);
  assert.equal((await new PrizeLedger({ env, storage, fetchFn: rpcWith(99999) }).holds('w')).ok, false);
});

test('dollar-based minimum: fewer tokens as the price rises, capped by MIN_TOKEN_HOLDING, fallback without a price', async () => {
  const { effectiveMinHolding } = await import('../src/prize-core.js');
  const cfg = prizeConfig({ ...base, TOKEN_MINT: 'So11111111111111111111111111111111111111112', MIN_HOLDING_USD: '10', MIN_TOKEN_HOLDING: '1000000' });
  assert.equal(effectiveMinHolding(cfg, 0.00001), 1000000);   // $10k mcap → 1M tokens
  assert.equal(effectiveMinHolding(cfg, 0.001), 10000);       // $1M mcap → 10k tokens
  assert.equal(effectiveMinHolding(cfg, 0.000001), 1000000);  // below $10k mcap: capped at 1M
  assert.equal(effectiveMinHolding(cfg, null), 1000000);      // no price: the token minimum
});

test('ledger reads the Jupiter price and applies it to the holder check', async () => {
  const { PrizeLedger } = await import('../src/ledger.js');
  const mint = 'So11111111111111111111111111111111111111112';
  const storage = { get: async () => null, put: async () => {}, list: async () => new Map(), delete: async () => {} };
  const fetchFn = async (url, init) => {
    if (String(url).startsWith('https://lite-api.jup.ag/')) return new Response(JSON.stringify({ [mint]: { usdPrice: 0.001 } }));
    const { params } = JSON.parse(init.body);
    if (params[1].programId !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [] } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [{ account: { data: { parsed: { info: { mint, tokenAmount: { uiAmountString: '20000' } } } } } }] } }));
  };
  const L = new PrizeLedger({ env: { ...base, TOKEN_MINT: mint, MIN_HOLDING_USD: '10', MIN_TOKEN_HOLDING: '1000000' }, storage, fetchFn });
  assert.equal(await L.minHolding(), 10000);
  const h = await L.holds('w');
  assert.equal(h.ok, true); assert.equal(h.need, 10000);   // 20k tokens ≈ $20 ≥ $10
});
