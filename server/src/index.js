// SPLURT online relay (based on the INKWAVE relay) (Cloudflare Worker + Durable Object).
//
//   GET /room/<CODE>?name=<name>&create=1&v=<proto>   (WebSocket upgrade) → the Room object for that code
//   GET /health                                          → "ok"
//   GET /quick[?mode=holders]                            → {"code"} the public Quick Play room to join next
//
// Holders-only rooms ("QH" codes) take a signed wallet proof on the join URL (&wallet=&msg=&sig=, message
//   "SPLURT holder match\nroom: <code>\nwallet: <address>\ntime: <ms>") and, when TOKEN_MINT + MIN_TOKEN_HOLDING are
//   set, an on-chain holding check: every player in them is a verified holder.
//
// Quick Play rooms use 6-character codes starting with "QP" (private codes are 5 characters, so the two never clash).
// Anyone may join a QP room while it isn't mid-match; the first one in becomes its host. The Matchmaker Durable Object
// hands out the fullest open QP room, or a fresh code when every room is full or playing.
//
// A Room is a dumb, fast fan-out: game payloads are forwarded as raw strings (never parsed here). The room only
// tracks membership (id, name, join order), elects the host (the oldest member), and refuses joins that can't work
// (unknown code, full, match in progress). Wire format, client → room:
//   "b|<payload>"          broadcast to everyone else          "s|<toId>|<payload>"   to one member
//   {"t":"lock","v":bool}  host: refuse new joins while a match runs
//   "ping"                 → "pong" (answered by the runtime without waking the room; also the liveness signal)
//   {"t":"ping","c":n}     → {"t":"pong","c":n}   (older clients)
// room → client:
//   "m|<fromId>|<payload>"                                      relayed game payload
//   {"t":"welcome","id","host","members":[{id,name}]}           {"t":"join","m":{id,name}}
//   {"t":"leave","id","host"}                                   {"t":"err","e":"…"} (then close)
//
// Prize pool (optional, docs/PRIZE_POOL.md; off unless SOLANA_RPC_URL + TREASURY_PUBLIC_KEY are configured):
//   GET /prize          → public config + current pool balance        GET /prize/log → recent rounds (seed reveals, txs)
//   client → room: {"t":"wallet","a":"nonce"} → {"t":"wallet","a":"nonce","msg"}   (sign msg with the wallet, then)
//                  {"t":"wallet","a":"prove","pk","sig"} → {"t":"wallet","a":"ok","pk"} | {"t":"wallet","a":"err","e"}
//                  {"t":"result","r":round,"w":[winning human ids]}   every human reports the result it was shown
//   room → client: {"t":"prize","a":"commit","round","hash","poolSol"} | {"t":"prize","a":"skip","reason"} at match
//                  start (host's lock), {"t":"prize","a":"reveal",…ledger record} once the round is settled
import { DurableObject } from 'cloudflare:workers';
import { PrizeLedger } from './ledger.js';
import { prizeConfig, consensus } from './prize-core.js';
import { parsePubkey, verifyEd25519, b64decode } from './solana.js';

const PROTO = 1, MAX = 8;
// Public relay hygiene: only the game's own site may open rooms (plus local dev), each socket gets a message budget
// (the game sends ~25/s; a runaway or hostile client is cut off before it can eat the account's quota) and a size cap.
const ORIGIN_OK = (o) => /^https:\/\/(www\.)?playsplurt\.online$/.test(o)   // SPLURT's site
  || /^https:\/\/([a-z0-9-]+\.)?splurt\.pages\.dev$/.test(o)   // SPLURT's Cloudflare Pages URL + preview deploys
  || /^https:\/\/([a-z0-9-]+\.)?inkwave-aah\.pages\.dev$/.test(o)   // the original INKWAVE site (upstream)
  || /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)(:\d+)?$/.test(o);   // dev + LAN play
const MSG_MAX = 65536, RATE = 90, BURST_STRIKES = 4;
// A socket whose "ping"s stop is a player whose connection died without closing (Wi-Fi gone, laptop lid shut): drop
// them so their squidkid is handed to a bot instead of standing frozen. Clients ping every 2 s; a hidden tab still
// pings (throttled to ≥ 1/min after five minutes), so the lobby allowance is generous.
const SILENT_MATCH = 20000, SILENT_LOBBY = 150000, SWEEP = 4000;   // a heavy transition on a slow machine can freeze a tab for seconds
const CODE = /^[A-Z0-9]{4,8}$/;
export const QUICK_CODE = /^Q[PH][A-Z0-9]{4}$/;     // QP = open Quick Play, QH = holders only
export const HOLDER_CODE = /^QH[A-Z0-9]{4}$/;
export const holderMessage = (code, wallet, time) => `SPLURT holder match\nroom: ${code}\nwallet: ${wallet}\ntime: ${time}`;
const QUICK_CHARS = 'BCEFGHJKLMNPRTUVXYZ23456789';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok', { headers: { 'access-control-allow-origin': '*' } });
    if (url.pathname === '/prize' || url.pathname === '/prize/log') {
      const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
      if (!env.PRIZES || !prizeConfig(env).enabled) return json(url.pathname === '/prize' ? { enabled: false } : []);
      const ledger = env.PRIZES.get(env.PRIZES.idFromName('ledger'));
      return json(url.pathname === '/prize' ? await ledger.status() : await ledger.recent(+(url.searchParams.get('n') || 50)));
    }
    if (url.pathname === '/online') {   // players-online counter: each open game pings every 30 s with a random id
      const origin = req.headers.get('Origin') || '';
      if (!ORIGIN_OK(origin)) return new Response('forbidden', { status: 403 });
      const id = String(url.searchParams.get('id') || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
      const r = await env.PRESENCE.get(env.PRESENCE.idFromName('main')).ping(id);
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, vary: 'Origin', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/quick') {
      const origin = req.headers.get('Origin') || '';
      if (!ORIGIN_OK(origin)) return new Response('forbidden', { status: 403 });
      const r = await env.MATCHMAKER.get(env.MATCHMAKER.idFromName('main')).quick(url.searchParams.get('mode') === 'holders' ? 'QH' : 'QP');
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin, vary: 'Origin', 'cache-control': 'no-store' } });
    }
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (!m) return new Response('SPLURT relay', { status: 404 });
    const code = m[1].toUpperCase();
    if (!CODE.test(code)) return new Response('bad code', { status: 400 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!ORIGIN_OK(req.headers.get('Origin') || '')) return new Response('forbidden', { status: 403 });
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.locked = false;
    this.seq = 0;
    this.seen = new Map();   // ws → last message time (in memory: a busy room never hibernates; a quiet one has the pings)
    this.rate = new Map();   // ws → { t: window start, n: messages in it, strikes }
    this.round = null;       // prize round of the running match: { id, humans: [{id,name,wallet}], reports: Map, settled }
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // hibernation: rebuild the join counter from surviving sockets
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.seq >= this.seq) this.seq = a.seq + 1; }
  }

  members() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, a: ws.deserializeAttachment() })).filter((m) => m.a && !m.a.gone).sort((x, y) => x.a.seq - y.a.seq);
  }
  host() { const ms = this.members(); return ms.length ? ms[0].a.id : null; }

  // Matchmaker → room: how many players, and is a match running? (Durable Object RPC: never reachable from outside)
  status() {
    const ms = this.members();
    return { humans: ms.length, locked: this.locked && ms.length > 0 };
  }

  async fetch(req) {
    const url = new URL(req.url);
    this.code = url.pathname.split('/').pop().toUpperCase();
    const quick = QUICK_CODE.test(this.code);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // `c` is the machine-readable error code (mirrors ERR in ../../src/net/errors.js — the worker is bundled on its
    // own, so the four literals are duplicated here on purpose); `e` stays for older clients and for logs.
    const fail = (c, e) => { server.send(JSON.stringify({ t: 'err', c, e })); server.close(4000, e); return new Response(null, { status: 101, webSocket: client }); };
    const ms = this.members().filter((m) => m.ws !== server);
    const create = url.searchParams.get('create') === '1';
    if (+(url.searchParams.get('v') || 0) !== PROTO) return fail('ERR_STALE', 'Please refresh the page — the game was updated');
    if (!quick && create && ms.length) return fail('ERR_CODE_TAKEN', 'Room code taken');
    if (!quick && !create && !ms.length) return fail('ERR_NOT_FOUND', 'Room not found');
    if (ms.length >= MAX) return fail('ERR_FULL', 'Room is full');
    if (this.locked && ms.length) return fail('ERR_IN_PROGRESS', 'Match in progress');
    if (!ms.length) this.locked = false;
    // holders-only room: the wallet must be proven (signature over this room's code) and, if configured, hold the coin
    let wallet = null;
    if (HOLDER_CODE.test(this.code)) {
      const pk = String(url.searchParams.get('wallet') || ''), key = parsePubkey(pk), msg = String(url.searchParams.get('msg') || '');
      const m = msg.match(/^SPLURT holder match\nroom: ([A-Z0-9]+)\nwallet: (\S+)\ntime: (\d+)$/);
      if (!key || !m || m[1] !== this.code || m[2] !== pk || Math.abs(Date.now() - +m[3]) > 5 * 60000) return fail('ERR_HOLDER_SIG', 'Wallet check failed — try again');
      let sig; try { sig = b64decode(String(url.searchParams.get('sig') || '')); } catch { sig = new Uint8Array(0); }
      if (!(await verifyEd25519(key, msg, sig))) return fail('ERR_HOLDER_SIG', 'Wallet check failed — try again');
      if (ms.some((x) => x.a.wallet === pk)) return fail('ERR_WALLET_DUP', 'That wallet is already in this room');
      const ledger = this._ledger();
      if (ledger) {
        let h;
        try { h = await ledger.holds(pk); } catch (e) { h = { ok: false, error: String(e.message || e) }; }
        if (!h.ok) return fail('ERR_NOT_HOLDER', h.error ? 'Could not check your $SPLURT — try again' : `Hold at least ${Number(h.need).toLocaleString('en-US')} $SPLURT to join holder matches`);
      }
      wallet = pk;
    }
    const name = (url.searchParams.get('name') || 'Player').replace(/[^\p{L}\p{N} ._\-!?']/gu, '').slice(0, 16) || 'Player';
    let id;
    do { id = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (ms.some((m) => m.a.id === id));
    const a = { id, name, seq: this.seq++, at: Date.now(), code: this.code, wallet: wallet || undefined };
    server.serializeAttachment(a);
    const all = [...ms.map((m) => m.a), a];
    server.send(JSON.stringify({ t: 'welcome', id, host: all[0].id, members: all.map(({ id, name }) => ({ id, name })), quick: quick || undefined, holders: HOLDER_CODE.test(this.code) || undefined, wallet: wallet || undefined }));
    const j = JSON.stringify({ t: 'join', m: { id, name } });
    for (const m of ms) try { m.ws.send(j); } catch { /* closing */ }
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP);
    return new Response(null, { status: 101, webSocket: client });
  }

  // liveness sweep (only while the room has members)
  async alarm() {
    const now = Date.now(), limit = this.locked ? SILENT_MATCH : SILENT_LOBBY;
    for (const m of this.members()) {
      const seen = Math.max(m.a.at || 0, this.seen.get(m.ws) || 0, this.ctx.getWebSocketAutoResponseTimestamp(m.ws)?.getTime() || 0);
      if (now - seen > limit) { try { m.ws.close(4001, 'Connection timed out'); } catch { /* gone */ } this._gone(m.ws); }
    }
    if (this.members().length) await this.ctx.storage.setAlarm(Date.now() + SWEEP);
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string') return;
    const me = ws.deserializeAttachment();
    if (!me) return;
    const now = Date.now();
    this.seen.set(ws, now);
    if (msg.length > MSG_MAX) return;                                   // oversized: dropped, never fanned out
    let r = this.rate.get(ws);
    if (!r) this.rate.set(ws, (r = { t: now, n: 0, strikes: 0 }));
    if (now - r.t >= 1000) { r.strikes = r.n > RATE ? r.strikes + 1 : Math.max(0, r.strikes - 1); r.t = now; r.n = 0; }
    if (++r.n > RATE * 3 || r.strikes >= BURST_STRIKES) { try { ws.close(4008, 'Too many messages'); } catch { /* gone */ } this._gone(ws); return; }
    const c = msg.charCodeAt(0);
    if (c === 98 /* b */ && msg.charCodeAt(1) === 124) {
      const out = 'm|' + me.id + '|' + msg.slice(2);
      for (const s of this.ctx.getWebSockets()) if (s !== ws) try { s.send(out); } catch { /* closing */ }
      return;
    }
    if (c === 115 /* s */ && msg.charCodeAt(1) === 124) {
      const k = msg.indexOf('|', 2);
      if (k < 0) return;
      const to = msg.slice(2, k), out = 'm|' + me.id + '|' + msg.slice(k + 1);
      for (const s of this.ctx.getWebSockets()) { const a = s.deserializeAttachment(); if (a && a.id === to) { try { s.send(out); } catch { /* closing */ } break; } }
      return;
    }
    if (c === 123 /* { */) {
      let o; try { o = JSON.parse(msg); } catch { return; }
      if (o.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: o.c }));
      else if (o.t === 'lock' && this.host() === me.id) {
        const was = this.locked;
        this.locked = !!o.v;
        if (this.locked && !was) await this._prizeStart();
        else if (!this.locked && was) await this._prizeSettle();
      } else if (o.t === 'wallet') await this._wallet(ws, me, o);
      else if (o.t === 'result') await this._prizeReport(me, o);
    }
  }

  // ---- prize pool (docs/PRIZE_POOL.md) ------------------------------------------------------------------------------
  _ledger() {
    if (!this.env.PRIZES || !prizeConfig(this.env).enabled) return null;
    return this.env.PRIZES.get(this.env.PRIZES.idFromName('ledger'));
  }
  _send(ws, o) { try { ws.send(JSON.stringify(o)); } catch { /* closing */ } }
  _toAll(o) { const s = JSON.stringify(o); for (const m of this.members()) try { m.ws.send(s); } catch { /* closing */ } }

  // a player proves they own a wallet by signing a one-time message (Phantom / Solflare signMessage); one wallet per
  // player and per room, and it can't change while a match runs
  async _wallet(ws, me, o) {
    if (!this._ledger()) return this._send(ws, { t: 'wallet', a: 'err', e: 'Prizes are off on this server' });
    if (o.a === 'nonce') {
      const n = crypto.randomUUID();
      me.walletMsg = `SPLURT prize wallet check\nroom: ${this.code || me.code}\nplayer: ${me.id}\nnonce: ${n}\n(signing this costs nothing and sends no transaction)`;
      ws.serializeAttachment(me);
      return this._send(ws, { t: 'wallet', a: 'nonce', msg: me.walletMsg });
    }
    if (o.a !== 'prove') return;
    if (HOLDER_CODE.test(this.code || me.code)) return this._send(ws, { t: 'wallet', a: 'err', e: 'Your wallet was checked when you joined this holder match' });
    if (this.locked) return this._send(ws, { t: 'wallet', a: 'err', e: 'Wait for the match to end' });
    const pk = String(o.pk || ''), key = parsePubkey(pk);
    if (!me.walletMsg || !key) return this._send(ws, { t: 'wallet', a: 'err', e: 'Bad wallet proof' });
    let sig;
    try { sig = b64decode(String(o.sig || '')); } catch { sig = new Uint8Array(0); }
    const msg = me.walletMsg;
    me.walletMsg = null;   // one try per nonce
    if (!(await verifyEd25519(key, msg, sig))) { ws.serializeAttachment(me); return this._send(ws, { t: 'wallet', a: 'err', e: 'Signature check failed' }); }
    if (this.members().some((m) => m.ws !== ws && m.a.wallet === pk)) { ws.serializeAttachment(me); return this._send(ws, { t: 'wallet', a: 'err', e: 'That wallet is already in this room' }); }
    me.wallet = pk;
    ws.serializeAttachment(me);
    this._send(ws, { t: 'wallet', a: 'ok', pk });
  }

  // match start (the host locks the room): snapshot the humans and their wallets, get a seed commitment
  async _prizeStart() {
    this.round = null;
    const ledger = this._ledger();
    if (!ledger) return;
    if (!QUICK_CODE.test(this.code || this.members()[0]?.a.code || '')) return;   // private rooms (Create a Room) never carry a prize
    const humans = this.members().map((m) => ({ id: m.a.id, name: m.a.name, wallet: m.a.wallet || null }));
    const id = crypto.randomUUID();
    let c;
    try { c = await ledger.commit(id, this.code || this.members()[0]?.a.code, humans.length, humans.filter((h) => h.wallet).length); } catch (e) { console.error('[prize] commit', e); return; }
    if (c.skip) { this._toAll({ t: 'prize', a: 'skip', reason: c.skip }); return; }
    this.round = { id, humans, reports: new Map(), hash: c.hash, settled: false };
    this._toAll({ t: 'prize', a: 'commit', round: id, hash: c.hash, poolSol: c.poolSol, prizeSol: c.prizeSol });
  }

  async _prizeReport(me, o) {
    const r = this.round;
    if (!r || r.settled || o.r !== r.id || !r.humans.some((h) => h.id === me.id) || r.reports.has(me.id) || !Array.isArray(o.w)) return;
    r.reports.set(me.id, o.w.slice(0, 8).map(String));
    const here = new Set(this.members().map((m) => m.a.id));
    if (r.humans.filter((h) => here.has(h.id)).every((h) => r.reports.has(h.id))) await this._prizeSettle();
  }

  // everyone still here has reported (or the host unlocked the room): agree on the winners, let the ledger draw / pay
  async _prizeSettle() {
    const r = this.round, ledger = this._ledger();
    if (!r || r.settled || !ledger) return;
    r.settled = true;
    const here = new Set(this.members().map((m) => m.a.id));
    const players = r.humans.filter((h) => here.has(h.id));   // left before the end: not eligible
    const agreed = consensus(r.reports, players.map((h) => h.id));
    let rec;
    try { rec = await ledger.settle({ round: r.id, players, winners: agreed.winners || null, voidReason: agreed.error || null }); } catch (e) { console.error('[prize] settle', e); return; }
    const { candidates, rejected, ...pub } = rec;
    this._toAll({ t: 'prize', a: 'reveal', ...pub, candidates: candidates?.length || 0 });
  }

  async webSocketClose(ws) { this._gone(ws); }
  async webSocketError(ws) { this._gone(ws); }

  _gone(ws) {
    this.seen.delete(ws); this.rate.delete(ws);
    const a = ws.deserializeAttachment();
    if (!a || a.gone) return;
    a.gone = true;
    try { ws.serializeAttachment(a); } catch { /* already closed */ }
    const host = this.host();
    const out = JSON.stringify({ t: 'leave', id: a.id, host });
    for (const m of this.members()) try { m.ws.send(out); } catch { /* closing */ }
    if (!this.members().length) this.locked = false;
    // a player leaving mid-round no longer needs to report: settle if everyone left has
    const r = this.round;
    if (r && !r.settled && r.reports.size && r.humans.filter((h) => this.members().some((m) => m.a.id === h.id)).every((h) => r.reports.has(h.id))) this._prizeSettle().catch((e) => console.error('[prize] settle', e));
  }
}

// Players online: a single Durable Object that remembers which game tabs pinged in the last 75 s (in memory only).
export class Presence extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.seen = new Map(); }
  ping(id) {
    const now = Date.now();
    if (id && id.length >= 8 && (this.seen.has(id) || this.seen.size < 50000)) this.seen.set(id, now);
    if (!this._swept || now - this._swept > 10000) { for (const [k, t] of this.seen) if (now - t > 75000) this.seen.delete(k); this._swept = now; }
    return { online: this.seen.size };
  }
}

// Quick Play matchmaking: one Durable Object for the whole relay. Keeps a short list of public rooms and sends each new
// player to the fullest one that has space and isn't mid-match (counting players already on their way in, so a burst
// of clicks doesn't overfill a room), or to a fresh code.
export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = [];   // [{ code, at, coming: [ms] }]
  }
  async quick(prefix = 'QP') {
    prefix = prefix === 'QH' ? 'QH' : 'QP';
    const now = Date.now();
    let best = null, bestN = -1;
    const keep = [];
    for (const r of this.rooms.slice(-48)) {
      if (!r.code.startsWith(prefix)) { keep.push(r); continue; }
      r.coming = r.coming.filter((t) => now - t < 20000);
      let st;
      try { st = await this.env.ROOMS.get(this.env.ROOMS.idFromName(r.code)).status(); } catch { continue; }
      if (!st.humans && !r.coming.length && now - r.at > 30000) continue;   // empty and nobody on the way: forget it
      keep.push(r);
      const n = Math.max(st.humans, r.coming.length);   // (sent here in the last 20 s ≈ joined or still connecting)
      if (st.locked || n >= MAX) continue;
      if (n > bestN) { best = r; bestN = n; }
    }
    this.rooms = keep;
    if (!best) {
      let code;
      do { code = prefix + Array.from({ length: 4 }, () => QUICK_CHARS[(Math.random() * QUICK_CHARS.length) | 0]).join(''); } while (this.rooms.some((r) => r.code === code));
      best = { code, at: now, coming: [] };
      this.rooms.push(best);
    }
    best.coming.push(now);
    return { code: best.code };
  }
}

// The prize ledger: a single Durable Object for the whole relay (commits, cooldowns, payouts; see ledger.js).
export class Prizes extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ledger = new PrizeLedger({ env, storage: ctx.storage });
  }
  status() { return this.ledger.status(); }
  holds(wallet) { return this.ledger.holds(wallet); }
  recent(n) { return this.ledger.recent(n); }
  commit(round, room, humans) { return this.ledger.commit(round, room, humans); }
  settle(input) { return this.ledger.settle(input); }
}
