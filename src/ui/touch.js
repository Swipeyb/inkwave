// Touch controls for phones / tablets. Only active when index.html marked the page `is-touch` (no hover + coarse
// pointer, or ?touch=1 for testing on a desktop). Desktop keyboard / mouse / gamepad play is untouched.
//
//   left half   : floating joystick (appears where your thumb lands) → input.touchMove {x, y}
//   right half  : drag to aim → input.mouse.dx / dy (same path the mouse uses)
//   buttons     : SHOOT (hold; you can also drag on it to aim while firing), GOO (hold = swim), JUMP, BOMB, SPECIAL,
//                 MAP (hold) and PAUSE. They press the same keys / mouse buttons the desktop controls use, so every game
//                 system (specials, super jump map, Vortex Strike targeting …) works without touch-specific code.
import { G } from '../core/ctx.js';

export const IS_TOUCH = typeof document !== 'undefined' && document.documentElement.classList.contains('is-touch');

const LOOK_GAIN = 2.3;      // touch px → "mouse px" (a phone screen is far narrower than a mouse pad)
const STICK_R = 70;         // joystick radius (CSS px of the scaled page)

const CSS = `
.iw-touch { position: fixed; inset: 0; z-index: 12; pointer-events: none; touch-action: none; -webkit-touch-callout: none; }
.iw-touch.is-on { pointer-events: auto; }
.iw-touch[hidden] { display: none; }
.iw-touch__zone { position: absolute; top: 0; bottom: 0; touch-action: none; }
.iw-touch__zone--l { left: 0; width: 42%; }
.iw-touch__zone--r { right: 0; width: 58%; }
.iw-touch__stick { position: absolute; width: ${STICK_R * 2}px; height: ${STICK_R * 2}px; margin: -${STICK_R}px 0 0 -${STICK_R}px; border-radius: 50%;
  background: rgba(255,255,255,.08); box-shadow: inset 0 0 0 3px rgba(255,255,255,.28); pointer-events: none; opacity: .55; transition: opacity .15s; }
.iw-touch__stick.is-active { opacity: 1; }
.iw-touch__knob { position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%;
  background: rgba(255,255,255,.55); box-shadow: 0 4px 14px rgba(0,0,0,.35); }
.iw-touch__btn { position: absolute; display: grid; place-items: center; border-radius: 50%; touch-action: none; pointer-events: auto;
  background: rgba(20,16,32,.45); color: #fff; box-shadow: inset 0 0 0 3px rgba(255,255,255,.35); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px);
  font: 400 15px/1 'Titan One', Rubik, system-ui, sans-serif; letter-spacing: .04em; text-shadow: 0 2px 4px rgba(0,0,0,.5); user-select: none; -webkit-user-select: none; }
.iw-touch__btn.is-down { background: rgba(140,245,207,.55); box-shadow: inset 0 0 0 3px #fff; transform: scale(.94); }
.iw-touch__btn--fire { width: 132px; height: 132px; right: 150px; bottom: 70px; font-size: 20px; background: rgba(255,80,140,.42); }
.iw-touch__btn--goo  { width: 96px; height: 96px; right: 40px; bottom: 40px; }
.iw-touch__btn--jump { width: 86px; height: 86px; right: 46px; bottom: 156px; }
.iw-touch__btn--sub  { width: 78px; height: 78px; right: 300px; bottom: 40px; font-size: 13px; }
.iw-touch__btn--sp   { width: 86px; height: 86px; right: 150px; bottom: 222px; font-size: 13px; }
.iw-touch__btn--map  { width: 70px; height: 70px; right: 24px; top: 112px; font-size: 13px; border-radius: 18px; }
.iw-touch__btn--pause { width: 58px; height: 58px; left: 16px; top: 16px; font-size: 20px; border-radius: 16px; }
.iw-touch__btn small { display: block; font: 600 10px/1 Rubik, system-ui, sans-serif; opacity: .8; margin-top: 2px; }

.iw-rotate { position: fixed; inset: 0; z-index: 100; display: none; place-items: center; text-align: center; padding: 24px;
  background: #0d1020; color: #fff; font: 500 16px/1.4 Rubik, system-ui, sans-serif; }
.iw-rotate b { display: block; font: 400 28px/1.1 'Titan One', Rubik, sans-serif; color: #8cf5cf; margin: 18px 0 8px; }
.iw-rotate i { display: block; width: 64px; height: 110px; margin: 0 auto; border: 5px solid #fff; border-radius: 14px; animation: iwRot 1.8s ease-in-out infinite; }
@keyframes iwRot { 0%, 25% { transform: rotate(0) } 60%, 100% { transform: rotate(-90deg) } }
@media (orientation: portrait) { html.is-touch .iw-rotate { display: grid; } }
.iw-rotate__app { margin-top: 22px; max-width: 320px; color: #c9d2e3; font-size: 15px; }
.iw-rotate__btn { display: block; box-sizing: border-box; text-align: center; width: 100%; margin-top: 12px; padding: 14px 18px; border: 0; border-radius: 14px; background: #8cf5cf; color: #10261d;
  font: 400 18px/1 'Titan One', Rubik, sans-serif; text-decoration: none; }
.iw-rotate__btn--ghost { background: rgba(255,255,255,.1); color: #fff; }
.iw-rotate__app small { display: block; margin-top: 10px; color: #8f9ab0; font-size: 13px; }

/* no double-tap zoom / long-press menus anywhere in the game */
html.is-touch, html.is-touch body { touch-action: manipulation; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }
html.is-touch #app canvas { touch-action: none; }
/* keyboard / gamepad hints mean nothing on a phone */
html.is-touch .iw-prompts, html.is-touch .iw-kbm, html.is-touch .iw-padg, html.is-touch .iw-key { display: none !important; }
/* bigger tap targets in menus on touch screens */
html.is-touch .iw-ca__btn { min-height: 34px; padding-left: 14px; padding-right: 14px; }
`;

export function installTouch(game) {
  if (!IS_TOUCH) return null;
  const input = game.input;
  input.touchMove = { x: 0, y: 0 };

  // iOS ignores user-scalable=no: block pinch-zoom gestures so the page never zooms mid-match
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  // "rotate your phone" (portrait); shown by CSS only
  const rot = document.createElement('div');
  rot.className = 'iw-rotate';
  rot.innerHTML = '<div><i></i><b>Turn your phone sideways</b>SPLATR plays in landscape.</div>';
  // In-app browsers (X, Telegram, Discord, Instagram…) usually can't rotate at all: offer to open the real browser
  const ua = navigator.userAgent || '';
  const inApp = /Twitter|TwitterAndroid|FBAN|FBAV|Instagram|Telegram|Discord|TikTok|musical_ly|Snapchat|Line\/|; wv\)/i.test(ua);
  if (inApp) {
    const android = /Android/i.test(ua), ios = /iPhone|iPad|iPod/i.test(ua);
    const url = location.href.replace(/^https?:\/\//, '');
    const open = android ? `intent://${url}#Intent;scheme=https;package=com.android.chrome;end` : ios ? `x-safari-https://${url}` : location.href;
    const box = document.createElement('div');
    box.className = 'iw-rotate__app';
    box.innerHTML = `This app’s built-in browser can’t turn sideways. Open SPLATR in ${android ? 'Chrome' : ios ? 'Safari' : 'your browser'} to play:
      <a class="iw-rotate__btn" href="${open}">Open in ${android ? 'Chrome' : ios ? 'Safari' : 'browser'}</a>
      <button class="iw-rotate__btn iw-rotate__btn--ghost" type="button">Copy link</button>
      <small>Or tap the ${ios ? '⋯' : '⋮'} menu up top and choose “Open in browser”.</small>`;
    box.querySelector('button').onclick = async (e) => {
      try { await navigator.clipboard.writeText(location.href.split('#')[0]); e.target.textContent = 'Link copied'; }
      catch { e.target.textContent = location.host; }
    };
    rot.firstChild.appendChild(box);
  }
  document.body.appendChild(rot);

  const root = document.createElement('div');
  root.className = 'iw-touch';
  root.hidden = true;
  const zl = div('iw-touch__zone iw-touch__zone--l'), zr = div('iw-touch__zone iw-touch__zone--r');
  const stick = div('iw-touch__stick'), knob = div('iw-touch__knob');
  stick.appendChild(knob);
  root.append(zl, zr, stick);
  document.body.appendChild(root);

  const markTouch = () => { input.lastDevice = 'touch'; };

  // ---- joystick (left zone)
  let stickId = null, sx = 0, sy = 0;
  const restStick = () => { const r = root.getBoundingClientRect(); stick.style.left = `${Math.round(r.width * 0.14)}px`; stick.style.top = `${Math.round(r.height * 0.7)}px`; };
  restStick();
  zl.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    e.preventDefault(); markTouch();
    stickId = e.pointerId; sx = e.clientX; sy = e.clientY;
    try { zl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    stick.style.left = `${sx}px`; stick.style.top = `${sy}px`;
    stick.classList.add('is-active');
    knob.style.transform = '';
  });
  zl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    let dx = e.clientX - sx, dy = e.clientY - sy;
    const m = Math.hypot(dx, dy);
    if (m > STICK_R) { dx *= STICK_R / m; dy *= STICK_R / m; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const kx = dx / STICK_R, ky = dy / STICK_R, k = Math.hypot(kx, ky), dz = 0.12;
    const sc = k < dz ? 0 : (k - dz) / (1 - dz) / k;   // radial dead zone, full speed at the rim
    input.touchMove.x = kx * sc; input.touchMove.y = ky * sc;
  });
  const endStick = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null; input.touchMove.x = input.touchMove.y = 0;
    knob.style.transform = ''; stick.classList.remove('is-active'); restStick();
  };
  zl.addEventListener('pointerup', endStick); zl.addEventListener('pointercancel', endStick);

  // ---- look (right zone + while holding SHOOT)
  const looks = new Map();   // pointerId → {x, y}
  const lookStart = (e) => { looks.set(e.pointerId, { x: e.clientX, y: e.clientY }); markTouch(); };
  const lookMove = (e) => {
    const p = looks.get(e.pointerId);
    if (!p) return;
    input.mouse.dx += (e.clientX - p.x) * LOOK_GAIN;
    input.mouse.dy += (e.clientY - p.y) * LOOK_GAIN;
    p.x = e.clientX; p.y = e.clientY;
  };
  const lookEnd = (e) => { looks.delete(e.pointerId); };
  zr.addEventListener('pointerdown', (e) => { e.preventDefault(); try { zr.setPointerCapture(e.pointerId); } catch { /* ignore */ } lookStart(e); });
  zr.addEventListener('pointermove', lookMove);
  zr.addEventListener('pointerup', lookEnd); zr.addEventListener('pointercancel', lookEnd);

  // ---- buttons
  const keyDown = (code) => { input.keys.add(code); input.pressed.add(code); };
  const keyUp = (code) => { input.keys.delete(code); };
  const button = (cls, label, sub, down, up, { aim = false } = {}) => {
    const b = div(`iw-touch__btn iw-touch__btn--${cls}`);
    b.innerHTML = sub ? `<span>${label}<small>${sub}</small></span>` : label;
    const ids = new Set();
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); markTouch();
      try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (!ids.size) { b.classList.add('is-down'); down(); }
      ids.add(e.pointerId);
      if (aim) lookStart(e);
    });
    if (aim) b.addEventListener('pointermove', lookMove);
    const end = (e) => {
      if (!ids.delete(e.pointerId)) return;
      if (aim) lookEnd(e);
      if (!ids.size) { b.classList.remove('is-down'); up(); }
    };
    b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
    b._release = () => { if (ids.size) { ids.clear(); b.classList.remove('is-down'); up(); } };
    root.appendChild(b);
    return b;
  };
  const btns = [
    button('fire', 'SHOOT', '', () => { input.mouse.left = true; input.mouse.leftPressed = true; }, () => { input.mouse.left = false; }, { aim: true }),
    button('goo', 'GOO', 'swim', () => keyDown('ShiftLeft'), () => keyUp('ShiftLeft')),
    button('jump', 'JUMP', '', () => keyDown('Space'), () => keyUp('Space')),
    button('sub', 'BOMB', '', () => { input.mouse.right = true; input.mouse.rightPressed = true; }, () => { input.mouse.right = false; }),
    button('sp', 'SPECIAL', '', () => keyDown('KeyF'), () => keyUp('KeyF')),
    button('map', 'MAP', 'hold', () => keyDown('Tab'), () => keyUp('Tab')),
    button('pause', '❚❚', '', () => game.pause(), () => {}),
  ];

  const releaseAll = () => {
    for (const b of btns) b._release();
    looks.clear();
    stickId = null; input.touchMove.x = input.touchMove.y = 0; knob.style.transform = ''; stick.classList.remove('is-active');
  };

  // show the controls only during a live round with no menu on top
  let on = false;
  setInterval(() => {
    const m = game.match;
    const live = !!(G.mode === 'match' && m && !m.attract && !m.paused && !game.menus?.current && (m.state === 'playing' || m.state === 'intro'));
    if (live !== on) {
      on = live;
      root.hidden = !live;
      root.classList.toggle('is-on', live);
      if (!live) releaseAll();
      else restStick();
    }
  }, 150);
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  // first tap anywhere: start audio (desktop does this on the first key press). No fullscreen request: in fullscreen
  // Chrome ignores the viewport scaling from index.html and every screen would render at phone size.
  const first = () => {
    if (!game._audioOn) {
      game._audioOn = true;
      G.audio?.init?.(); game._applyAudioVolumes?.();
      game._playMusic?.(game.menus?.current === 'title' || !game.menus ? 'title' : 'menu');
    }
    removeEventListener('pointerup', first, true);
  };
  addEventListener('pointerup', first, true);

  return { root, releaseAll };
}

function div(cls) { const d = document.createElement('div'); d.className = cls; return d; }
