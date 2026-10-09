// Live smoke test against the deployed site: sign up a throwaway player, join a 1-hour sprint, draft 5 coins, check the
// room goes live with real start prices. node tools/smoke.mjs https://draftpump.playsplurt.online
const base = (process.argv[2] || 'https://draftpump.playsplurt.online') + '/api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);   // annotations are readable via the API
process.on('unhandledRejection', (e) => { console.log(process.env.GITHUB_ACTIONS ? `::error::${e.message}` : e); process.exit(1); });
async function api(path, { method = 'GET', body, auth } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) { headers['x-player'] = auth.id; headers['x-secret'] = auth.secret; }
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status} ${j.error || ''}`);
  return j;
}
const pool = await api('/pool');
say(`pool: ${pool.coins.length} coins, refreshed ${Math.round((Date.now() - pool.refreshed) / 1000)}s ago; top: ${pool.coins.slice(0, 5).map((c) => '$' + c.symbol).join(' ')}`);
const me = await api('/join', { method: 'POST', body: { name: 'smoke_' + Math.random().toString(36).slice(2, 8) } });
const { room } = await api('/queue', { method: 'POST', body: { mode: 'sprint' }, auth: me });
say('room ' + room);
let v, t0 = Date.now();
while (Date.now() - t0 < 6 * 60000) {
  v = await api(`/room/${room}`, { auth: me });
  if (v.phase === 'draft' && !v.myWant) {
    const c = v.pool.find((x) => !x.takenBy);
    v = await api(`/room/${room}/pick`, { method: 'POST', body: { mint: c.mint }, auth: me });
    say(`round ${v.round} picked $${c.symbol}`);
  }
  if (v.phase === 'live' || v.phase === 'final') break;
  await sleep(1500);
}
if (v.phase !== 'live') throw new Error('room never went live: ' + v.phase);
const mine = v.seats.find((s) => s.me);
say(`live! lineup: ${mine.lineup.map((c) => `$${c.symbol} ${c.pct}%`).join(', ')} | score ${mine.score} | place ${mine.place}`);
if (mine.lineup.length !== 5 || mine.lineup.some((c) => c.pct == null)) throw new Error('lineup not priced');
say('events: ' + v.events.map((e) => e.k + (e.name ? ':' + e.name : '')).join(' '));
say('SMOKE OK');
