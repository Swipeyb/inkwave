// Quick Play lobby strip: "QUICK PLAY · 3/8 players · starting in 0:24" across the top of a public room's lobby.
// Reads G.net (session.js: quick, lobby.players, quickStartIn()); inert in private rooms and offline.
import { G } from '../core/ctx.js';

const CSS = `
.iw-quick { position: fixed; left: 50%; top: max(12px, env(safe-area-inset-top, 0px)); transform: translateX(-50%); z-index: 41;
  display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-radius: 999px; pointer-events: none;
  background: rgba(20, 16, 32, .9); box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .14), 0 8px 24px rgba(0, 0, 0, .35);
  color: #fff; font: 600 14px/1.2 Rubik, system-ui, sans-serif; white-space: nowrap; transition: opacity .25s; }
.iw-quick[hidden] { display: flex; opacity: 0; }
.iw-quick b { font: 400 15px/1 'Titan One', Rubik, sans-serif; letter-spacing: .06em; color: var(--a-light, #8cf5cf); }
.iw-quick__t { font-variant-numeric: tabular-nums; color: #ffd27a; }
.iw-quick__dot { width: 8px; height: 8px; border-radius: 50%; background: #2ee67a; animation: iw-quick-pulse 1.2s ease-in-out infinite; }
@keyframes iw-quick-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .iw-quick__dot { animation: none; } }
`;

class QuickStrip {
  constructor(net) {
    this.net = net;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.el = document.createElement('div'); this.el.className = 'iw-quick'; this.el.hidden = true;
    document.body.appendChild(this.el);
    this._last = '';
    setInterval(() => this.render(), 250);
  }
  render() {
    const n = this.net, show = !!n.quick && n.state === 'lobby';
    this.el.hidden = !show;
    if (!show) return;
    const players = n.lobby?.players?.length || 0, max = n.lobby?.maxPlayers || 8;
    const s = n.quickStartIn?.();
    const sec = s == null ? 0 : Math.ceil(s);
    const when = s == null ? 'waiting for 1 more player' : s < 0.5 ? 'starting…' : `starting in <span class="iw-quick__t">${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}</span>`;
    const html = `<i class="iw-quick__dot"></i><b>QUICK PLAY</b><span>${players}/${max} players</span><span>·</span><span>${when}</span>`;
    if (html !== this._last) { this.el.innerHTML = html; this._last = html; }
  }
}

export function installQuickPlay() {
  if (!G.net?.on || typeof document === 'undefined') return null;
  if (!G.quick) G.quick = new QuickStrip(G.net);
  return G.quick;
}
