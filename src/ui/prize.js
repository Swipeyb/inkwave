// Optional $SPLURT (Solana) prize pool UI (docs/PRIZE_POOL.md). Completely inert unless the relay says the pool is enabled
// (GET <relay>/prize): no requests at all while offline, nothing on screen in solo play.
//
//   online lobby  → a small card: pool balance, prize range, "Connect wallet" (Phantom / Solflare / any injected
//                   Solana wallet), then your short address once the relay has verified a signed one-time message
//   match start   → a toast with the round's commitment (sha256 of the seed the prize will be drawn from)
//   results       → a banner with the round's prize and who won it (or why there was none), plus the seed reveal
//
// The wallet only ever signs a plain-text message (no transaction, no approval of spending): the relay checks the
// signature and pays prizes from its own treasury.
import { G } from '../core/ctx.js';
import { relayURL } from '../net/transport.js';

const POLL = 30000;
const CSS = `
.iw-prize, .iw-prize-banner { --u: min(1vw, 1.7778vh); }
.iw-prize { position: fixed; right: calc(var(--u) * 1.6); top: calc(var(--u) * 23); z-index: 40; pointer-events: auto;
  width: auto; max-width: 250px; padding: 8px 12px; border-radius: 12px; background: rgba(20, 16, 32, .88);
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .12), 0 8px 24px rgba(0, 0, 0, .35); color: #fff;
  font: 600 var(--fs-s, 13px)/1.35 Rubik, system-ui, sans-serif; transition: opacity .25s, transform .25s var(--out, ease); }
.iw-prize[hidden] { display: block; opacity: 0; transform: translateY(12px); pointer-events: none; }
.iw-prize__k { font: 400 var(--fs-xs, 11px)/1 'Titan One', Rubik, sans-serif; letter-spacing: .08em; color: var(--muted, #c3bdd6); text-transform: uppercase; }
.iw-prize__pool { font: 400 var(--fs-l, 18px)/1.2 'Titan One', Rubik, sans-serif; color: var(--a-light, #ffc48a); margin: 2px 0 4px; }
.iw-prize__tag { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: rgba(255, 255, 255, .12); font: 600 10px/1.5 Rubik, sans-serif; color: #fff; vertical-align: middle; letter-spacing: .04em; }
.iw-prize__note { font-size: var(--fs-xs, 11px); color: var(--muted, #c3bdd6); font-weight: 500; }
.iw-prize__btn { margin-top: 6px; width: 100%; padding: 6px 10px; border: 0; border-radius: 10px; cursor: pointer;
  background: var(--a, #22e0a1); color: var(--a-ink, #15121c); font: 700 var(--fs-s, 13px)/1.2 Rubik, sans-serif; }
.iw-prize__btn:disabled { opacity: .6; cursor: default; }
.iw-prize__wallet { margin-top: 4px; font-family: ui-monospace, monospace; font-size: var(--fs-xs, 11px); }
.iw-prize__err { margin-top: 6px; color: #ff8fa3; font-size: var(--fs-xs, 11px); }
.iw-prize-banner { position: fixed; left: 50%; top: calc(var(--u) * 1.4); transform: translateX(-50%); z-index: 45; pointer-events: none;
  max-width: min(92vw, 720px); padding: 10px 18px; border-radius: 14px; background: rgba(20, 16, 32, .9); color: #fff; text-align: center;
  box-shadow: inset 0 0 0 2px rgba(255, 196, 138, .4), 0 8px 24px rgba(0, 0, 0, .35); font: 600 var(--fs-m, 14px)/1.35 Rubik, system-ui, sans-serif;
  transition: opacity .3s; }
.iw-prize-banner[hidden] { display: block; opacity: 0; }
.iw-prize-banner b { font: 400 1.15em/1.2 'Titan One', Rubik, sans-serif; color: var(--a-light, #ffc48a); font-weight: 400; }
.iw-prize-banner small { display: block; margin-top: 3px; color: var(--muted, #c3bdd6); font: 500 10px/1.3 ui-monospace, monospace; word-break: break-all; }
`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');
const sol = (n) => (n == null ? '—' : n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toFixed(4));
const relayHTTP = () => relayURL().replace(/^ws/, 'http');

/** The injected Solana wallet, if any (Phantom, Solflare, Backpack… all expose this shape). */
export function solanaProvider() {
  const w = typeof window !== 'undefined' ? window : {};
  return w.phantom?.solana || w.solflare || w.backpack?.solana || w.solana || null;
}

function toB64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }

class PrizeUI {
  constructor(net) {
    this.net = net;
    this.info = null;           // GET /prize answer
    this.wallet = null;         // verified address in the current room
    this.busy = false;
    this.err = '';
    this._pollT = null;
    this._bannerT = null;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.el = document.createElement('div'); this.el.className = 'iw-prize'; this.el.hidden = true;
    this.banner = document.createElement('div'); this.banner.className = 'iw-prize-banner'; this.banner.hidden = true;
    document.body.append(this.el, this.banner);
    this.el.addEventListener('click', (e) => { if (e.target.closest('[data-act=connect]')) this.connect(); });
    // keep menu keyboard shortcuts away from the card
    for (const ev of ['keydown', 'pointerdown', 'mousedown']) this.el.addEventListener(ev, (e) => e.stopPropagation());

    net.on('state', ({ state }) => this._state(state));
    // the Online hub shows the pool too (no wallet button there: wallets are checked per room)
    this._fetch();
    setInterval(() => { if (!document.hidden && this._onHub()) this._fetch(); }, POLL);
    let was = false;
    setInterval(() => { const h = this._onHub(); if (h !== was) { was = h; this.render(); } }, 400);
    net.on('wallet', (o) => this._walletMsg(o));
    net.on('prize', (o) => this._prizeMsg(o));
  }

  _state(state) {
    const room = state === 'lobby' || state === 'starting';
    if (state === 'offline' || state === 'error' || state === 'connecting') { this.wallet = null; this.err = ''; }
    if (room && this.net.verifiedWallet) this.wallet = this.net.verifiedWallet;   // holder match: checked on join
    if (room) { this._fetch(); if (!this._pollT) this._pollT = setInterval(() => this._fetch(), POLL); }
    else { clearInterval(this._pollT); this._pollT = null; }
    if (state === 'offline' || state === 'error') this._hideBanner();
    this.render();
  }

  async _fetch() {
    try {
      const r = await fetch(relayHTTP() + '/prize', { cache: 'no-store' });
      this.info = r.ok ? await r.json() : null;
    } catch { this.info = null; }   // older relay / offline: the feature just stays hidden
    this.render();
  }

  // ---- wallet: connect, then sign the relay's one-time message ----
  async connect() {
    const p = solanaProvider();
    if (!p) { window.open('https://phantom.com/download', '_blank', 'noopener'); return; }
    if (this.busy) return;
    this.busy = true; this.err = ''; this.render();
    try {
      const res = await p.connect();
      this._pk = (res?.publicKey || p.publicKey)?.toString();
      if (!this._pk) throw new Error('No wallet address');
      if (!this.net.prizeControl?.({ t: 'wallet', a: 'nonce' })) throw new Error('Not connected to a room');
      // continues in _walletMsg('nonce')
    } catch (e) { this.busy = false; this.err = e?.message || 'Wallet connection cancelled'; this.render(); }
  }

  async _walletMsg(o) {
    if (o.a === 'nonce') {
      try {
        const p = solanaProvider();
        const r = await p.signMessage(new TextEncoder().encode(o.msg), 'utf8');
        const sig = r?.signature || r;
        this.net.prizeControl({ t: 'wallet', a: 'prove', pk: this._pk, sig: toB64(sig) });
      } catch (e) { this.busy = false; this.err = e?.message || 'Signature cancelled'; this.render(); }
      return;
    }
    this.busy = false;
    if (o.a === 'ok') { this.wallet = o.pk; this.err = ''; } else if (o.a === 'err') this.err = o.e || 'Wallet check failed';
    this.render();
  }

  // ---- rounds ----
  _prizeMsg(o) {
    if (o.a === 'commit') this._showBanner(`<b>Prize round</b> — ${o.prizeSol != null ? `${sol(o.prizeSol)} SOL to win` : `${sol(o.poolSol)} SOL in the pool`}<small>commit ${esc(o.hash)}</small>`, 6000);
    else if (o.a === 'skip') this._showBanner(`No prize this round: ${esc(o.reason)}`, 5000);
    else if (o.a === 'reveal') {
      const tag = o.status === 'dry-run' ? ' <span class="iw-prize__tag">DRY RUN</span>' : '';
      const ws = o.winners?.length ? o.winners : o.winner ? [o.winner] : [];
      const me = ws.some((w) => w.wallet === this.wallet);
      const who = ws.length > 1 ? `split ${ws.length} ways (${sol(o.eachSol)} SOL each)${me ? ' — YOU won a share' : ''}`
        : ws[0] ? `→ ${me ? 'YOU' : esc(ws[0].name)} <span style="font-family:ui-monospace,monospace">${esc(shortAddr(ws[0].wallet))}</span>` : '';
      const head = ws.length && (o.status === 'paid' || o.status === 'dry-run')
        ? `<b>${sol(o.prizeSol)} SOL</b> prize ${who}${tag}`
        : o.status === 'failed' ? `Prize payout failed — it will be checked by hand${tag}`
          : `No prize this round: ${esc(o.reason || 'no eligible winner')}${tag}`;
      const tx = o.tx ? ` · tx ${esc(o.tx)}` : '';
      this._showBanner(`${head}<small>seed ${esc(o.seed)}${tx}</small>`, 14000);
      if (o.poolSol != null && this.info) this.info.poolSol = Math.max(0, o.poolSol - (o.status === 'paid' ? o.prizeSol : 0));
    }
  }

  _showBanner(html, ms) {
    this.banner.innerHTML = html; this.banner.hidden = false;
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => this._hideBanner(), ms);
  }
  _hideBanner() { this.banner.hidden = true; clearTimeout(this._bannerT); }

  _onHub() { return G.game?.menus?.current === 'online' && (this.net.state === 'offline' || this.net.state === 'error'); }

  render() {
    const i = this.info, st = this.net.state, hub = this._onHub();
    const show = !!i?.enabled && (st === 'lobby' || st === 'starting' || hub);
    this.el.hidden = !show;
    if (!show) return;
    const tag = i.mode !== 'live' ? '<span class="iw-prize__tag">DRY RUN</span>' : '';
    const holdTxt = i.minHolding > 0 && i.mint ? (i.minHoldingUsd > 0 ? `hold ~$${esc(Number(i.minHoldingUsd).toLocaleString())} of $SPLURT` : `hold ${esc(Math.ceil(Number(i.minHolding)).toLocaleString())} $SPLURT`) : 'connect a wallet';
    const wallet = this.wallet
      ? `<div class="iw-prize__wallet">◎ ${esc(shortAddr(this.wallet))} ✓</div>`
      : `<button class="iw-prize__btn" data-act="connect" ${this.busy ? 'disabled' : ''}>${this.busy ? 'Check your wallet…' : solanaProvider() ? 'Connect wallet to win' : 'Get a Solana wallet'}</button>`;
    const pct = i.minPct === i.maxPct ? `${i.minPct}%` : `${i.minPct}–${i.maxPct}%`;
    // below the reserve there's no prize yet: show the pool itself, and when prizes kick in
    const noPrize = i.prizeMaxSol == null || !i.prizeMaxSol;
    const est = noPrize ? (i.poolSol != null ? `◎ ${sol(i.poolSol)} SOL pool` : 'Pool filling up…')
      : i.prizeMinSol === i.prizeMaxSol ? `◎ ${sol(i.prizeMaxSol)} SOL` : `◎ ${sol(i.prizeMinSol)}–${sol(i.prizeMaxSol)} SOL`;
    const sub = noPrize ? `Prizes start once the pool passes ${i.reserveSol ?? 0.05} SOL` : `Winning holders split it · ${holdTxt}`;
    // the full rules live in the tooltip; the card itself stays two short lines
    this.el.title = `${pct} of the ${sol(i.poolSol)} SOL prize pool (max ${i.maxSol} SOL) per match, split between the wallet holders on the winning team. Needs a holder on each team.`;
    this.el.innerHTML = `<div class="iw-prize__k">${noPrize ? 'Prize pool' : hub ? 'Next match prize' : 'Prize this match'}${tag}</div>
      <div class="iw-prize__pool">${est}</div>
      <div class="iw-prize__note">${sub}</div>
      ${hub ? '' : wallet}${this.err && !hub ? `<div class="iw-prize__err">${esc(this.err)}</div>` : ''}`;
  }
}

/** For holder matches (session.quickPlay): connect the wallet, then sign the room's join message. */
export const holderWallet = {
  async connect() {
    const p = solanaProvider();
    if (!p) { const e = new Error('No Solana wallet in this browser'); e.code = 'ERR_NO_WALLET'; throw e; }
    const res = await p.connect();
    const pk = (res?.publicKey || p.publicKey)?.toString();
    if (!pk) throw new Error('No wallet address');
    return pk;
  },
  async sign(msg) {
    const r = await solanaProvider().signMessage(new TextEncoder().encode(msg), 'utf8');
    return toB64(r?.signature || r);
  },
};

export function installPrize() {
  if (!G.net?.on || typeof document === 'undefined') return null;
  if (!G.prize) G.prize = new PrizeUI(G.net);
  return G.prize;
}
