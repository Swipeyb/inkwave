import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bestPairs, eligible, rankPool, pickScore, teamScore, draftError, cleanName, nameAllowed, RULES, TEAM_SIZE } from '../src/core.js';

const H = 3600 * 1000;
const now = Date.UTC(2026, 9, 9, 12);
let n = 0;
const mint = () => ('Mint' + String(++n).padStart(4, '0').replace(/\d/g, (d) => 'ABCDEFGHJK'[d]) + 'x'.repeat(30)).slice(0, 40);
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
  assert.ok(!eligible({ ...ok, created: now - 50 * H }, now));        // not a fresh launch
  assert.ok(!eligible({ ...ok, liq: RULES.minLiq - 1 }, now));
  assert.ok(!eligible({ ...ok, vol1h: 0 }, now));
});

test('pool ranks by trading activity and caps the size', () => {
  const coins = Array.from({ length: 80 }, (_, i) => ({ mint: 'm' + i, price: 1, liq: 10000, vol1h: 4000 + i * 100, created: now - H }));
  const pool = rankPool(coins, now);
  assert.equal(pool.length, 60);
  assert.equal(pool[0].mint, 'm79');
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

// ---- League + draft rooms end to end, on Node's built-in SQLite and a fake market ----
function fakeCtx() {
  const db = new DatabaseSync(':memory:'), kv = new Map();
  return {
    storage: {
      sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows }; } },
      async get(k) { return kv.has(k) ? structuredClone(kv.get(k)) : undefined; }, async put(k, v) { kv.set(k, structuredClone(v)); },
      alarm: null, async setAlarm(t) { this.alarm = t; },
    },
  };
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

test('rooms: queue → lobby → 5-round draft (snipes) → live prices → final points on the board', async () => {
  await import('./cf-shim.mjs');
  const { League, Room } = await import('../src/index.js');
  const { roundOrder, resolveRound } = await import('../src/core.js');
  const prices = new Map(), coins = new Map();
  const mints = Array.from({ length: 70 }, () => { const m = mint(); prices.set(m, 0.001); coins.set(m, () => pair(m, { price: prices.get(m), created: Date.now() - 2 * H })); return m; });
  const fetchFn = fakeMarket(coins);
  let clock = Date.now();
  const rooms = new Map(), env = {};
  env.ROOM = { idFromName: (n) => n, get: (n) => { if (!rooms.has(n)) { const r = new Room(fakeCtx(), env); r.fetchFn = fetchFn; r.now = () => clock; rooms.set(n, r); } return rooms.get(n); } };
  const lg = new League(fakeCtx(), env); lg.fetchFn = fetchFn;
  env.LEAGUE = { idFromName: () => 'main', get: () => lg };

  assert.equal((await lg.refresh()).pool, 60);
  const a = await lg.join('alpha_1'), b = await lg.join('bravo_2'), c = await lg.join('charlie_3');
  await assert.rejects(lg.join('sneaky_bot'), /reserved/);
  const ra = (await lg.queue(a, 'sprint', clock)).room, rb = (await lg.queue(b, 'sprint', clock)).room, rc = (await lg.queue(c, 'sprint', clock)).room;
  assert.equal(ra, rb); assert.equal(rb, rc);              // all three in the same room
  const room = env.ROOM.get(ra);
  let v = await room.view(a.id);
  assert.equal(v.phase, 'lobby'); assert.equal(v.seats.length, 3);

  clock += 31000; await room.alarm();                      // lobby timer → draft with 5 bots
  v = await room.view(a.id);
  assert.equal(v.phase, 'draft'); assert.equal(v.seats.length, 8); assert.equal(v.seats.filter((s) => s.bot).length, 5);

  // round 1: A and B both want the top coin; whoever has priority gets it, the other is sniped and auto-picks
  const top = v.pool[0].mint;
  const seatOf = (pid) => v.seats.findIndex((s) => s.me);
  const sA = v.seats.findIndex((s) => s.me);
  const vb = await room.view(b.id), sB = vb.seats.findIndex((s) => s.me);
  await room.pick(a.id, top); await room.pick(b.id, top);
  v = await room.pick(c.id, v.pool[5].mint);              // last person in → round resolves at once
  assert.equal(v.round, 1);
  const first = roundOrder(8, 0).find((s) => s === sA || s === sB);
  const winner = first === sA ? 'alpha_1' : 'bravo_2';
  const holder = v.seats.find((s) => s.lineup[0]?.mint === top);
  assert.ok(holder && (holder.name === winner || holder.bot), `top coin went to ${holder?.name}`);   // a bot with even higher priority may want it too
  assert.ok(v.events.some((e) => e.k === 'sniped'), 'a snipe was announced');
  await assert.rejects(room.pick(a.id, top), /Already drafted/);

  for (let r = 1; r < 5; r++) { clock += 26000; await room.alarm(); }   // nobody picks: the clock auto-picks for people
  v = await room.view(a.id);
  assert.equal(v.phase, 'live');
  assert.ok(v.seats.every((s) => s.lineup.length === 5));
  assert.equal(new Set(v.seats.flatMap((s) => s.lineup.map((x) => x.mint))).size, 40);   // no coin twice in a room

  // A's coins double → A wins the room
  for (const x of v.seats.find((s) => s.me).lineup) prices.set(x.mint, 0.002);
  clock += 3600e3 + 1000; await room.alarm();
  v = await room.view(a.id);
  assert.equal(v.phase, 'final');
  assert.equal(v.seats.find((s) => s.me).place, 1);
  const board = lg.board(new Date(clock).toISOString().slice(0, 10));
  assert.equal(board.top[0].name, 'alpha_1'); assert.equal(board.top[0].points, 100);
  const me = await lg.me(a);
  assert.equal(me.rooms[0].points, 100);
});

test('resolveRound: priority order, snipes, auto-picks', async () => {
  const { resolveRound } = await import('../src/core.js');
  const taken = new Map();
  const res = resolveRound(3, 0, ['x', 'x', null], ['x', 'y', 'z'], taken);
  assert.deepEqual(res.map((r) => [r.seat, r.mint, r.sniped, r.auto]), [[0, 'x', false, false], [1, 'y', true, false], [2, 'z', false, true]]);
  const res2 = resolveRound(3, 1, ['q', null, null], ['x', 'y', 'z', 'q', 'w', 'v'], taken);   // reversed order in round 2
  assert.deepEqual(res2.map((r) => [r.seat, r.mint]), [[0, 'q'], [2, 'w'], [1, 'v']]);   // seat 0 asked for q, so idle seats with priority can't take it
});
