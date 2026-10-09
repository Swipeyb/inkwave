import test from 'node:test';
import assert from 'node:assert/strict';
import { prizeConfig, publicConfig, prizeLamports, roundBlock, consensus, eligibleCandidates, drawRound, drawUnit, drawIndex, commitOf, newSeedHex, MIN_PRIZE_LAMPORTS, TX_FEE_LAMPORTS } from '../src/prize-core.js';
import { sha256Hex } from '../src/solana.js';

const T = 'So11111111111111111111111111111111111111112';
const W = ['4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'];
const base = { SOLANA_RPC_URL: 'http://rpc', TREASURY_PUBLIC_KEY: T };

test('config: off without RPC + treasury, dry-run unless exactly "live", sane defaults', () => {
  assert.equal(prizeConfig({}).enabled, false);
  assert.equal(prizeConfig({}).problems.length, 0);
  assert.equal(prizeConfig({ SOLANA_RPC_URL: 'x' }).enabled, false);
  assert.equal(prizeConfig({ ...base, TREASURY_PUBLIC_KEY: 'bogus' }).enabled, false);
  const c = prizeConfig(base);
  assert.equal(c.enabled, true);
  assert.equal(c.mode, 'dry-run');
  assert.equal(prizeConfig({ ...base, PAYOUT_MODE: 'LIVE' }).mode, 'dry-run');
  assert.equal(prizeConfig({ ...base, PAYOUT_MODE: 'live', TREASURY_SECRET_KEY: 'k' }).mode, 'live');
  assert.ok(prizeConfig({ ...base, PAYOUT_MODE: 'live' }).problems.some((p) => /SECRET/.test(p)));
  assert.equal(prizeConfig({ ...base, PAYOUT_MODE: 'live' }).mode, 'dry-run');   // live needs the key; until then, dry-run
  assert.deepEqual([c.minPct, c.maxPct, c.maxLamports, c.reserveLamports, c.minHumans], [1, 5, 1e9, 5e7, 2]);
  const s = prizeConfig({ ...base, PRIZE_MIN_PCT: '10', PRIZE_MAX_PCT: '3', MIN_HUMAN_PLAYERS: '0' });
  assert.deepEqual([s.minPct, s.maxPct, s.minHumans], [3, 10, 1]);
  const pub = publicConfig(prizeConfig({ ...base, TREASURY_SECRET_KEY: 'secret!' }));
  assert.ok(!JSON.stringify(pub).includes('secret!') && !JSON.stringify(pub).includes('http://rpc'));
});

test('prize amount: uniform between min and max %, capped, keeps the reserve, skips dust', () => {
  const cfg = prizeConfig({ ...base, PRIZE_MIN_PCT: 1, PRIZE_MAX_PCT: 5, PRIZE_MAX_SOL: 1, PRIZE_RESERVE_SOL: 0.05 });
  const pool = 10e9;   // 10 SOL
  assert.equal(prizeLamports(pool, cfg, 0).lamports, 1e8);
  assert.equal(prizeLamports(pool, cfg, 0.5).lamports, 3e8);
  assert.equal(prizeLamports(pool, cfg, 0.999999).lamports, Math.floor(pool * (1 + 0.999999 * 4) / 100));
  assert.equal(prizeLamports(1000e9, cfg, 0.5).lamports, 1e9);                     // PRIZE_MAX_SOL cap
  const tight = prizeConfig({ ...base, PRIZE_MIN_PCT: 50, PRIZE_MAX_PCT: 50, PRIZE_RESERVE_SOL: 0.09 });
  assert.equal(prizeLamports(0.1e9, tight, 0).lamports, 0.1e9 - 0.09e9 - TX_FEE_LAMPORTS);   // reserve wins
  assert.equal(prizeLamports(0.05e9, cfg, 1).lamports, 0);                          // under the reserve
  assert.equal(prizeLamports(0.06e9, cfg, 0).lamports, 0);                          // 0.0006 SOL < dust floor
  for (let i = 0; i < 200; i++) {
    const p = prizeLamports(7.3e9, cfg, Math.random());
    assert.ok(p.lamports === 0 || p.lamports >= MIN_PRIZE_LAMPORTS);
    assert.ok(p.lamports <= 7.3e9 * 0.05 && p.lamports >= Math.floor(7.3e9 * 0.01));
  }
});

test('round gating: disabled config, too few humans (bot-only rooms)', () => {
  assert.equal(roundBlock(prizeConfig({}), 8), 'prizes disabled');
  assert.match(roundBlock(prizeConfig(base), 1), /2\+ human/);
  assert.equal(roundBlock(prizeConfig(base), 2), null);
  assert.equal(roundBlock(prizeConfig({ ...base, MIN_HUMAN_PLAYERS: 4 }), 3), 'needs 4+ human players');
});

test('consensus: every remaining human must report the same winners', () => {
  const r = new Map([['A', ['A', 'B']], ['B', ['B', 'A', 'A']], ['C', ['A', 'B']]]);
  assert.deepEqual(consensus(r, ['A', 'B', 'C']), { winners: ['A', 'B'] });
  assert.deepEqual(consensus(r, ['A', 'B', 'C', 'D']), { error: 'missing result reports' });
  r.set('C', ['C']);
  assert.deepEqual(consensus(r, ['A', 'B', 'C']), { error: 'players disagree on the result' });
  assert.deepEqual(consensus(new Map([['A', []]]), ['A']), { winners: [] });
  assert.deepEqual(consensus(new Map(), []), { error: 'no players left' });
});

test('eligibility: winning team only, verified wallet, one wallet per round, cooldown, token holding, not the treasury', () => {
  const cfg = prizeConfig({ ...base, TOKEN_MINT: T, MIN_TOKEN_HOLDING: 1000, PRIZE_COOLDOWN_SEC: 60 });
  const now = 1_000_000;
  const players = [
    { id: 'A', name: 'a', wallet: W[0] }, { id: 'B', name: 'b', wallet: null }, { id: 'C', name: 'c', wallet: W[0] },
    { id: 'D', name: 'd', wallet: W[1] }, { id: 'E', name: 'e', wallet: W[2] }, { id: 'F', name: 'f', wallet: T }, { id: 'G', name: 'g', wallet: W[2] },
  ];
  const holdings = new Map([[W[0], 5000], [W[1], 999], [W[2], 1e6]]);
  const cooldowns = new Map([[W[2], now - 30_000]]);
  const { candidates, rejected } = eligibleCandidates({ players, winners: ['A', 'B', 'C', 'D', 'E', 'F'], holdings, cooldowns, now, cfg });
  assert.deepEqual(candidates.map((c) => c.id), ['A']);
  assert.deepEqual(Object.fromEntries(rejected.map((r) => [r.id, r.reason])), { B: 'no verified wallet', C: 'wallet already in this round', D: 'token holding below minimum', E: 'wallet on cooldown', F: 'treasury wallet' });
  const later = eligibleCandidates({ players, winners: ['E', 'G'], holdings, cooldowns, now: now + 31_000, cfg });
  assert.deepEqual(later.candidates.map((c) => c.id), ['E']);   // cooldown over; G shares E's wallet
  const noMint = eligibleCandidates({ players, winners: ['D'], cfg: prizeConfig(base) });
  assert.deepEqual(noMint.candidates.map((c) => c.id), ['D']);   // no holding rule without TOKEN_MINT
});

test('commit-reveal: the commitment is sha256 of the seed; draws are deterministic and unbiased enough', async () => {
  const seed = newSeedHex();
  assert.match(seed, /^[0-9a-f]{64}$/);
  assert.equal(await commitOf(seed), await sha256Hex(seed));
  assert.notEqual(newSeedHex(), seed);
  assert.equal(await drawUnit(seed, 'amount'), await drawUnit(seed, 'amount'));
  const counts = [0, 0, 0];
  for (let i = 0; i < 3000; i++) counts[await drawIndex(newSeedHex(), 'winner', 3)]++;
  for (const c of counts) assert.ok(c > 850 && c < 1150, `index spread ${counts}`);
  let lo = 0;
  for (let i = 0; i < 2000; i++) if ((await drawUnit(newSeedHex(), 'amount')) < 0.5) lo++;
  assert.ok(lo > 880 && lo < 1120);
});

test('drawRound: re-running with the revealed seed gives the same prize and winner', async () => {
  const cfg = prizeConfig(base), seed = newSeedHex();
  const cands = [{ id: 'A', wallet: W[0] }, { id: 'D', wallet: W[1] }, { id: 'E', wallet: W[2] }];
  const a = await drawRound(seed, 20e9, cands, cfg), b = await drawRound(seed, 20e9, cands, cfg);
  assert.deepEqual(a, b);
  assert.ok(a.winner && a.lamports >= 0.2e9 && a.lamports <= 1e9);
  assert.equal((await drawRound(seed, 20e9, [], cfg)).reason, 'no eligible winners');
  assert.equal((await drawRound(seed, 0.01e9, cands, cfg)).reason, 'pool too small');
});
