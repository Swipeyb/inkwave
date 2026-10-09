// The prize ledger: one instance for the whole relay (the `Prizes` Durable Object in index.js), so commits, cooldowns,
// pool reads and payouts are serialised across every room and the treasury is never double-spent. Storage / fetch /
// clock are injected, so server/test/ledger.test.mjs runs it in plain Node with a fake RPC.
import { prizeConfig, publicConfig, newSeedHex, commitOf, roundBlock, eligibleCandidates, drawRound, prizeEstimate, bothSidesBlock, effectiveMinHolding } from './prize-core.js';
import { getBalanceLamports, getTokenHolding, parseSecretKey, importSigner, sendTransfer, sendTransfers, parsePubkey, LAMPORTS_PER_SOL, b58encode } from './solana.js';
import { MIN_PRIZE_LAMPORTS } from './prize-core.js';

const POOL_TTL = 30000, LOG_KEEP = 500;

export class PrizeLedger {
  constructor({ env = {}, storage, fetchFn = (...a) => fetch(...a), now = () => Date.now(), log = (o) => console.log(JSON.stringify(o)) }) {
    this.env = env;
    this.cfg = prizeConfig(env);
    this.storage = storage;
    this.fetchFn = fetchFn;
    this.now = now;
    this.log = log;
    this._pool = null;   // { lamports, at }
    this._chain = Promise.resolve();
    this._signer = null;
  }

  // one settle at a time (each reads the pool, pays, then the next one reads the new balance)
  _serial(fn) { const p = this._chain.then(fn, fn); this._chain = p.catch(() => {}); return p; }

  async pool(fresh = false) {
    if (!this.cfg.enabled) return null;
    if (!fresh && this._pool && this.now() - this._pool.at < POOL_TTL) return this._pool.lamports;
    const lamports = await getBalanceLamports(this.cfg.rpcUrl, this.cfg.treasury, this.fetchFn);
    this._pool = { lamports, at: this.now() };
    return lamports;
  }

  async status() {
    const out = { ...publicConfig(this.cfg), poolSol: null };
    if (!this.cfg.enabled) return out;
    try {
      const lamports = await this.pool();
      out.poolSol = lamports / LAMPORTS_PER_SOL;
      const est = prizeEstimate(lamports, this.cfg);
      out.prizeMinSol = est.minSol; out.prizeMaxSol = est.maxSol;   // what the next match would pay (lobby card)
      if (this.cfg.mint) { out.minHolding = await this.minHolding(); out.priceUsd = await this.price(); }
    } catch (e) { out.poolError = String(e.message || e); }
    return out;
  }

  /** $SPLURT price in USD (Jupiter price API by default), cached a minute; null when unknown. */
  async price() {
    const cfg = this.cfg;
    if (!cfg.mint || !(cfg.minHoldingUsd > 0)) return null;
    if (this._price && this.now() - this._price.at < 60000) return this._price.usd;
    let usd = null;
    try {
      const r = await this.fetchFn(cfg.priceUrl + cfg.mint, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        const v = Number(j?.[cfg.mint]?.usdPrice ?? j?.data?.[cfg.mint]?.price ?? NaN);
        if (Number.isFinite(v) && v > 0) usd = v;
      }
    } catch { /* keep the last known price */ }
    if (usd == null && this._price) usd = this._price.usd;
    this._price = { usd, at: this.now() };
    return usd;
  }
  /** Tokens a wallet must hold right now (dollar-based when MIN_HOLDING_USD is set). */
  async minHolding() { return effectiveMinHolding(this.cfg, await this.price()); }

  /** Holders-only rooms: does this wallet hold the current minimum of TOKEN_MINT? (No mint / no minimum: everyone passes.) */
  async holds(wallet) {
    const cfg = this.cfg, need = await this.minHolding();
    if (!cfg.mint || !(need > 0)) return { ok: true, checked: false };
    let amount = 0;
    try { amount = await getTokenHolding(cfg.rpcUrl, wallet, cfg.mint, this.fetchFn); } catch (e) { return { ok: false, error: 'could not check the holding: ' + (e.message || e) }; }
    return { ok: amount >= need, amount, need, checked: true };
  }

  async recent(limit = 50) {
    const m = await this.storage.list({ prefix: 'log:', reverse: true, limit: Math.min(200, limit) });
    return [...m.values()];
  }

  /** Match start: draw and store a seed, publish only its hash. */
  async commit(round, room, humansAtStart, walletsAtStart = humansAtStart) {
    const block = roundBlock(this.cfg, humansAtStart, walletsAtStart);
    if (block) return { round, skip: block };
    const seed = newSeedHex(), hash = await commitOf(seed);
    await this.storage.put('commit:' + round, { seed, hash, room, humansAtStart, at: this.now() });
    let poolSol = null;
    try { poolSol = (await this.pool()) / LAMPORTS_PER_SOL; } catch { /* shown as unknown */ }
    let prizeSol = null;
    if (poolSol != null) { const e = prizeEstimate(poolSol * LAMPORTS_PER_SOL, this.cfg); prizeSol = e.minSol === e.maxSol ? e.minSol : null; }
    return { round, hash, poolSol, prizeSol };
  }

  /**
   * Match end. `players` = the round's humans still connected: [{ id, name, wallet }]; `winners` = agreed ids or null
   * with `voidReason`. Always reveals the seed (so even a void round is auditable), records it, and pays if due.
   */
  settle({ round, players = [], winners = null, voidReason = null }) {
    return this._serial(() => this._settle({ round, players, winners, voidReason }));
  }

  async _settle({ round, players, winners, voidReason }) {
    const c = await this.storage.get('commit:' + round);
    if (!c) return { round, status: 'unknown round' };
    const cfg = this.cfg, now = this.now();
    const rec = { round, room: c.room, at: new Date(now).toISOString(), commit: c.hash, seed: c.seed, mode: cfg.mode, humansAtStart: c.humansAtStart, status: 'void', reason: voidReason || null, prizeSol: 0, winner: null, candidates: [], rejected: [], tx: null };
    if (!voidReason && winners) voidReason = bothSidesBlock(players, winners);
    rec.reason = voidReason || null;
    if (!voidReason && winners) {
      const minHold = await this.minHolding();
      const cooldowns = new Map(), holdings = new Map();
      for (const p of players) {
        if (!p.wallet || !winners.includes(p.id)) continue;
        const t = await this.storage.get('cd:' + p.wallet);
        if (t) cooldowns.set(p.wallet, t);
        if (cfg.mint && minHold > 0) {
          try { holdings.set(p.wallet, await getTokenHolding(cfg.rpcUrl, p.wallet, cfg.mint, this.fetchFn)); } catch { holdings.set(p.wallet, 0); }
        }
      }
      const { candidates, rejected } = eligibleCandidates({ players, winners, cooldowns, holdings, now, cfg: { ...cfg, minHolding: minHold } });
      rec.candidates = candidates.map((x) => x.wallet);
      rec.rejected = rejected;
      let pool = 0;
      try { pool = await this.pool(true); } catch (e) { rec.reason = 'could not read the pool: ' + (e.message || e); }
      rec.poolSol = pool / LAMPORTS_PER_SOL;
      if (!rec.reason) {
        const d = await drawRound(c.seed, pool, candidates, cfg);
        rec.pct = d.pct;
        if (!d.winner) rec.reason = d.reason;
        else {
          // split (default): every eligible holder on the winning team gets an equal share; if a share would be below
          // the minimum transfer, the whole prize goes to the seed's random pick instead (as with PRIZE_SPLIT=one)
          let payees = [d.winner];
          if (cfg.split === 'all' && candidates.length > 1 && Math.floor(d.lamports / candidates.length) >= MIN_PRIZE_LAMPORTS) payees = candidates;
          const each = Math.floor(d.lamports / payees.length);
          rec.lamports = each * payees.length;
          rec.prizeSol = rec.lamports / LAMPORTS_PER_SOL;
          rec.eachSol = each / LAMPORTS_PER_SOL;
          rec.split = payees.length > 1;
          rec.winners = payees.map((p) => ({ id: p.id, name: p.name, wallet: p.wallet, lamports: each }));
          rec.winner = { id: d.winner.id, name: d.winner.name, wallet: d.winner.wallet, index: d.index };
          if (cfg.mode === 'live') {
            try {
              const signer = await this._getSigner();
              const sent = payees.length === 1
                ? await sendTransfer(cfg.rpcUrl, signer, parsePubkey(payees[0].wallet), each, this.fetchFn)
                : await sendTransfers(cfg.rpcUrl, signer, payees.map((p) => ({ to: parsePubkey(p.wallet), lamports: each })), this.fetchFn);
              rec.status = 'paid'; rec.tx = sent.signature;
              this._pool = null;
            } catch (e) { rec.status = 'failed'; rec.reason = 'payout failed: ' + (e.message || e); }
          } else rec.status = 'dry-run';
          if (rec.status !== 'failed') for (const p of payees) await this.storage.put('cd:' + p.wallet, now);
        }
      }
    }
    await this.storage.delete('commit:' + round);   // settled once: the log entry below is the record
    await this.storage.put(`log:${String(now).padStart(15, '0')}:${round}`, rec);
    await this._trim();
    this.log({ prize: rec.status, ...rec });
    return rec;
  }

  async _getSigner() {
    if (this._signer) return this._signer;
    if (!this.env.TREASURY_SECRET_KEY) throw new Error('TREASURY_SECRET_KEY is not set');
    const kp = parseSecretKey(this.env.TREASURY_SECRET_KEY);
    if (b58encode(kp.pubkey) !== this.cfg.treasury) throw new Error('TREASURY_SECRET_KEY does not match TREASURY_PUBLIC_KEY');
    this._signer = await importSigner(kp);
    return this._signer;
  }

  async _trim() {
    const m = await this.storage.list({ prefix: 'log:', reverse: true, limit: LOG_KEEP + 50 });
    const keys = [...m.keys()].slice(LOG_KEEP);
    if (keys.length) await this.storage.delete(keys);
  }
}
