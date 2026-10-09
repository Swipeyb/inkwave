// DRAFTPUMP front end: a memecoin "sportsbook". Plain ES module; hash routes #/board #/standings #/me #/team/<id>.
const API = '/api';
const TEAM = 5;
const $ = (id) => document.getElementById(id);
const $view = $('view');

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (v) => `${v > 0 ? '+' : ''}${(Math.round((v || 0) * 10) / 10).toFixed(1)}%`;
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const usd = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v || 0)}`);
const age = (t) => { const m = Math.max(0, (Date.now() - t) / 60000); return m < 60 ? `${Math.round(m)}m` : `${Math.round(m / 60)}h`; };
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map((x) => String(Math.floor(x)).padStart(2, '0')).join(':'); };
const img = (src, alt = '') => (src && /^https:\/\//.test(src) ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ic'}))">` : '<span class="ic"></span>');
const buzz = (ms = 8) => { try { navigator.vibrate?.(ms); } catch { /* no haptics */ } };

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2400);
}
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
let authMem = null;
const auth = () => ls.get('dp.auth') || authMem;

async function api(path, { method = 'GET', body = null, signed = false } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  const a = auth();
  if (signed && a) { headers['x-player'] = a.id; headers['x-secret'] = a.secret; }
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

// ---------------------------------------------------------------- card tiers (by market cap): the collectible look
const TIERS = [[2e6, 'diamond'], [5e5, 'gold'], [1e5, 'silver'], [0, 'bronze']];
const tierOf = (mcap) => (TIERS.find(([min]) => (mcap || 0) >= min) || TIERS[3])[1];
const tierVar = (mcap) => `var(--${tierOf(mcap)})`;
function cardHTML(c, { sub = null } = {}) {
  if (!c) return '<div class="card card--empty"><div class="card__in">+</div></div>';
  const t = tierOf(c.mcap);
  const pctTxt = c.pct == null ? (sub ?? usd(c.mcap)) : pct(c.pct);
  return `<div class="card card--${t}"><div class="card__in"><span class="card__tier">${t}</span>${img(c.image, c.symbol)}
    <span class="card__sym">$${esc(c.symbol || '?')}</span><span class="card__pct ${c.pct == null ? '' : cls(c.pct)}">${pctTxt}</span></div></div>`;
}
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hm = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

// ---------------------------------------------------------------- router
let loop = null, tick = null;
function route() {
  clearTimeout(loop); clearInterval(tick); loop = tick = null;
  const h = location.hash.replace(/^#/, '') || '/play';
  const tab = h.startsWith('/leaderboard') ? 'leaderboard' : h.startsWith('/me') ? 'me' : 'play';
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.t === tab));
  const m = h.match(/^\/room\/([0-9a-f]{12})$/);
  if (m) return roomView(m[1]);
  if (tab === 'leaderboard') return boardView();
  if (tab === 'me') return meView();
  return playView();
}
addEventListener('hashchange', () => { route(); scrollTo(0, 0); });

// ---------------------------------------------------------------- play (home)
async function playView() {
  $view.innerHTML = `
    <div class="head"><div><h1>Draft against 7 degens</h1><p class="sub">Eight players, one list of fresh launches, five rounds. Once a coin is drafted, nobody else in your room can have it.</p></div></div>
    <div class="modes">
      <button class="mode" data-mode="sprint"><span class="mode__t">1-hour sprint</span><span class="mode__d">Draft in 3 minutes, scored over the next hour.</span><span class="btn">Find a draft</span></button>
      <button class="mode" data-mode="daily"><span class="mode__t">24-hour</span><span class="mode__d">Draft now, see who called it best by tomorrow.</span><span class="btn btn--quiet">Find a draft</span></button>
    </div>
    <div id="live"></div>
    <h2 class="h2">How a draft works</h2>
    <ol class="steps">
      <li><b>Join a room.</b> It starts when 8 players are in or after 30 seconds. Empty seats go to bots.</li>
      <li><b>Pick at the same time.</b> Each round everyone chooses a coin within 25 seconds. If two people want the same coin, the one with priority gets it and the other gets the best coin left. Priority snakes each round.</li>
      <li><b>Score.</b> Prices are recorded the moment the draft ends. Your lineup scores the average % move of its 5 coins. Top 3 in the room earn 100, 50 and 25 points.</li>
    </ol>`;
  $view.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => findDraft(b.dataset.mode, b)));
  if (auth()) {
    const me = await api('/me', { signed: true }).catch(() => null);
    const live = (me?.rooms || []).filter((r) => r.place == null).slice(0, 4);
    if (live.length && $('live')) $('live').innerHTML = `<h2 class="h2">Your rooms in play</h2><div class="board">${live.map((r) => `<a class="brow" href="#/room/${r.room}"><span class="pos">●</span><span><span class="nm">${r.mode === 'sprint' ? '1-hour sprint' : '24-hour'}</span><span class="sub" style="margin:0;font-size:12.5px">joined ${age(r.joined)} ago</span></span><span class="sc">Open</span></a>`).join('')}</div>`;
  }
}

async function findDraft(mode, btn) {
  if (!auth()) { const ok = await askName(); if (!ok) return; }
  const label = btn.querySelector('.btn'); label.textContent = 'Finding a room…'; btn.disabled = true;
  try { const r = await api('/queue', { method: 'POST', body: { mode }, signed: true }); location.hash = `#/room/${r.room}`; }
  catch (e) { toast(e.message); label.textContent = 'Find a draft'; btn.disabled = false; }
}

// ---------------------------------------------------------------- room
async function roomView(id) {
  let v = null, skew = 0, sending = false;
  $view.innerHTML = '<div class="board"><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
  const now = () => Date.now() + skew;
  const poll = async () => {
    try { v = await api(`/room/${id}`, { signed: !!auth() }); skew = v.now - Date.now(); render(); }
    catch (e) { $view.innerHTML = `<p class="empty">${esc(e.message)}</p><a class="btn btn--wide" href="#/play">Back to play</a>`; return; }
    const fast = v.phase === 'lobby' || v.phase === 'draft';
    if (v.phase !== 'final') loop = setTimeout(poll, fast ? 1200 : 20000);
  };
  const pick = async (mint) => {
    if (sending || !v || v.phase !== 'draft') return;
    if (!v.seats.some((s) => s.me)) { toast('You’re watching this room'); return; }
    sending = true; buzz();
    try { v = await api(`/room/${id}/pick`, { method: 'POST', body: { mint }, signed: true }); skew = v.now - Date.now(); render(); }
    catch (e) { toast(e.message); }
    sending = false;
  };
  const clocks = () => {
    if (!v) return;
    const el = $('clock'); if (!el) return;
    if (v.phase === 'lobby') el.textContent = mmss(v.startsAt - now());
    if (v.phase === 'draft') { el.textContent = mmss(v.roundEnds - now()); const bar = $('tbar'); if (bar) bar.style.width = `${Math.max(0, Math.min(100, (v.roundEnds - now()) / 250))}%`; }
    if (v.phase === 'live') el.textContent = hm(v.ends - now());
  };
  function render() {
    const me = v.seats.find((s) => s.me);
    if (v.phase === 'lobby') {
      const empty = 8 - v.seats.length;
      $view.innerHTML = `<div class="head"><div><h1>${esc(v.modeLabel)} room</h1><p class="sub">Waiting for players. Empty seats are filled with bots when the timer ends.</p></div>
          <div class="closes">Draft starts in<br><b id="clock"></b></div></div>
        <div class="seats">${v.seats.map((s) => `<div class="seat ${s.me ? 'me' : ''}">${esc(s.name)}</div>`).join('')}${'<div class="seat seat--empty">open</div>'.repeat(empty)}</div>
        ${feed(v)}`;
    } else if (v.phase === 'draft') {
      const want = v.myWant, wantC = want && v.pool.find((c) => c.mint === want);
      $view.innerHTML = `<div class="head"><div><h1>Round ${v.round + 1} of ${v.rounds}</h1><p class="sub">${!me ? 'You’re watching this draft.' : wantC ? `You chose <b>$${esc(wantC.symbol)}</b>. It’s yours unless someone with priority took it too.` : 'Choose a coin. You can change it until the clock runs out.'}</p></div>
          <div class="closes">Round ends in<br><b id="clock"></b></div></div>
        <div class="timer"><i id="tbar"></i></div>
        ${me ? `<div class="lineup">${Array.from({ length: 5 }, (_, i) => cardHTML(me.lineup[i])).join('')}</div>` : ''}
        <div class="seats seats--mini">${v.seats.map((s) => `<div class="seat ${s.me ? 'me' : ''}">${esc(s.name)}<small>${s.bot ? 'bot' : s.picked ? 'picked ✓' : 'choosing…'}</small></div>`).join('')}</div>
        ${feed(v)}
        <div class="list" id="dlist">${v.pool.map((c) => {
          const taken = c.takenBy, mine = want === c.mint;
          return `<div class="coin ${taken ? 'is-taken' : ''}">${img(c.image, c.symbol)}
            <div style="min-width:0"><div class="coin__name">$${esc(c.symbol)}<span>${esc(c.name)}</span></div>
              <div class="coin__meta"><span style="--tier:${tierVar(c.mcap)}"><i class="tierdot"></i> ${usd(c.mcap)}</span><span>${age(c.created)} old</span><span>liq ${usd(c.liq)}</span></div></div>
            <div class="coin__chg ${cls(c.chg1h)}">${pct(c.chg1h)}<small>1h</small></div>
            ${taken ? `<span class="taken">${esc(taken)}</span>` : `<button class="add ${mine ? 'on' : ''}" data-m="${esc(c.mint)}" ${me ? '' : 'disabled'}>${mine ? 'Chosen' : 'Pick'}</button>`}</div>`;
        }).join('')}</div>`;
      $('dlist').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) pick(b.dataset.m); };
    } else {
      const live = v.phase === 'live';
      const order = [...v.seats].sort((a, b) => a.place - b.place);
      $view.innerHTML = `<div class="head"><div><h1>${live ? 'Live standings' : 'Final standings'}</h1><p class="sub">${esc(v.modeLabel)} · prices locked ${age(v.lockedAt)} ago${live ? '' : ' · settled'}</p></div>
          <div class="closes">${live ? `Ends in<br><b id="clock"></b>` : '<span class="status final">Settled</span>'}</div></div>
        ${me ? `<div class="mine"><div class="mine__top"><span>Your lineup · place <b>${me.place}</b> of 8</span><b class="num ${cls(me.score)}">${pct(me.score)}</b></div>
          <div class="lineup">${me.lineup.map((c) => cardHTML(c)).join('')}</div></div>` : ''}
        <div class="board">${order.map((s) => `<div class="brow ${s.place <= 3 ? 'top' : ''} ${s.me ? 'me' : ''}"><span class="pos">${s.place}</span>
          <span><span class="nm">${esc(s.name)}${s.bot ? ' <small class="sub">bot</small>' : ''}</span><span class="mini">${s.lineup.map((c) => `<i style="--tier:${tierVar(c.mcap)}" title="$${esc(c.symbol)} ${c.pct == null ? '' : pct(c.pct)}"></i>`).join('')}</span></span>
          <span class="sc ${cls(s.score)}">${pct(s.score)}</span></div>`).join('')}</div>
        <p class="note">Top 3 people in the room earn ${v.points.join(', ')} points${live ? ' when the room settles' : ''}. Bots never take points.</p>
        ${me ? `<div class="actions"><button class="btn" id="shareX">Post to X</button><a class="btn btn--quiet" href="#/play">Play again</a></div>` : '<a class="btn btn--wide" href="#/play">Find your own draft</a>'}`;
      if (me) $('shareX').onclick = () => shareX(v, me);
    }
    clocks();
  }
  await poll();
  tick = setInterval(clocks, 250);
}

function feed(v) {
  const lines = v.events.slice(-4).reverse().map((e) => {
    if (e.k === 'join') return `<b>${esc(e.name)}</b> joined`;
    if (e.k === 'start') return 'Draft started';
    if (e.k === 'pick') return `<b>${esc(e.name)}</b> drafted $${esc(e.sym)}${e.auto ? ' (auto)' : ''}`;
    if (e.k === 'sniped') return `<b>${esc(e.by || 'Someone')}</b> sniped $${esc(e.want)} from <b>${esc(e.name)}</b>, who got $${esc(e.got)}`;
    if (e.k === 'locked') return 'Draft over. Prices locked.';
    if (e.k === 'final') return 'Room settled';
    return '';
  }).filter(Boolean);
  return lines.length ? `<ul class="feed">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : '';
}

// ---------------------------------------------------------------- leaderboard (today's points)
async function boardView() {
  $view.innerHTML = `<div class="head"><div><h1>Today’s leaderboard</h1><p class="sub">Points from every room you play today. 1st in a room is 100, 2nd 50, 3rd 25.</p></div></div><div class="board" id="board">${'<div class="skel"></div>'.repeat(5)}</div><div id="best"></div>`;
  const load = async () => {
    const b = await api('/board').catch(() => null);
    if (!b || !$('board')) return;
    const me = auth()?.name;
    $('board').innerHTML = b.top.length ? b.top.map((t, i) => `<div class="brow ${i < 3 ? 'top' : ''} ${t.name === me ? 'me' : ''}"><span class="pos">${i + 1}</span>
      <span><span class="nm">${esc(t.name)}</span><span class="sub" style="margin:0;font-size:12.5px">${t.games} room${t.games === 1 ? '' : 's'} · ${t.wins} win${t.wins === 1 ? '' : 's'} · best ${pct(t.best)}</span></span>
      <span class="sc">${t.points} pts</span></div>`).join('') : '<p class="empty">No rooms have settled today. <a href="#/play">Play one</a>.</p>';
    if (b.best.length) $('best').innerHTML = `<h2 class="h2">Best lineups today</h2><div class="board">${b.best.map((r) => `<div class="brow"><span class="pos">★</span><span><span class="nm">${esc(r.name)}</span><span class="sub" style="margin:0;font-size:12.5px">${r.picks.map((p) => '$' + esc(p)).join(' ')}</span></span><span class="sc ${cls(r.score)}">${pct(r.score)}</span></div>`).join('')}</div>`;
  };
  await load();
  loop = setInterval(load, 30000);
}

// ---------------------------------------------------------------- me
async function meView() {
  if (!auth()) { $view.innerHTML = `<div class="head"><div><h1>My rooms</h1><p class="sub">You haven’t played yet.</p></div></div><a class="btn btn--wide" href="#/play">Find a draft</a>`; return; }
  const me = await api('/me', { signed: true }).catch((e) => ({ error: e.message }));
  if (me.error) { $view.innerHTML = `<p class="empty">${esc(me.error)}</p>`; return; }
  $view.innerHTML = `<div class="head"><div><h1>${esc(me.name)}</h1><p class="sub">${me.today.points} points today from ${me.today.games} settled room${me.today.games === 1 ? '' : 's'}</p></div></div>
    ${me.rooms.length ? `<div class="board">${me.rooms.map((r) => `<a class="brow" href="#/room/${r.room}"><span class="pos">${r.place ?? '●'}</span>
      <span><span class="nm">${r.mode === 'sprint' ? '1-hour sprint' : '24-hour'}</span><span class="sub" style="margin:0;font-size:12.5px">${r.place ? `${r.points} pts` : 'in play'} · ${age(r.joined)} ago</span></span>
      <span class="sc ${cls(r.score)}">${r.score == null ? 'Open' : pct(r.score)}</span></a>`).join('')}</div>` : '<a class="btn btn--wide" href="#/play">Find your first draft</a>'}`;
}

function askName() {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<form class="sheet"><h3>Choose a nickname</h3><p>It’s how you show up in rooms and on the leaderboard. No wallet, no email.</p>
      <input class="field" name="n" maxlength="16" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="trench_king" required aria-label="Nickname">
      <div class="err" id="nmErr"></div><button class="cta" type="submit">Save nickname</button><button class="cta cta--ghost" type="button" data-x>Cancel</button></form>`;
    document.body.appendChild(m);
    const f = m.querySelector('form');
    setTimeout(() => f.n.focus(), 50);
    const close = (v) => { m.remove(); resolve(v); };
    m.querySelector('[data-x]').onclick = () => close(false);
    m.addEventListener('click', (e) => { if (e.target === m) close(false); });
    f.onsubmit = async (e) => {
      e.preventDefault(); $('nmErr').textContent = '';
      try { const j = await api('/join', { method: 'POST', body: { name: f.n.value.trim() } }); ls.set('dp.auth', j); authMem = j; close(true); }
      catch (err) { $('nmErr').textContent = err.message; }
    };
  });
}

function shareX(v, me) {
  const url = `${location.origin}/#/room/${v.id}`;
  const text = `${v.phase === 'final' ? `Finished #${me.place} of 8` : `Sitting #${me.place} of 8`} in my DRAFTPUMP room, lineup ${pct(me.score)} ${me.score >= 0 ? '🔥' : '💀'}\n\n${me.lineup.map((c) => `$${c.symbol} ${c.pct == null ? '' : pct(c.pct)}`).join('\n')}\n\nDraft against me:`;
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener');
}

route();
