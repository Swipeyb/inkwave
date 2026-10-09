import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bestPairs, eligible, rankPool, pickScore, teamScore, draftError, cleanName, nameAllowed, RULES, TEAM_SIZE } from '../src/core.js';

const H = 3600 * 1000;
const now = Date.UTC(2026, 9, 9, 12);
let n = 0;
const mint = () => ('Mint' + String(++n).padStart(4, '0') + 'x'.repeat(30)).slice(0, 40).replace(/[0OIl]/g, '9');
function pair(m, o = {}) {
  return { chainId: 'solana', dexId: 'pumpswap', url: 'u', baseToken: { address: m, name: 'Coin ' + m.slice(4, 8), symbol: 'C' + m.slice(4, 8) },
    priceUsd: String(o.price ?? 0.001), liquidity: { usd: o.liq ?? 20000 }, marketCap: o.mcap ?? 100000, volume: { h1: o.vol1h ?? 10000, h24: 50000 },
    priceChange: { h1: 5, h24: 20 }, pairCreatedAt: o.created ?? now - 2 * H, info: { imageUrl: 'https://img/x.png' } };
}

test('bestPairs keeps the deepest pair per token and ignores other chains', () => {
  const m = mint();
  const map = bestPairs([pair(m, { liq: 1000, price: 1 }), pair(m, { liq: 9000, price: 2 }), { ...pair(mint()), chainId: 'base' }]);
  assert.equal(map.size, 1);
  assert.equal(map.get(m).price, 2);
});

test('eligibility: age window, liquidity, volume', () => {
  const ok = bestPairs([pair('A'.repeat(40))]).get('A'.repeat(40));
  assert.ok(eligible(ok, now));
  assert.ok(!eligible({ ...ok, created: now - 5 * 60000 }, now));     // too new (likely to rug instantly)
  assert.ok(!eligible({ ...ok, created: now - 30 * H }, now));        // not a fresh launch
  assert.ok(!eligible({ ...ok, liq: RULES.minLiq - 1 }, now));
  assert.ok(!eligible({ ...ok, vol1h: 0 }, now));
});

test('pool ranks by trading activity and caps the size', () => {
  const coins = Array.from({ length: 60 }, (_, i) => ({ mint: 'm' + i, price: 1, liq: 10000, vol1h: 4000 + i * 100, created: now - H }));
  const pool = rankPool(coins, now);
  assert.equal(pool.length, 40);
  assert.equal(pool[0].mint, 'm59');
});

test('scoring: clamps, dead coins, averages', () => {
  assert.equal(pickScore(1, 2), 100);
  assert.equal(pickScore(1, 0), -100);
  assert.equal(pickScore(1, 1000), 5000);              // one moonshot is capped
  assert.equal(pickScore(1, 3, true), -100);           // rugged = -100 % whatever the last price said
  assert.equal(teamScore([{ start: 1, cur: 2 }, { start: 1, cur: 0.5 }, { start: 1, cur: 1 }, { start: 1, cur: 1 }, { start: 1, cur: 1.5 }]), 20);
});

test('draft validation and nicknames', () => {
  const pool = new Set(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(draftError(['a', 'b', 'c', 'd', 'e'], pool), null);
  assert.match(draftError(['a', 'b'], pool), /exactly/);
  assert.match(draftError(['a', 'a', 'b', 'c', 'd'], pool), /once/);
  assert.match(draftError(['a', 'b', 'c', 'd', 'z'], pool), /left/);
  assert.equal(cleanName(' degen_42 '), 'degen_42');
  assert.equal(cleanName('a b'), null);
  assert.equal(cleanName('ab'), null);
  assert.ok(!nameAllowed('xHitlerx'));
});

// ---- the League Durable Object end to end, on Node's built-in SQLite and a fake market ----
function fakeStorage() {
  const db = new DatabaseSync(':memory:');
  return { sql: { exec(q, ...b) { const st = db.prepare(q); const isRead = /^\s*SELECT/i.test(q); const rows = isRead ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows }; } } };
}
function fakeMarket(coins) {
  return async (url) => {
    const u = String(url);
    let body = [];
    if (u.includes('/token-profiles/') || u.includes('/token-boosts/')) body = [...coins.keys()].map((m) => ({ chainId: 'solana', tokenAddress: m }));
    else if (u.includes('geckoterminal')) body = { data: [] };
    else if (u.includes('/tokens/v1/solana/')) body = u.split('/tokens/v1/solana/')[1].split(',').filter((m) => coins.has(m)).map((m) => coins.get(m)());
    return { ok: true, status: 200, json: async () => body };
  };
}

test('league: refresh → join → draft → live score → final', async () => {
  await import('./cf-shim.mjs');
  const { League } = await import('../src/index.js');
  const prices = new Map(), coins = new Map();
  const mints = Array.from({ length: 12 }, () => { const m = mint(); prices.set(m, 0.001); coins.set(m, () => pair(m, { price: prices.get(m), created: Date.now() - 2 * H })); return m; });
  const lg = new League({ storage: fakeStorage() }, {});
  lg.fetchFn = fakeMarket(coins);
  const r = await lg.refresh();
  assert.equal(r.pool, 12);
  const pool = lg.pool();
  assert.equal(pool.coins.length, 12);

  const me = await lg.join('trench_king', '1.2.3.4');
  await assert.rejects(lg.join('Trench_King', '1.2.3.5'), /taken/);
  await assert.rejects(lg.draft({ id: me.id, secret: 'wrong' }, mints.slice(0, 5)), /Sign in/);
  const team = mints.slice(0, TEAM_SIZE);
  const e = await lg.draft(me, team);
  assert.equal(e.picks.length, 5);
  await assert.rejects(lg.draft(me, mints.slice(5, 10)), /already drafted/);

  prices.set(team[0], 0.003);   // +200 %
  prices.set(team[1], 0.0005);  // -50 %
  await lg.refresh();
  const m1 = await lg.me(me);
  assert.equal(m1.today.score, 30);   // (200 - 50 + 0 + 0 + 0) / 5
  assert.equal(m1.rank, 1);
  const b = lg.board(m1.today.day);
  assert.equal(b.top[0].name, 'trench_king');
  assert.equal(b.top[0].picks.length, 5);

  // 24 h later the team is final and stops changing
  await lg.refresh(Date.now() + 25 * H);
  assert.equal(lg.entry(e.id).final, 1);
});
