// DRAFTPUMP: one Cloudflare Worker serves the site (static assets from ../site) and the API under /api/.
//   League (one Durable Object, SQLite): players, the live coin list (cron refresh every 5 min), matchmaking, results.
//   Room   (one Durable Object per draft room): 8 seats, a 5-round simultaneous draft, live prices and the room's standings.
import { DurableObject } from 'cloudflare:workers';
import { TEAM_SIZE, SEATS, ROUNDS, ROUND_SEC, LOBBY_SEC, MODES, POINTS, rankPool, teamScore, pickScore, dayKey, cleanName, nameAllowed,
  resolveRound, botWish, placings, RULES } from './core.js';
import { discover, quotes } from './market.js';

const ORIGINS = [/^https:\/\/([a-z0-9-]+\.)?draftpump\.[a-z0-9-]+\.workers\.dev$/, /^https:\/\/(www\.)?draftpump\.[a-z]+$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const originOk = (o, self) => !o || o === self || ORIGINS.some((re) => re.test(o));
const BOT_NAMES = ['degen_bot', 'ape_bot', 'jeet_bot', 'chad_bot', 'bagholder_bot', 'sniper_bot', 'paperhands_bot', 'whale_bot', 'rug_bot', 'moon_bot', 'trench_bot', 'fomo_bot'];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    const path = url.pathname.replace(/^\/api(?=\/)/, '');
    const h = { 'access-control-allow-origin': origin && originOk(origin, url.origin) ? origin : '*', 'access-control-allow-headers': 'content-type, x-player, x-secret', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const json = (o, status = 200, cache = 'no-store') => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': cache, ...h } });
    if (path === '/health') return json({ ok: true });
    if (req.method === 'POST' && !originOk(origin, url.origin)) return json({ error: 'forbidden' }, 403);
    const league = env.LEAGUE.get(env.LEAGUE.idFromName('main'));
    const auth = { id: req.headers.get('x-player') || '', secret: req.headers.get('x-secret') || '' };
    const body = async () => (req.method === 'POST' ? await req.json().catch(() => ({})) : {});
    try {
      if (path === '/pool') return json(await league.pool(), 200, 'public, max-age=20');
      if (path === '/board') return json(await league.board(url.searchParams.get('day') || dayKey()), 200, 'public, max-age=15');
      if (path === '/join' && req.method === 'POST') return json(await league.join((await body()).name, req.headers.get('cf-connecting-ip') || ''));
      if (path === '/me') return json(await league.me(auth));
      if (path === '/queue' && req.method === 'POST') return json(await league.queue(auth, (await body()).mode));
      const m = path.match(/^\/room\/([0-9a-f]{12})(\/pick)?$/);
      if (m) {
        const room = env.ROOM.get(env.ROOM.idFromName(m[1]));
        if (m[2] && req.method === 'POST') { const p = await league.who(auth); return json(await room.pick(p.id, (await body()).mint)); }
        let pid = null; try { if (auth.id) pid = (await league.who(auth)).id; } catch { /* spectator */ }
        return json(await room.view(pid));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      // our own errors carry a player-facing message (Durable Object RPC keeps the message, not custom fields)
      return json({ error: String(e?.message || 'Something went wrong. Try again.').slice(0, 200) }, 400);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.LEAGUE.get(env.LEAGUE.idFromName('main')).refresh());
  },
};

const userErr = (m) => Object.assign(new Error(m), { userMessage: m });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
const rid = (n = 6) => hex(crypto.getRandomValues(new Uint8Array(n)));

// =====================================================================================================================
export class League extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.fetchFn = (...a) => fetch(...a);
    this.joins = new Map();
    this.open = new Map();   // mode → { id, n, at } the room currently filling (in memory; a lost entry just opens a new room)
    for (const q of [
      `CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT NOT NULL, lname TEXT UNIQUE NOT NULL, secret TEXT NOT NULL, created INTEGER, wallet TEXT)`,
      `CREATE TABLE IF NOT EXISTS coins (mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, image TEXT, url TEXT, price REAL, liq REAL, mcap REAL, vol1h REAL, chg1h REAL, chg24h REAL, created INTEGER, updated INTEGER)`,
      `CREATE TABLE IF NOT EXISTS pool (mint TEXT PRIMARY KEY, rank INTEGER)`,
      `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
      `CREATE TABLE IF NOT EXISTS seats (room TEXT NOT NULL, player TEXT NOT NULL, mode TEXT, joined INTEGER, PRIMARY KEY (room, player))`,
      `CREATE INDEX IF NOT EXISTS seats_player ON seats (player, joined DESC)`,
      `CREATE TABLE IF NOT EXISTS results (room TEXT NOT NULL, player TEXT NOT NULL, mode TEXT, day TEXT, score REAL, place INTEGER, points INTEGER, picks TEXT, ended INTEGER, PRIMARY KEY (room, player))`,
      `CREATE INDEX IF NOT EXISTS results_day ON results (day)`,
    ]) this.sql.exec(q);
  }
  rows(q, ...b) { return this.sql.exec(q, ...b).toArray(); }

  // ---------------------------------------------------------------- market (cron)
  async refresh(now = Date.now()) {
    if (this._busy) return { busy: true };
    this._busy = true;
    try {
      const { mints, errors } = await discover(this.fetchFn);
      const q = await quotes([...mints, ...this.rows(`SELECT mint FROM pool`).map((r) => r.mint)], this.fetchFn);
      for (const c of q.values()) {
        this.sql.exec(`INSERT OR REPLACE INTO coins (mint, name, symbol, image, url, price, liq, mcap, vol1h, chg1h, chg24h, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          c.mint, c.name, c.symbol, c.image, c.url, c.price, c.liq, c.mcap, c.vol1h, c.chg1h, c.chg24h, c.created, now);
      }
      const pool = rankPool([...q.values()], now);
      if (pool.length >= TEAM_SIZE * SEATS) {   // never swap a good list for a thin one when the feeds hiccup
        this.sql.exec(`DELETE FROM pool`);
        pool.forEach((c, i) => this.sql.exec(`INSERT INTO pool (mint, rank) VALUES (?, ?)`, c.mint, i));
      }
      this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('refreshed', ?), ('errors', ?), ('found', ?)`, String(now), JSON.stringify(errors.slice(0, 5)), String(pool.length));
      this.sql.exec(`DELETE FROM coins WHERE updated < ? AND mint NOT IN (SELECT mint FROM pool)`, now - 2 * 86400000);
      return { pool: pool.length, quoted: q.size, errors };
    } finally { this._busy = false; }
  }

  pool() {
    const coins = this.rows(`SELECT c.mint, c.name, c.symbol, c.image, c.url, c.price, c.liq, c.mcap, c.vol1h, c.chg1h, c.created FROM pool p JOIN coins c ON c.mint = p.mint ORDER BY p.rank`);
    const meta = Object.fromEntries(this.rows(`SELECT k, v FROM meta`).map((r) => [r.k, r.v]));
    return { coins, refreshed: +(meta.refreshed || 0), seats: SEATS, teamSize: TEAM_SIZE };
  }

  // ---------------------------------------------------------------- players
  async join(name, ip = '', now = Date.now()) {
    const n = cleanName(name);
    if (!n || !nameAllowed(n)) throw userErr('Nickname: 3–16 letters, numbers or _');
    const recent = (this.joins.get(ip) || []).filter((t) => now - t < 3600000);
    if (ip && recent.length >= 8) throw userErr('Too many new players from this network. Try again later.');
    if (/_bot$/i.test(n)) throw userErr('Names ending in _bot are reserved');
    if (this.rows(`SELECT 1 FROM players WHERE lname = ?`, n.toLowerCase()).length) throw userErr('That nickname is taken');
    const id = rid(6), secret = rid(16);
    this.sql.exec(`INSERT INTO players (id, name, lname, secret, created) VALUES (?, ?, ?, ?, ?)`, id, n, n.toLowerCase(), await sha(secret), now);
    recent.push(now); this.joins.set(ip, recent);
    return { id, secret, name: n };
  }
  async who(auth) {
    const p = this.rows(`SELECT id, name, secret FROM players WHERE id = ?`, String(auth?.id || ''))[0];
    if (!p || p.secret !== await sha(String(auth?.secret || ''))) throw userErr('Sign in again');
    return { id: p.id, name: p.name };
  }

  // ---------------------------------------------------------------- matchmaking: fill one open room per mode
  async queue(auth, mode, now = Date.now()) {
    const p = await this.who(auth);
    if (!MODES[mode]) throw userErr('Pick a game mode');
    // already waiting in / drafting a room of this mode: send them back to it
    const mine = this.rows(`SELECT s.room FROM seats s WHERE s.player = ? AND s.mode = ? AND s.joined > ? ORDER BY s.joined DESC LIMIT 1`, p.id, mode, now - 10 * 60000)[0];
    if (mine) {
      const v = await this.env.ROOM.get(this.env.ROOM.idFromName(mine.room)).view(p.id);
      if (v.phase === 'lobby' || v.phase === 'draft') return { room: mine.room };
    }
    const pool = this.pool().coins;
    if (pool.length < TEAM_SIZE * SEATS) throw userErr('Not enough fresh coins to draft right now. Try again in a few minutes.');
    for (let tries = 0; tries < 3; tries++) {
      let o = this.open.get(mode);
      if (!o || now - o.at > (LOBBY_SEC - 3) * 1000 || o.n >= SEATS) {
        o = { id: rid(6), n: 0, at: now };
        this.open.set(mode, o);
        await this.env.ROOM.get(this.env.ROOM.idFromName(o.id)).init(o.id, mode, pool.slice(0, 60), now);
      }
      const r = await this.env.ROOM.get(this.env.ROOM.idFromName(o.id)).join(p.id, p.name, now);
      if (r.ok) {
        o.n = r.humans;
        this.sql.exec(`INSERT OR IGNORE INTO seats (room, player, mode, joined) VALUES (?, ?, ?, ?)`, o.id, p.id, mode, now);
        return { room: o.id };
      }
      this.open.delete(mode);   // started or full: open a fresh one
    }
    throw userErr('Couldn’t find a room. Try again.');
  }

  // a room reports its final standings
  report(room, mode, day, rows, now = Date.now()) {
    for (const r of rows) {
      if (r.bot) continue;
      this.sql.exec(`INSERT OR REPLACE INTO results (room, player, mode, day, score, place, points, picks, ended) VALUES (?,?,?,?,?,?,?,?,?)`,
        room, r.pid, mode, day, r.score, r.place, r.points, JSON.stringify(r.picks || []), now);
    }
    return true;
  }

  board(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = dayKey();
    const top = this.rows(`SELECT pl.name, SUM(r.points) AS points, COUNT(*) AS games, SUM(CASE WHEN r.place = 1 THEN 1 ELSE 0 END) AS wins, MAX(r.score) AS best
      FROM results r JOIN players pl ON pl.id = r.player WHERE r.day = ? GROUP BY r.player ORDER BY points DESC, wins DESC, best DESC LIMIT 100`, day);
    const best = this.rows(`SELECT pl.name, r.score, r.room, r.mode, r.picks FROM results r JOIN players pl ON pl.id = r.player WHERE r.day = ? ORDER BY r.score DESC LIMIT 5`, day)
      .map((r) => ({ ...r, picks: JSON.parse(r.picks || '[]') }));
    return { day, top, best, players: top.length };
  }

  async me(auth) {
    const p = await this.who(auth);
    const rooms = this.rows(`SELECT s.room, s.mode, s.joined, r.score, r.place, r.points FROM seats s LEFT JOIN results r ON r.room = s.room AND r.player = s.player
      WHERE s.player = ? ORDER BY s.joined DESC LIMIT 30`, p.id);
    const today = this.rows(`SELECT COALESCE(SUM(points), 0) AS points, COUNT(*) AS games FROM results WHERE player = ? AND day = ?`, p.id, dayKey())[0];
    return { name: p.name, rooms, today };
  }
}

// =====================================================================================================================
// One draft room. State lives in a single storage key; alarms drive lobby → draft rounds → live → final.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.fetchFn = (...a) => fetch(...a);
    this.now = () => Date.now();
  }
  async load() { if (!this.s) this.s = (await this.ctx.storage.get('s')) || null; return this.s; }
  async save() { await this.ctx.storage.put('s', this.s); }
  async wake(at) { await this.ctx.storage.setAlarm(at); }

  async init(id, mode, pool, now = this.now()) {
    if (await this.load()) return true;
    this.s = { id, mode, created: now, phase: 'lobby', startsAt: now + LOBBY_SEC * 1000, seats: [], pool, round: -1, roundEnds: 0,
      wants: {}, taken: {}, picks: {}, events: [], start: {}, cur: {}, dead: {}, priced: 0, lockedAt: 0, ends: 0, reported: false };
    await this.save();
    await this.wake(this.s.startsAt);
    return true;
  }

  async join(pid, name, now = this.now()) {
    const s = await this.load();
    if (!s) return { ok: false };
    if (s.seats.some((x) => x.pid === pid)) return { ok: true, humans: s.seats.filter((x) => !x.bot).length };
    if (s.phase !== 'lobby' || s.seats.length >= SEATS) return { ok: false };
    s.seats.push({ pid, name, bot: false });
    s.events.push({ t: now, k: 'join', name });
    if (s.seats.length >= SEATS) { await this._startDraft(now); } else await this.save();
    return { ok: true, humans: s.seats.filter((x) => !x.bot).length };
  }

  async alarm() {
    const s = await this.load(), now = this.now();
    if (!s) return;
    if (s.phase === 'lobby' && now >= s.startsAt - 50) return this._startDraft(now);
    if (s.phase === 'draft' && now >= s.roundEnds - 50) return this._endRound(now);
    if (s.phase === 'live') {
      await this._price(now, true);
      if (now >= s.ends - 50) return this._finish(now);
      await this.save();
      return this.wake(Math.min(s.ends, now + 5 * 60000));
    }
  }

  async _startDraft(now) {
    const s = this.s;
    if (s.phase !== 'lobby') return;
    const used = new Set(s.seats.map((x) => x.name));
    const bots = BOT_NAMES.filter((n) => !used.has(n)).sort(() => Math.random() - 0.5);
    while (s.seats.length < SEATS) s.seats.push({ pid: 'bot' + s.seats.length, name: bots.pop() || 'bot', bot: true });
    s.seats.sort(() => Math.random() - 0.5);   // random draft order
    s.seats.forEach((x) => { s.picks[x.pid] = []; });
    s.phase = 'draft'; s.round = 0; s.roundEnds = now + ROUND_SEC * 1000; s.wants = {};
    s.events.push({ t: now, k: 'start' });
    await this.save();
    await this.wake(s.roundEnds);
  }

  async pick(pid, mint, now = this.now()) {
    const s = await this.load();
    if (!s) throw userErr('Room not found');
    if (s.phase !== 'draft') throw userErr('The draft isn’t running');
    const seat = s.seats.findIndex((x) => x.pid === pid);
    if (seat < 0) throw userErr('You’re not in this room');
    if (!s.pool.some((c) => c.mint === mint)) throw userErr('That coin isn’t in this draft');
    if (s.taken[mint] != null) throw userErr('Already drafted');
    s.wants[pid] = mint;
    // everyone (people) has picked: resolve now instead of waiting out the clock
    if (s.seats.every((x) => x.bot || s.wants[x.pid])) { await this._endRound(now); return this.view(pid); }
    await this.save();
    return this.view(pid);
  }

  async _endRound(now) {
    const s = this.s;
    if (s.phase !== 'draft') return;
    const order = s.pool.map((c) => c.mint);
    const taken = new Map(Object.entries(s.taken).map(([m, seat]) => [m, seat]));
    const wants = s.seats.map((x) => (x.bot ? botWish(order, taken) : s.wants[x.pid] || null));
    const res = resolveRound(s.seats.length, s.round, wants, order, taken);
    for (const r of res) {
      const who = s.seats[r.seat];
      s.picks[who.pid].push(r.mint);
      s.taken[r.mint] = r.seat;
      const sym = s.pool.find((c) => c.mint === r.mint)?.symbol;
      if (r.sniped) {
        const by = s.seats[taken.get(r.wanted)]?.name;
        s.events.push({ t: now, k: 'sniped', name: who.name, by, want: s.pool.find((c) => c.mint === r.wanted)?.symbol, got: sym });
      } else s.events.push({ t: now, k: 'pick', name: who.name, sym, auto: r.auto && !who.bot });
    }
    s.wants = {};
    if (s.round + 1 < ROUNDS) {
      s.round++; s.roundEnds = now + ROUND_SEC * 1000;
      await this.save(); await this.wake(s.roundEnds);
    } else {
      // draft over: everyone's start prices are taken at the same moment
      s.phase = 'live'; s.lockedAt = now; s.ends = now + MODES[s.mode].ms;
      await this._price(now, true);
      for (const m of Object.keys(s.taken)) s.start[m] = s.cur[m] || s.pool.find((c) => c.mint === m)?.price || 0;
      s.events.push({ t: now, k: 'locked' });
      await this.save(); await this.wake(Math.min(s.ends, now + 5 * 60000));
    }
  }

  // fresh prices for every drafted coin (2 DexScreener calls for a full room); viewers trigger it at most once a minute
  async _price(now, force = false) {
    const s = this.s;
    if (!force && now - s.priced < 60000) return;
    if (this._pricing) return this._pricing;
    s.priced = now;
    this._pricing = (async () => {
      try {
        const q = await quotes(Object.keys(s.taken), this.fetchFn);
        for (const [m, c] of q) { s.cur[m] = c.price; if (c.liq < RULES.deadLiq) s.dead[m] = 1; else delete s.dead[m]; }
      } catch { /* keep the last prices */ }
    })();
    try { await this._pricing; } finally { this._pricing = null; }
  }

  _scores() {
    const s = this.s;
    return s.seats.map((x) => teamScore((s.picks[x.pid] || []).map((m) => ({ start: s.start[m], cur: s.cur[m] ?? s.start[m], dead: !!s.dead[m] }))));
  }

  async _finish(now) {
    const s = this.s;
    s.phase = 'final';
    const scores = this._scores();
    const pl = placings(scores);
    let pts = 0;
    const rows = pl.map((p) => {
      const x = s.seats[p.seat];
      const points = !x.bot && p.place <= POINTS.length ? POINTS[p.place - 1] : 0;
      pts += points;
      return { pid: x.pid, bot: x.bot, score: p.score, place: p.place, points, picks: (s.picks[x.pid] || []).map((m) => s.pool.find((c) => c.mint === m)?.symbol) };
    });
    s.events.push({ t: now, k: 'final' });
    await this.save();
    if (!s.reported) {
      try { await this.env.LEAGUE.get(this.env.LEAGUE.idFromName('main')).report(s.id, s.mode, dayKey(s.lockedAt), rows, now); s.reported = true; await this.save(); }
      catch { await this.wake(now + 60000); }   // try again in a minute
    }
  }

  async view(pid, now = this.now()) {
    const s = await this.load();
    if (!s) throw userErr('Room not found');
    if (s.phase === 'live') { await this._price(now); if (now >= s.ends) await this._finish(now); else await this.save(); }
    const scores = s.phase === 'live' || s.phase === 'final' ? this._scores() : null;
    const coin = (m) => { const c = s.pool.find((x) => x.mint === m) || {}; return { mint: m, symbol: c.symbol, name: c.name, image: c.image, url: c.url, mcap: c.mcap,
      pct: s.start[m] ? Math.round(pickScore(s.start[m], s.cur[m] ?? s.start[m], !!s.dead[m]) * 10) / 10 : null, dead: !!s.dead[m] }; };
    const order = scores ? placings(scores) : null;
    return {
      id: s.id, mode: s.mode, modeLabel: MODES[s.mode].label, phase: s.phase, now,
      startsAt: s.startsAt, round: s.round, rounds: ROUNDS, roundEnds: s.roundEnds, lockedAt: s.lockedAt, ends: s.ends,
      seats: s.seats.map((x, i) => ({ name: x.name, bot: x.bot, me: x.pid === pid, picked: s.phase === 'draft' && !x.bot ? !!s.wants[x.pid] : undefined,
        lineup: (s.picks[x.pid] || []).map(coin), score: scores ? scores[i] : null, place: order ? order.find((o) => o.seat === i).place : null })),
      myWant: pid ? s.wants[pid] || null : null,
      pool: s.phase === 'draft' || s.phase === 'lobby' ? s.pool.map((c) => ({ mint: c.mint, symbol: c.symbol, name: c.name, image: c.image, url: c.url, mcap: c.mcap, liq: c.liq, chg1h: c.chg1h, created: c.created,
        takenBy: s.taken[c.mint] != null ? s.seats[s.taken[c.mint]]?.name : null })) : undefined,
      events: s.events.slice(-14),
      points: POINTS,
    };
  }
}
