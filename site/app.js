// DRAFTPUMP front end: plain ES module, hash routes (#/  #/draft  #/team/<id>). Talks to the Worker under /api/.
const API = '/api';
const TEAM = 5;
const $view = document.getElementById('view');
const $who = document.getElementById('who');

// ---------------------------------------------------------------- tiny helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (v) => `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)}%`;
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const usd = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);
const ago = (t) => { const m = Math.max(0, (Date.now() - t) / 60000); return m < 60 ? `${Math.round(m)}m` : `${Math.round(m / 60)}h`; };
const left = (t) => { const s = Math.max(0, t - Date.now()) / 1000; return s <= 0 ? 'final' : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`; };
const img = (src, alt = '') => (src && /^https:\/\//.test(src) ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ic'}))">` : '<span class="ic"></span>');

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2600);
}

const store = {
  get() { try { return JSON.parse(localStorage.getItem('dp.auth') || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem('dp.auth', JSON.stringify(v)); } catch { /* private mode: lives for this tab */ } store._mem = v; },
  _mem: null,
};
const auth = () => store.get() || store._mem;

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

// ---------------------------------------------------------------- router
let timer = null;
function route() {
  clearInterval(timer); timer = null;
  const a = auth();
  $who.textContent = a ? `@${a.name}` : '';
  const h = location.hash.replace(/^#/, '') || '/';
  document.body.classList.toggle('drafting', h === '/draft');
  if (h === '/draft') return draftView();
  const m = h.match(/^\/team\/([0-9a-f]+)$/);
  if (m) return teamView(m[1]);
  return homeView();
}
addEventListener('hashchange', route);

// ---------------------------------------------------------------- home
async function homeView() {
  $view.innerHTML = `
    <section class="hero">
      <h1>Fantasy <em>memecoins.</em></h1>
      <p>Draft 5 fresh Solana launches. Your score is how much they pump over the next 24 hours. Best team tops today’s board.</p>
    </section>
    <div id="mine"></div>
    <section class="card"><h2>Today’s board <span id="count"></span></h2><ol class="board" id="board"><li class="skel"></li><li class="skel"></li></ol></section>
    <section class="card"><h2>How it works</h2><ol class="steps">
      <li>Pick 5 coins from the live list of today’s hottest new launches.</li>
      <li>Lock in. Each coin’s price is recorded right then.</li>
      <li>24 hours later your score is the average % move of your 5. One team per day.</li>
    </ol><p class="empty">Free. No wallet, no sign-up form — just a nickname.</p></section>`;
  const load = async () => {
    const a = auth();
    const [board, me] = await Promise.all([api('/board').catch(() => null), a ? api('/me', { signed: true }).catch(() => null) : null]);
    renderMine(me);
    if (board) renderBoard(board);
  };
  await load();
  timer = setInterval(load, 60000);
}

function renderMine(me) {
  const el = document.getElementById('mine');
  if (!el) return;
  if (me?.today) {
    const t = me.today;
    el.innerHTML = `<section class="card"><h2>Your team today</h2>
      <div class="team__score num ${cls(t.score)}">${pct(t.score)}</div>
      <div class="team__meta">${me.rank ? `#${me.rank} on the board · ` : ''}${t.final ? 'final' : left(t.ends)}</div>
      ${picksHTML(t.picks)}
      <div class="row" style="margin-top:14px"><a class="btn btn--wide" href="#/team/${t.id}">Share my team</a></div></section>`;
  } else {
    el.innerHTML = `<a class="btn btn--wide" href="#/draft" style="margin-top:8px">Draft today’s team →</a>`;
  }
}

function picksHTML(picks) {
  return `<div class="picks">${(picks || []).map((p) => `
    <a class="pick ${p.dead ? 'dead' : ''}" href="${esc(p.url || '#')}" target="_blank" rel="noopener">
      ${img(p.image, p.symbol)}
      <div style="min-width:0"><div class="pick__sym">$${esc(p.symbol || '?')}</div><div class="pick__name">${esc(p.dead ? 'rugged / no liquidity' : p.name || '')}</div></div>
      <span class="pick__pct num ${cls(p.pct)}">${pct(p.pct)}</span></a>`).join('')}</div>`;
}

function renderBoard(b) {
  const list = document.getElementById('board'), cnt = document.getElementById('count');
  if (!list) return;
  if (cnt) cnt.textContent = b.count ? `· ${b.count} team${b.count === 1 ? '' : 's'}` : '';
  if (!b.top.length) { list.innerHTML = '<li class="empty" style="display:block">No teams yet today — be first.</li>'; return; }
  list.innerHTML = b.top.map((t, i) => `<li><a href="#/team/${t.id}"><span class="rank">${i + 1}</span>
    <span><span class="name">${esc(t.name)}</span><span class="icons">${t.picks.map((p) => img(p.image, p.symbol)).join('')}</span></span>
    <span class="sc ${cls(t.score)}">${pct(t.score)}</span></a></li>`).join('');
}

// ---------------------------------------------------------------- draft
async function draftView() {
  const picked = new Map();   // mint → coin
  let coins = [], sort = 'hot';
  $view.innerHTML = `
    <div class="draft__head"><h1>Pick ${TEAM}</h1><span class="who" id="fresh"></span></div>
    <div class="sorts" role="tablist">
      <button data-s="hot" class="on">🔥 Hot</button><button data-s="new">🆕 Newest</button><button data-s="up">📈 1h gain</button><button data-s="mcap">💰 Mcap</button>
    </div>
    <div class="coins" id="coins">${'<div class="skel"></div>'.repeat(6)}</div>
    <div class="tray"><div class="tray__in"><div class="slots" id="slots"></div><button class="btn" id="lock" disabled>Lock in</button></div></div>`;
  const $coins = document.getElementById('coins'), $slots = document.getElementById('slots'), $lock = document.getElementById('lock');

  const a = auth();
  if (a) {
    const me = await api('/me', { signed: true }).catch(() => null);
    if (me?.today) { toast('You already drafted today'); location.hash = `#/team/${me.today.id}`; return; }
  }

  const sorted = () => {
    const c = [...coins];
    if (sort === 'new') c.sort((x, y) => y.created - x.created);
    if (sort === 'up') c.sort((x, y) => y.chg1h - x.chg1h);
    if (sort === 'mcap') c.sort((x, y) => y.mcap - x.mcap);
    return c;
  };
  const render = () => {
    $coins.innerHTML = sorted().map((c) => `
      <button class="coin ${picked.has(c.mint) ? 'on' : ''}" data-m="${esc(c.mint)}" aria-pressed="${picked.has(c.mint)}">
        ${img(c.image, c.symbol)}
        <span style="min-width:0"><span class="coin__sym">$${esc(c.symbol)}</span> <span class="coin__sub">${esc(c.name)}</span>
          <span class="coin__sub" style="display:block">${ago(c.created)} old · liq ${usd(c.liq)}</span></span>
        <span class="coin__right">${usd(c.mcap)}<small class="${cls(c.chg1h)}">${pct(c.chg1h)} 1h</small></span>
      </button>`).join('') || '<p class="empty">No coins pass the filters right now — check back in a few minutes.</p>';
    const ps = [...picked.values()];
    $slots.innerHTML = Array.from({ length: TEAM }, (_, i) => ps[i] ? `<span class="slot full">${img(ps[i].image, ps[i].symbol)}</span>` : `<span class="slot">${i + 1}</span>`).join('');
    $lock.disabled = picked.size !== TEAM;
    $lock.textContent = picked.size === TEAM ? 'Lock in team' : `${picked.size}/${TEAM}`;
  };

  document.querySelector('.sorts').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    sort = b.dataset.s;
    document.querySelectorAll('.sorts button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
  $coins.addEventListener('click', (e) => {
    const b = e.target.closest('.coin'); if (!b) return;
    const m = b.dataset.m;
    if (picked.has(m)) picked.delete(m);
    else if (picked.size >= TEAM) { toast(`Max ${TEAM} — tap one to drop it`); return; }
    else picked.set(m, coins.find((c) => c.mint === m));
    render();
  });
  $lock.addEventListener('click', async () => {
    if (picked.size !== TEAM) return;
    if (!auth()) { const ok = await askName(); if (!ok) return; }
    $lock.disabled = true; $lock.textContent = 'Locking…';
    try {
      const e = await api('/draft', { method: 'POST', body: { mints: [...picked.keys()] }, signed: true });
      toast('Team locked 🔒 — good luck');
      location.hash = `#/team/${e.id}`;
    } catch (err) {
      toast(err.message);
      if (/left the draft/.test(err.message)) await loadPool();
      render();
    }
  });

  const loadPool = async () => {
    try {
      const p = await api('/pool');
      coins = p.coins || [];
      for (const m of [...picked.keys()]) if (!coins.some((c) => c.mint === m)) picked.delete(m);
      const f = document.getElementById('fresh'); if (f && p.refreshed) f.textContent = `updated ${ago(p.refreshed)} ago`;
    } catch (e) { toast('Couldn’t load coins — retrying'); }
    render();
  };
  await loadPool();
  timer = setInterval(loadPool, 90000);
}

function askName() {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<form class="sheet"><h3>Pick a nickname</h3><p>Shown on the leaderboard. No wallet, no email.</p>
      <input class="field" name="n" maxlength="16" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="trench_king" required>
      <div class="err"></div><div class="row"><button class="btn" type="submit" style="flex:1">Let’s go</button><button class="btn btn--ghost" type="button" data-x>Cancel</button></div></form>`;
    document.body.appendChild(m);
    const f = m.querySelector('form'), inp = f.n, er = m.querySelector('.err');
    setTimeout(() => inp.focus(), 50);
    const close = (v) => { m.remove(); resolve(v); };
    m.querySelector('[data-x]').onclick = () => close(false);
    m.addEventListener('click', (e) => { if (e.target === m) close(false); });
    f.onsubmit = async (e) => {
      e.preventDefault();
      er.textContent = '';
      try { const j = await api('/join', { method: 'POST', body: { name: inp.value.trim() } }); store.set(j); $who.textContent = `@${j.name}`; close(true); }
      catch (err) { er.textContent = err.message; }
    };
  });
}

// ---------------------------------------------------------------- team (public, shareable)
async function teamView(id) {
  $view.innerHTML = '<div class="skel" style="height:220px;margin-top:16px"></div>';
  const load = async () => {
    let t;
    try { t = await api(`/entry?id=${encodeURIComponent(id)}`); } catch (e) { $view.innerHTML = `<p class="empty">${esc(e.message)}</p><a class="btn" href="#/">Home</a>`; return; }
    const mine = auth()?.name === t.name;
    $view.innerHTML = `<section class="card"><h2>${esc(t.name)}’s team · ${esc(t.day)}</h2>
      <div class="team__score num ${cls(t.score)}">${pct(t.score)}</div>
      <div class="team__meta">${t.final ? 'Final score' : left(t.ends)}</div>
      ${picksHTML(t.picks)}
      <div class="row" style="margin-top:14px">
        ${mine ? '<button class="btn" id="share" style="flex:1">Share on X</button><button class="btn btn--ghost" id="card">Save image</button>' : '<a class="btn" href="#/draft" style="flex:1">Draft your own team</a>'}
      </div></section>
      <a class="btn btn--ghost btn--wide" href="#/" style="margin-top:12px">Today’s board</a>`;
    if (mine) {
      document.getElementById('share').onclick = () => shareX(t);
      document.getElementById('card').onclick = () => saveCard(t);
    }
  };
  await load();
  timer = setInterval(load, 60000);
}

function shareX(t) {
  const url = `${location.origin}/#/team/${t.id}`;
  const text = `My DRAFTPUMP team is ${pct(t.score)} ${t.score >= 0 ? '🔥' : '💀'}\n\n${t.picks.map((p) => `$${p.symbol} ${pct(p.pct)}`).join('\n')}\n\nThink you can draft better?`;
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener');
}

// share card: 1200×630 PNG drawn on a canvas (text only: coin logos from other sites would block the export)
async function saveCard(t) {
  await document.fonts?.ready;
  const c = document.createElement('canvas'); c.width = 1200; c.height = 630;
  const g = c.getContext('2d');
  g.fillStyle = '#0b0d10'; g.fillRect(0, 0, 1200, 630);
  g.fillStyle = '#c6ff3d'; g.globalAlpha = .08; for (let i = 0; i < 12; i++) g.fillRect(i * 110, 0, 2, 630); g.globalAlpha = 1;
  g.font = '800 44px "Bricolage Grotesque", sans-serif'; g.fillStyle = '#eef2f6'; g.fillText('DRAFT', 60, 92);
  const w = g.measureText('DRAFT').width; g.fillStyle = '#c6ff3d'; g.fillText('PUMP', 60 + w, 92);
  g.fillStyle = '#8b95a3'; g.font = '500 30px "Bricolage Grotesque", sans-serif'; g.fillText(`@${t.name} · ${t.day}`, 60, 150);
  g.font = '700 150px "JetBrains Mono", monospace'; g.fillStyle = t.score >= 0 ? '#3ddc84' : '#ff5a5f'; g.fillText(pct(t.score), 52, 330);
  g.font = '700 30px "JetBrains Mono", monospace';
  t.picks.forEach((p, i) => {
    const x = 60 + (i % 3) * 370, y = 420 + Math.floor(i / 3) * 70;
    g.fillStyle = '#1a1e25'; g.beginPath(); g.roundRect(x - 14, y - 40, 350, 56, 14); g.fill();
    g.fillStyle = '#eef2f6'; g.fillText(`$${String(p.symbol).slice(0, 9)}`, x, y);
    g.fillStyle = p.pct >= 0 ? '#3ddc84' : '#ff5a5f'; const s = pct(p.pct); g.fillText(s, x + 320 - g.measureText(s).width, y);
  });
  g.fillStyle = '#8b95a3'; g.font = '500 24px "Bricolage Grotesque", sans-serif'; g.fillText(location.host + ' · fantasy memecoins', 60, 600);
  c.toBlob(async (blob) => {
    const file = new File([blob], `draftpump-${t.id}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'My DRAFTPUMP team' }); return; } catch { /* cancelled */ } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}

route();
