// DRAFTPUMP front end: a memecoin "sportsbook". Plain ES module; hash routes #/board #/standings #/me #/team/<id>.
const API = '/api';
const TEAM = 5;
const $ = (id) => document.getElementById(id);
const $view = $('view'), $slip = $('slip');

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

// ---------------------------------------------------------------- shared state
const S = {
  pool: [], refreshed: 0, prevChg: new Map(),
  slip: new Map((ls.get('dp.slip', []) || []).map((c) => [c.mint, c])),   // mint → coin (kept across reloads)
  me: null, prevRank: new Map(), slipOpen: false, justLocked: null,
};
const saveSlip = () => ls.set('dp.slip', [...S.slip.values()]);

// ---------------------------------------------------------------- live clock (round closes at midnight UTC)
function tickClock() {
  const now = new Date(), end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  $('clockT').textContent = hms(end - now);
}
setInterval(tickClock, 1000); tickClock();

// ---------------------------------------------------------------- data loops
async function loadPool() {
  try {
    const p = await api('/pool');
    S.prevChg = new Map(S.pool.map((c) => [c.mint, c.chg1h]));
    S.pool = p.coins || []; S.refreshed = p.refreshed || 0;
    // a coin that dropped out of the draft list can't stay on the slip
    let dropped = 0;
    for (const m of [...S.slip.keys()]) if (!S.pool.some((c) => c.mint === m)) { S.slip.delete(m); dropped++; }
    if (dropped) { saveSlip(); toast(`${dropped} pick${dropped > 1 ? 's' : ''} left the board — choose again`); }
    renderTape();
  } catch { /* keep the last list */ }
}
async function loadMe() {
  if (!auth()) { S.me = null; return; }
  try { S.me = await api('/me', { signed: true }); } catch { S.me = null; }
}

function renderTape() {
  const top = [...S.pool].sort((a, b) => Math.abs(b.chg1h) - Math.abs(a.chg1h)).slice(0, 12);
  if (!top.length) { $('tapeIn').innerHTML = '<span class="tk">Loading markets…</span>'; return; }
  const items = top.map((c) => `<a class="tk" href="${esc(c.url)}" target="_blank" rel="noopener">${img(c.image, c.symbol)}$${esc(c.symbol)} <span class="${cls(c.chg1h)}">${pct(c.chg1h)}</span></a>`).join('');
  $('tapeIn').innerHTML = items + items;   // twice: the strip loops seamlessly at -50 %
}

// ---------------------------------------------------------------- router
let loop = null;
function route() {
  clearInterval(loop); loop = null;
  const h = location.hash.replace(/^#/, '') || '/board';
  const tab = h.startsWith('/standings') ? 'standings' : h.startsWith('/me') || h.startsWith('/team') ? 'me' : 'board';
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.t === tab));
  const m = h.match(/^\/team\/([0-9a-f]+)$/);
  if (m) return ticketView(m[1]);
  if (tab === 'standings') return standingsView();
  if (tab === 'me') return meView();
  return marketsView();
}
addEventListener('hashchange', () => { route(); scrollTo(0, 0); });

// ---------------------------------------------------------------- markets (the draft board)
let filter = 'hot';
async function marketsView() {
  $view.innerHTML = `
    <div class="lede"><div><h1>Today’s markets</h1><p>Tap 5 coins to build your slip. Best 24h move wins the day.</p></div><span class="upd" id="upd"></span></div>
    <div class="filters" id="filters">
      <button data-f="hot" class="${filter === 'hot' ? 'on' : ''}">Hot</button><button data-f="new" class="${filter === 'new' ? 'on' : ''}">Just launched</button>
      <button data-f="up" class="${filter === 'up' ? 'on' : ''}">Pumping</button><button data-f="down" class="${filter === 'down' ? 'on' : ''}">Dipping</button><button data-f="mcap" class="${filter === 'mcap' ? 'on' : ''}">Biggest</button>
    </div>
    <div class="mkts" id="mkts">${'<div class="skel"></div>'.repeat(6)}</div>
    <p class="how"><b>How it works:</b> your picks’ prices are locked the moment you submit. Over the next 24 hours your slip scores the average % move of its 5 coins. A rugged coin counts −100%. One slip per day, free, no wallet.</p>`;
  $('filters').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    filter = b.dataset.f;
    $('filters').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderMarkets(false);
  };
  $('mkts').onclick = (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    togglePick(b.dataset.m);
  };
  if (!S.pool.length) await loadPool();
  await loadMe();
  renderMarkets(false); renderSlip();
  loop = setInterval(async () => { await loadPool(); renderMarkets(true); renderSlip(); }, 30000);
}

function sortedPool() {
  const c = [...S.pool];
  if (filter === 'new') c.sort((a, b) => b.created - a.created);
  if (filter === 'up') c.sort((a, b) => b.chg1h - a.chg1h);
  if (filter === 'down') c.sort((a, b) => a.chg1h - b.chg1h);
  if (filter === 'mcap') c.sort((a, b) => b.mcap - a.mcap);
  return c;
}

function renderMarkets(flash) {
  const el = $('mkts'); if (!el) return;
  const upd = $('upd'); if (upd && S.refreshed) upd.textContent = `prices ${age(S.refreshed)} old`;
  const rows = sortedPool();
  if (!rows.length) { el.innerHTML = '<p class="empty">No coins pass the filters right now. New launches are checked every 5 minutes.</p>'; return; }
  el.innerHTML = rows.map((c) => {
    const on = S.slip.has(c.mint), prev = S.prevChg.get(c.mint);
    const fl = flash && prev != null && prev !== c.chg1h ? (c.chg1h > prev ? 'flash-up' : 'flash-down') : '';
    return `<div class="mkt">
      ${img(c.image, c.symbol)}
      <div style="min-width:0"><div class="mkt__sym">$${esc(c.symbol)}</div><div class="mkt__sub">${esc(c.name)} · ${age(c.created)} old · liq ${usd(c.liq)}</div></div>
      <div class="mkt__stat">${usd(c.mcap)}<small>mcap</small></div>
      <button class="odds ${on ? 'on' : ''} ${fl}" data-m="${esc(c.mint)}" aria-pressed="${on}" aria-label="${on ? 'Remove' : 'Add'} $${esc(c.symbol)}">
        <span class="${on ? '' : cls(c.chg1h)}">${pct(c.chg1h)}</span><small>${on ? 'on slip ✓' : '1h · add'}</small></button>
    </div>`;
  }).join('');
}

function togglePick(mint) {
  if (S.me?.today) { toast('You already locked today’s slip'); return; }
  if (S.slip.has(mint)) S.slip.delete(mint);
  else if (S.slip.size >= TEAM) { toast(`Your slip is full — remove one first`); buzz(30); return; }
  else { S.slip.set(mint, S.pool.find((c) => c.mint === mint)); buzz(); }
  saveSlip(); renderMarkets(false); renderSlip();
}

// ---------------------------------------------------------------- the slip drawer
function renderSlip() {
  const onMarkets = (location.hash || '#/board').startsWith('#/board') || location.hash === '';
  if (!onMarkets) { $slip.hidden = true; return; }
  if (S.me?.today) {
    $slip.hidden = false; $slip.classList.remove('open');
    $slip.innerHTML = `<div class="slip__in"><a class="cta cta--ghost" href="#/team/${S.me.today.id}">Today’s slip is locked · ${pct(S.me.today.score)} · view ticket</a></div>`;
    return;
  }
  const picks = [...S.slip.values()], n = picks.length;
  $slip.hidden = n === 0 && !S.slipOpen;
  $slip.classList.toggle('open', S.slipOpen && n > 0);
  $slip.innerHTML = `<div class="slip__in">
    <button class="slip__head" id="slipHead" aria-expanded="${S.slipOpen}"><span class="slip__title">Your slip</span><span class="slip__count">${n}/${TEAM}</span>
      <span class="slip__dots">${Array.from({ length: TEAM }, (_, i) => `<i class="${i < n ? 'full' : ''}"></i>`).join('')}</span></button>
    <div class="slip__list">${picks.map((c) => `<div class="sl">${img(c.image, c.symbol)}<span><b>$${esc(c.symbol)}</b></span><span class="num ${cls(c.chg1h)}">${pct(c.chg1h)} 1h</span><button data-rm="${esc(c.mint)}" aria-label="Remove $${esc(c.symbol)}">×</button></div>`).join('')}</div>
    <button class="cta" id="lockBtn" ${n === TEAM ? '' : 'disabled'}>${n === TEAM ? 'Lock in slip' : `Add ${TEAM - n} more`}</button></div>`;
  $('slipHead').onclick = () => { S.slipOpen = !S.slipOpen; renderSlip(); };
  $slip.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => togglePick(b.dataset.rm)));
  $('lockBtn').onclick = lockSlip;
}

async function lockSlip() {
  if (S.slip.size !== TEAM) return;
  if (!auth()) { const ok = await askName(); if (!ok) return; }
  const btn = $('lockBtn'); btn.disabled = true; btn.textContent = 'Locking prices…';
  try {
    const e = await api('/draft', { method: 'POST', body: { mints: [...S.slip.keys()] }, signed: true });
    S.slip.clear(); saveSlip(); S.slipOpen = false; S.justLocked = e.id; buzz(25);
    location.hash = `#/team/${e.id}`;
  } catch (err) {
    toast(err.message);
    if (/left the draft/.test(err.message)) await loadPool();
    renderMarkets(false); renderSlip();
  }
}

function askName() {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<form class="sheet"><h3>Choose a nickname</h3><p>It’s how you show up in the standings. No wallet, no email.</p>
      <input class="field" name="n" maxlength="16" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="trench_king" required aria-label="Nickname">
      <div class="err" id="nmErr"></div><button class="cta" type="submit">Save and lock slip</button><button class="cta cta--ghost" type="button" data-x>Cancel</button></form>`;
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

// ---------------------------------------------------------------- standings
async function standingsView() {
  renderSlip();
  $view.innerHTML = `<div class="lede"><div><h1>Standings</h1><p id="cnt">Today’s slips, ranked by live score.</p></div></div><ol class="stand" id="stand">${'<li class="skel"></li>'.repeat(5)}</ol>`;
  const load = async () => {
    const b = await api('/board').catch(() => null);
    if (!b || !$('stand')) return;
    $('cnt').textContent = b.count ? `${b.count} slip${b.count === 1 ? '' : 's'} today, ranked by live score.` : 'No slips yet today.';
    const me = auth()?.name;
    if (!b.top.length) { $('stand').innerHTML = '<li class="empty">Nobody has locked a slip today. <a href="#/board">Be first</a>.</li>'; return; }
    $('stand').innerHTML = b.top.map((t, i) => {
      const was = S.prevRank.get(t.id), mv = was == null || was === i ? '' : was > i ? '<span class="up">▲</span>' : '<span class="down">▼</span>';
      return `<li class="${t.name === me ? 'me' : ''}"><a href="#/team/${t.id}"><span class="pos">${i + 1}</span><span class="mv">${mv}</span>
        <span><span class="nm">${esc(t.name)}</span><span class="ics">${t.picks.map((p) => img(p.image, p.symbol)).join('')}</span></span>
        <span class="sc ${cls(t.score)}">${pct(t.score)}</span></a></li>`;
    }).join('');
    S.prevRank = new Map(b.top.map((t, i) => [t.id, i]));
  };
  await load();
  loop = setInterval(load, 30000);
}

// ---------------------------------------------------------------- my slips
async function meView() {
  renderSlip();
  if (!auth()) { $view.innerHTML = `<p class="empty">You haven’t played yet.</p><a class="cta" href="#/board">Build today’s slip</a>`; return; }
  $view.innerHTML = '<div class="skel" style="height:240px"></div>';
  await loadMe();
  const me = S.me;
  if (!me) { $view.innerHTML = '<p class="empty">Couldn’t load your slips. Pull to refresh.</p>'; return; }
  const list = me.history || [];
  $view.innerHTML = `<div class="lede"><div><h1>${esc(me.name)}</h1><p>${list.length} slip${list.length === 1 ? '' : 's'} played</p></div></div>
    ${me.today ? '' : '<a class="cta" href="#/board" style="margin-bottom:12px">Build today’s slip</a>'}
    <ol class="stand">${list.map((e) => `<li><a href="#/team/${e.id}"><span class="pos" style="font-size:15px">${esc(e.day.slice(5))}</span><span></span>
      <span><span class="nm">${e.final ? 'Final' : 'Live'}</span><span class="ics">${e.picks.map((p) => img(p.image, p.symbol)).join('')}</span></span>
      <span class="sc ${cls(e.score)}">${pct(e.score)}</span></a></li>`).join('')}</ol>`;
}

// ---------------------------------------------------------------- ticket (one locked slip; public, shareable)
async function ticketView(id) {
  renderSlip();
  $view.innerHTML = '<div class="skel" style="height:320px"></div>';
  const fresh = S.justLocked === id; S.justLocked = null;
  const load = async (first) => {
    let t;
    try { t = await api(`/entry?id=${encodeURIComponent(id)}`); } catch (e) { $view.innerHTML = `<p class="empty">${esc(e.message)}</p><a class="cta" href="#/board">Back to markets</a>`; return; }
    const mine = auth()?.name === t.name;
    const left = t.ends - Date.now();
    $view.innerHTML = `<article class="ticket">
      <div class="ticket__top"><div><div class="ticket__who">${esc(t.name)}</div><div class="ticket__when">Slip for ${esc(t.day)} · ${t.final ? 'settled' : `settles in ${hms(left)}`}</div></div>
        <span class="stamp ${t.final ? 'final' : ''} ${first && fresh ? 'in' : ''}">${t.final ? 'Final' : 'Locked'}</span></div>
      <div class="ticket__score ${cls(t.score)}">${pct(t.score)}</div>
      <div class="ticket__rank" id="tRank"></div>
      <div class="perf"></div>
      <div class="pks">${t.picks.map((p) => `<a class="pk ${p.dead ? 'dead' : ''}" href="${esc(p.url || '#')}" target="_blank" rel="noopener">${img(p.image, p.symbol)}
        <span><b>$${esc(p.symbol || '?')}</b><small>${p.dead ? 'rugged — counts −100%' : esc(p.name || '')}</small></span><span class="num ${cls(p.pct)}">${pct(p.pct)}</span></a>`).join('')}</div>
    </article>
    ${mine ? '<div class="row2"><button class="cta" id="shareX">Post to X</button><button class="cta cta--ghost" id="saveImg">Save image</button></div>'
      : '<a class="cta" href="#/board">Build your own slip</a>'}
    <a class="cta cta--ghost" href="#/standings">See standings</a>`;
    if (mine) {
      $('shareX').onclick = () => shareX(t);
      $('saveImg').onclick = () => saveCard(t);
      await loadMe();
      if (S.me?.rank && S.me.today?.id === t.id) $('tRank').innerHTML = `Currently <b>#${S.me.rank}</b> today`;
    }
  };
  await load(true);
  loop = setInterval(() => load(false), 30000);
}

function shareX(t) {
  const url = `${location.origin}/#/team/${t.id}`;
  const text = `My DRAFTPUMP slip is ${pct(t.score)} ${t.score >= 0 ? '🔥' : '💀'}\n\n${t.picks.map((p) => `$${p.symbol} ${pct(p.pct)}`).join('\n')}\n\nThink you can draft better?`;
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener');
}

// share image: a 1200×630 ticket drawn on a canvas (text only: coin logos from other sites would block the export)
async function saveCard(t) {
  await document.fonts?.ready;
  const c = document.createElement('canvas'); c.width = 1200; c.height = 630;
  const g = c.getContext('2d');
  g.fillStyle = '#0d1726'; g.fillRect(0, 0, 1200, 630);
  g.fillStyle = '#132136'; g.beginPath(); g.roundRect(40, 40, 1120, 550, 28); g.fill();
  g.font = '800 54px "Barlow Condensed", sans-serif'; g.fillStyle = '#e9eef6'; g.fillText('DRAFT', 80, 120);
  g.fillStyle = '#f5b83d'; g.fillText('PUMP', 80 + g.measureText('DRAFT').width, 120);
  g.font = '700 32px "Barlow Condensed", sans-serif'; g.fillStyle = '#8fa3c0'; g.fillText(`${t.name.toUpperCase()} · SLIP ${t.day}`, 80, 170);
  g.save(); g.translate(990, 120); g.rotate(-0.14); g.strokeStyle = t.final ? '#8fa3c0' : '#f5b83d'; g.lineWidth = 5; g.strokeRect(-90, -38, 180, 64);
  g.fillStyle = g.strokeStyle; g.font = '800 40px "Barlow Condensed", sans-serif'; g.textAlign = 'center'; g.fillText(t.final ? 'FINAL' : 'LOCKED', 0, 10); g.restore();
  g.font = '800 170px "Barlow Condensed", sans-serif'; g.fillStyle = t.score >= 0 ? '#2bd67b' : '#ff4d5e'; g.fillText(pct(t.score), 74, 345);
  g.setLineDash([12, 10]); g.strokeStyle = '#24395a'; g.lineWidth = 3; g.beginPath(); g.moveTo(40, 385); g.lineTo(1160, 385); g.stroke(); g.setLineDash([]);
  g.font = '800 38px "Barlow Condensed", sans-serif';
  t.picks.forEach((p, i) => {
    const x = 80 + (i % 3) * 360, y = 450 + Math.floor(i / 3) * 70;
    g.fillStyle = '#e9eef6'; g.fillText(`$${String(p.symbol).slice(0, 9)}`, x, y);
    g.fillStyle = p.pct >= 0 ? '#2bd67b' : '#ff4d5e'; const s = pct(p.pct); g.fillText(s, x + 310 - g.measureText(s).width, y);
  });
  g.fillStyle = '#8fa3c0'; g.font = '600 26px "Barlow", sans-serif'; g.fillText(`${location.host} · fantasy memecoins`, 80, 570);
  c.toBlob(async (blob) => {
    const file = new File([blob], `draftpump-${t.id}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'My DRAFTPUMP slip' }); return; } catch { /* cancelled */ } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}

loadPool().then(() => { if ((location.hash || '#/board').startsWith('#/board')) renderMarkets(false); });
route();
