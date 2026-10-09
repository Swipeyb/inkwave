// The prize ledger: one instance for the whole relay (the `Prizes` Durable Object in index.js), so commits, cooldowns,
// pool reads and payouts are serialised across every room and the treasury is never double-spent. Storage / fetch /
// clock are injected, so server/test/ledger.test.mjs runs it in plain Node with a fake RPC.
import { prizeConfig, publicConfig, newSeedHex, commitOf, roundBlock, eligibleCandidates, drawRound, prizeEstimate } from './prize-core.js';
import { getBalanceLamports, getTokenHolding, parseSecretKey, importSigner, sendTransfer, parsePubkey, LAMPORTS_PER_SOL, b58encode } from './solana.js';

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
    } catch (e) { out.poolError = String(e.message || e); }
    return out;
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
    if (!voidReason && winners) {
      const cooldowns = new Map(), holdings = new Map();
      for (const p of players) {
        if (!p.wallet || !winners.includes(p.id)) continue;
        const t = await this.storage.get('cd:' + p.wallet);
        if (t) cooldowns.set(p.wallet, t);
        if (cfg.mint && cfg.minHolding > 0) {
          try { holdings.set(p.wallet, await getTokenHolding(cfg.rpcUrl, p.wallet, cfg.mint, this.fetchFn)); } catch { holdings.set(p.wallet, 0); }
        }
      }
      const { candidates, rejected } = eligibleCandidates({ players, winners, cooldowns, holdings, now, cfg });
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
          rec.prizeSol = d.lamports / LAMPORTS_PER_SOL;
          rec.lamports = d.lamports;
          rec.winner = { id: d.winner.id, name: d.winner.name, wallet: d.winner.wallet, index: d.index };
          if (cfg.mode === 'live') {
            try {
              const sent = await sendTransfer(cfg.rpcUrl, await this._getSigner(), parsePubkey(d.winner.wallet), d.lamports, this.fetchFn);
              rec.status = 'paid'; rec.tx = sent.signature;
              this._pool = null;
            } catch (e) { rec.status = 'failed'; rec.reason = 'payout failed: ' + (e.message || e); }
          } else rec.status = 'dry-run';
          if (rec.status !== 'failed') await this.storage.put('cd:' + d.winner.wallet, now);
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
