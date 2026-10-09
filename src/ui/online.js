// Players-online pill ("● 12 online") on the title and Online screens. Every open game pings the relay's /online
// every 30 s with a random per-tab id; the relay counts tabs seen in the last 75 s. Inert if the relay is unreachable.
import { G } from '../core/ctx.js';
import { relayURL } from '../net/transport.js';

const CSS = `
.iw-online-pill { position: fixed; left: 50%; top: max(14px, env(safe-area-inset-top, 0px)); transform: translateX(-50%); z-index: 45;
  display: flex; align-items: center; gap: 7px; padding: 6px 13px; border-radius: 999px; pointer-events: none;
  background: rgba(20, 16, 32, .82); box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .12); color: #fff;
  font: 600 13px/1 Rubik, system-ui, sans-serif; font-variant-numeric: tabular-nums; transition: opacity .25s; }
.iw-online-pill[hidden] { display: flex; opacity: 0; }
.iw-online-pill i { width: 8px; height: 8px; border-radius: 50%; background: #2ee67a; box-shadow: 0 0 8px #2ee67a; animation: iw-online-pulse 1.6s ease-in-out infinite; }
.iw-online-pill b { font-weight: 800; }
@keyframes iw-online-pulse { 50% { opacity: .4; } }
@media (prefers-reduced-motion: reduce) { .iw-online-pill i { animation: none; } }
`;

function tabId() {
  try { let v = sessionStorage.getItem('splurt.tab'); if (!v) { v = crypto.randomUUID().replace(/-/g, '').slice(0, 20); sessionStorage.setItem('splurt.tab', v); } return v; } catch { return crypto.randomUUID().replace(/-/g, '').slice(0, 20); }
}

export function installOnline() {
  if (typeof document === 'undefined' || G.onlinePill) return G.onlinePill;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const el = document.createElement('div'); el.className = 'iw-online-pill'; el.hidden = true;
  document.body.appendChild(el);
  const id = tabId();
  let count = null;
  const ping = async () => {
    if (document.hidden) return;
    try {
      const r = await fetch(relayURL().replace(/^ws/, 'http') + '/online?id=' + id, { cache: 'no-store' });
      if (r.ok) count = (await r.json()).online;
    } catch { /* relay unreachable: keep the last number */ }
  };
  ping();
  setInterval(ping, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
  setInterval(() => {
    const scr = G.game?.menus?.current;
    const show = count > 0 && (scr === 'title' || scr === 'online');
    el.hidden = !show;
    if (show) { const html = `<i></i><b>${count.toLocaleString('en-US')}</b> online`; if (el.innerHTML !== html) el.innerHTML = html; }
  }, 400);
  return (G.onlinePill = el);
}
