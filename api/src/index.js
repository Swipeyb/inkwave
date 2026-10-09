// DRAFTPUMP: one Cloudflare Worker serves the site (static assets from ../site) and the API under /api/, in front of
// one Durable Object ("League", SQLite storage) that keeps players,
// the live draft pool, teams and scores. A cron trigger refreshes the market every 5 minutes.
import { DurableObject } from 'cloudflare:workers';
import { TEAM_SIZE, ROUND_MS, rankPool, teamScore, pickScore, dayKey, cleanName, nameAllowed, draftError, RULES } from './core.js';
import { discover, quotes } from './market.js';

const ORIGINS = [/^https:\/\/([a-z0-9-]+\.)?draftpump\.pages\.dev$/, /^https:\/\/(www\.)?draftpump\.[a-z]+$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const originOk = (o) => !o || ORIGINS.some((re) => re.test(o));

function cors(origin) {
  return {
    'access-control-allow-origin': origin && originOk(origin) ? origin : '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-player, x-secret',
    'access-control-max-age': '86400',
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), origin = req.headers.get('Origin') || '';
    url.pathname = url.pathname.replace(/^\/api(?=\/)/, '');
    const h = cors(origin);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h, ...extra } });
    if (url.pathname === '/health') return json({ ok: true });
    if (req.method === 'POST' && origin && origin !== new URL(req.url).origin && !originOk(origin)) return json({ error: 'forbidden' }, 403);
    const league = env.LEAGUE.get(env.LEAGUE.idFromName('main'));
    try {
      if (url.pathname === '/pool' || url.pathname === '/board') {
        // the two public lists are the same for everyone: Cloudflare's edge serves them for 20 s
        const cache = caches.default, key = new Request(url.origin + '/api' + url.pathname + url.search);
        const hit = await cache.match(key).catch(() => null);
        if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...h } });
        const body = url.pathname === '/pool' ? await league.pool() : await league.board(url.searchParams.get('day') || dayKey());
        const res = new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=20' } });
        ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
        return new Response(res.body, { headers: { ...Object.fromEntries(res.headers), ...h } });
      }
      const ip = req.headers.get('cf-connecting-ip') || '';
      const auth = { id: req.headers.get('x-player') || '', secret: req.headers.get('x-secret') || '' };
      if (url.pathname === '/join' && req.method === 'POST') return json(await league.join((await req.json().catch(() => ({}))).name, ip));
      if (url.pathname === '/draft' && req.method === 'POST') return json(await league.draft(auth, (await req.json().catch(() => ({}))).mints));
      if (url.pathname === '/me') return json(await league.me(auth));
      if (url.pathname === '/entry') return json(await league.entry(url.searchParams.get('id') || ''));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e?.userMessage || 'Something went wrong — try again' }, e?.userMessage ? 400 : 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.LEAGUE.get(env.LEAGUE.idFromName('main')).refresh());
  },
};

const userErr = (m) => Object.assign(new Error(m), { userMessage: m });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
const rid = (n = 8) => hex(crypto.getRandomValues(new Uint8Array(n)));

export class League extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.fetchFn = (...a) => fetch(...a);
    this.joins = new Map();   // ip → [ms] (sign-up throttle, in memory)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT NOT NULL, lname TEXT UNIQUE NOT NULL, secret TEXT NOT NULL, created INTEGER, wallet TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS coins (mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, image TEXT, url TEXT, price REAL, liq REAL, mcap REAL, vol1h REAL, chg1h REAL, chg24h REAL, created INTEGER, updated INTEGER, dead INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pool (mint TEXT PRIMARY KEY, rank INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, player TEXT NOT NULL, day TEXT NOT NULL, created INTEGER, ends INTEGER, score REAL DEFAULT 0, final INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS entries_player_day ON entries (player, day)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS entries_day_score ON entries (day, score DESC)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS picks (entry TEXT NOT NULL, mint TEXT NOT NULL, start REAL NOT NULL, PRIMARY KEY (entry, mint))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  }

  rows(q, ...b) { return this.sql.exec(q, ...b).toArray(); }

  // ---------------------------------------------------------------- market refresh (cron, every 5 min)
  async refresh(now = Date.now()) {
    if (this._busy) return { busy: true };
    this._busy = true;
    try {
      const { mints: found, errors } = await discover(this.fetchFn);
      // coins in teams that are still running must keep updating, plus everything currently in the pool
      const live = this.rows(`SELECT DISTINCT p.mint FROM picks p JOIN entries e ON e.id = p.entry WHERE e.final = 0`).map((r) => r.mint);
      const inPool = this.rows(`SELECT mint FROM pool`).map((r) => r.mint);
      const q = await quotes([...found, ...live, ...inPool], this.fetchFn);
      for (const c of q.values()) this._saveCoin(c, now);
      // a running pick DexScreener no longer knows, or whose liquidity is gone: rugged / dead
      for (const m of live) {
        const c = q.get(m);
        if (!c) { const was = this.rows(`SELECT updated FROM coins WHERE mint = ?`, m)[0]; if (was && now - was.updated > 3600000) this.sql.exec(`UPDATE coins SET dead = 1 WHERE mint = ?`, m); }
      }
      const pool = rankPool([...q.values()], now);
      if (pool.length >= TEAM_SIZE * 2) {   // never replace a good pool with an empty one when the feeds hiccup
        this.sql.exec(`DELETE FROM pool`);
        pool.forEach((c, i) => this.sql.exec(`INSERT INTO pool (mint, rank) VALUES (?, ?)`, c.mint, i));
      }
      this._rescore(now);
      this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('refreshed', ?), ('errors', ?)`, String(now), JSON.stringify(errors.slice(0, 5)));
      // keep the coin table small: forget coins not in any team or the pool for 3 days
      this.sql.exec(`DELETE FROM coins WHERE updated < ? AND mint NOT IN (SELECT mint FROM picks) AND mint NOT IN (SELECT mint FROM pool)`, now - 3 * 86400000);
      return { pool: pool.length, quoted: q.size, errors };
    } finally { this._busy = false; }
  }

  _saveCoin(c, now) {
    const dead = c.liq < RULES.deadLiq ? 1 : 0;
    this.sql.exec(`INSERT INTO coins (mint, name, symbol, image, url, price, liq, mcap, vol1h, chg1h, chg24h, created, updated, dead) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(mint) DO UPDATE SET name=excluded.name, symbol=excluded.symbol, image=excluded.image, url=excluded.url, price=excluded.price, liq=excluded.liq, mcap=excluded.mcap,
      vol1h=excluded.vol1h, chg1h=excluded.chg1h, chg24h=excluded.chg24h, created=CASE WHEN coins.created > 0 THEN coins.created ELSE excluded.created END, updated=excluded.updated, dead=excluded.dead`,
    c.mint, c.name, c.symbol, c.image, c.url, c.price, c.liq, c.mcap, c.vol1h, c.chg1h, c.chg24h, c.created, now, dead);
  }

  // live scores for running teams; teams past 24 h get their final score
  _rescore(now) {
    const ents = this.rows(`SELECT id, ends FROM entries WHERE final = 0`);
    for (const e of ents) {
      const picks = this.rows(`SELECT p.start, c.price AS cur, c.dead FROM picks p LEFT JOIN coins c ON c.mint = p.mint WHERE p.entry = ?`, e.id)
        .map((r) => ({ start: r.start, cur: r.cur ?? r.start, dead: !!r.dead }));
      this.sql.exec(`UPDATE entries SET score = ?, final = ? WHERE id = ?`, teamScore(picks), e.ends <= now ? 1 : 0, e.id);
    }
  }

  // ---------------------------------------------------------------- public reads
  pool() {
    const coins = this.rows(`SELECT c.mint, c.name, c.symbol, c.image, c.url, c.price, c.liq, c.mcap, c.vol1h, c.chg1h, c.created FROM pool p JOIN coins c ON c.mint = p.mint ORDER BY p.rank`);
    const at = +(this.rows(`SELECT v FROM meta WHERE k = 'refreshed'`)[0]?.v || 0);
    return { coins, refreshed: at, teamSize: TEAM_SIZE };
  }

  board(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = dayKey();
    const top = this.rows(`SELECT e.id, e.score, e.final, e.created, e.ends, pl.name FROM entries e JOIN players pl ON pl.id = e.player WHERE e.day = ? ORDER BY e.score DESC, e.created ASC LIMIT 100`, day);
    for (const t of top) t.picks = this.rows(`SELECT c.symbol, c.image FROM picks p LEFT JOIN coins c ON c.mint = p.mint WHERE p.entry = ?`, t.id);
    const count = this.rows(`SELECT COUNT(*) AS n FROM entries WHERE day = ?`, day)[0]?.n || 0;
    return { day, count, top };
  }

  entry(id) {
    const e = this.rows(`SELECT e.id, e.score, e.final, e.created, e.ends, e.day, pl.name FROM entries e JOIN players pl ON pl.id = e.player WHERE e.id = ?`, String(id))[0];
    if (!e) throw userErr('Team not found');
    e.picks = this._picks(e.id);
    return e;
  }

  _picks(entry) {
    return this.rows(`SELECT p.mint, p.start, c.price AS cur, c.dead, c.symbol, c.name, c.image, c.url FROM picks p LEFT JOIN coins c ON c.mint = p.mint WHERE p.entry = ?`, entry)
      .map((r) => ({ ...r, dead: !!r.dead, pct: Math.round(pickScore(r.start, r.cur ?? r.start, !!r.dead) * 10) / 10 }));
  }

  // ---------------------------------------------------------------- players
  async join(name, ip = '', now = Date.now()) {
    const n = cleanName(name);
    if (!n || !nameAllowed(n)) throw userErr('Nickname: 3–16 letters, numbers or _');
    const recent = (this.joins.get(ip) || []).filter((t) => now - t < 3600000);
    if (ip && recent.length >= 8) throw userErr('Too many new players from this network — try later');
    if (this.rows(`SELECT 1 FROM players WHERE lname = ?`, n.toLowerCase()).length) throw userErr('That nickname is taken');
    const id = rid(6), secret = rid(16);
    this.sql.exec(`INSERT INTO players (id, name, lname, secret, created) VALUES (?, ?, ?, ?, ?)`, id, n, n.toLowerCase(), await sha(secret), now);
    recent.push(now); this.joins.set(ip, recent);
    return { id, secret, name: n };
  }

  async _player(auth) {
    const p = this.rows(`SELECT id, name, secret FROM players WHERE id = ?`, String(auth?.id || ''))[0];
    if (!p || p.secret !== await sha(String(auth?.secret || ''))) throw userErr('Sign in again');
    return p;
  }

  async me(auth, now = Date.now()) {
    const p = await this._player(auth);
    const ents = this.rows(`SELECT id, day, score, final, created, ends FROM entries WHERE player = ? ORDER BY created DESC LIMIT 14`, p.id);
    for (const e of ents) e.picks = this._picks(e.id);
    const today = ents.find((e) => e.day === dayKey(now)) || null;
    let rank = null;
    if (today) rank = 1 + (this.rows(`SELECT COUNT(*) AS n FROM entries WHERE day = ? AND score > ?`, today.day, today.score)[0]?.n || 0);
    return { name: p.name, today, rank, history: ents };
  }

  // ---------------------------------------------------------------- draft
  async draft(auth, mints, now = Date.now()) {
    const p = await this._player(auth);
    const day = dayKey(now);
    if (this.rows(`SELECT 1 FROM entries WHERE player = ? AND day = ?`, p.id, day).length) throw userErr('You already drafted today — come back tomorrow');
    const poolSet = new Set(this.rows(`SELECT mint FROM pool`).map((r) => r.mint));
    const err = draftError(mints, poolSet);
    if (err) throw userErr(err);
    // start prices: a fresh quote right now (falls back to the last refresh if DexScreener is slow)
    let fresh = new Map();
    try { fresh = await quotes(mints, this.fetchFn); } catch { /* use stored prices */ }
    const start = [];
    for (const m of mints) {
      const f = fresh.get(m);
      if (f && f.price > 0) { this._saveCoin(f, now); start.push(f.price); continue; }
      const c = this.rows(`SELECT price FROM coins WHERE mint = ?`, m)[0];
      if (!c || !(c.price > 0)) throw userErr('Couldn’t price one of your coins — try again');
      start.push(c.price);
    }
    const id = rid(6);
    this.sql.exec(`INSERT INTO entries (id, player, day, created, ends, score, final) VALUES (?, ?, ?, ?, ?, 0, 0)`, id, p.id, day, now, now + ROUND_MS);
    mints.forEach((m, i) => this.sql.exec(`INSERT INTO picks (entry, mint, start) VALUES (?, ?, ?)`, id, m, start[i]));
    return this.entry(id);
  }
}
