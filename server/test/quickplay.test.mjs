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
