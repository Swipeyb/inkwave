// End-to-end check of the relay's prize pool (docs/PRIZE_POOL.md) against a FAKE Solana RPC — no chain, no funds.
//   1. node tools/prize-test.mjs --rpc            (starts the fake RPC on :8899 and prints the .dev.vars to use)
//   2. cd server && npx wrangler dev --port 8787  (with server/.dev.vars as printed)
//   or just: node tools/prize-test.mjs            (fake RPC + the whole scenario; expects the relay on :8787)
// Scenario: 3 humans join a room, two verify wallets by signing the relay's message, the host locks (match start) →
// commit; everyone reports the same winners → reveal: sha256(seed) must equal the commit, the prize must be within
// the configured range and go to a verified winner; then a disagreeing round must be void.
import http from 'node:http';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';

const RELAY = process.env.RELAY || 'ws://127.0.0.1:8787';
const TREASURY = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';   // any address: the fake RPC says it holds 12 SOL
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b) break; s = '1' + s; } return s; };

const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { id, method } = JSON.parse(body);
    const result = method === 'getBalance' ? { context: { slot: 1 }, value: 12e9 } : method === 'getTokenAccountsByOwner' ? { value: [] } : null;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result === null ? { jsonrpc: '2.0', id, error: { message: 'fake rpc: ' + method } } : { jsonrpc: '2.0', id, result }));
  });
}).listen(8899);
console.log(`fake RPC on :8899 — server/.dev.vars:\nSOLANA_RPC_URL=http://127.0.0.1:8899\nTREASURY_PUBLIC_KEY=${TREASURY}\nPAYOUT_MODE=dry-run\nPRIZE_COOLDOWN_SEC=0\n`);
if (process.argv.includes('--rpc')) await new Promise(() => {});

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };

function client(code, name, create) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RELAY}/room/${code}?name=${name}&v=1${create ? '&create=1' : ''}`, { origin: 'http://localhost:8490' });
    const c = { ws, name, inbox: [], waiters: [] };
    ws.on('message', (raw) => {
      const s = String(raw);
      if (s === 'pong' || s.startsWith('m|')) return;
      const o = JSON.parse(s);
      if (o.t === 'welcome') { c.id = o.id; resolve(c); }
      if (o.t === 'err') reject(new Error(o.e));
      const w = c.waiters.find((x) => x.f(o));
      if (w) { c.waiters.splice(c.waiters.indexOf(w), 1); w.res(o); } else c.inbox.push(o);
    });
    ws.on('error', reject);
  });
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const wait = (c, f, ms = 8000) => {
  const hit = c.inbox.find(f);
  if (hit) { c.inbox.splice(c.inbox.indexOf(hit), 1); return Promise.resolve(hit); }
  return new Promise((res, rej) => { const w = { f, res }; c.waiters.push(w); setTimeout(() => rej(new Error('timeout waiting on ' + c.name)), ms); });
};

async function verify(c) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pk = b58(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  send(c, { t: 'wallet', a: 'nonce' });
  const n = await wait(c, (o) => o.t === 'wallet' && o.a === 'nonce');
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(n.msg)));
  send(c, { t: 'wallet', a: 'prove', pk, sig: Buffer.from(sig).toString('base64') });
  const ok = await wait(c, (o) => o.t === 'wallet' && o.a !== 'nonce');
  c.wallet = ok.pk;
  return ok;
}

try {
  const st = await (await fetch(RELAY.replace(/^ws/, 'http') + '/prize')).json();
  check(st.enabled && st.poolSol === 12 && st.mode === 'dry-run', `GET /prize → enabled, pool ${st.poolSol} SOL, ${st.mode}`);
  check(!JSON.stringify(st).includes('8899'), 'GET /prize does not leak the RPC URL');

  const code = 'P' + Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  const A = await client(code, 'Ann', true), B = await client(code, 'Bo', false), C = await client(code, 'Cy', false);
  check((await verify(A)).a === 'ok', 'Ann verifies a wallet');
  check((await verify(B)).a === 'ok', 'Bo verifies a wallet');
  // a bad signature is refused
  send(C, { t: 'wallet', a: 'nonce' }); await wait(C, (o) => o.a === 'nonce');
  send(C, { t: 'wallet', a: 'prove', pk: A.wallet, sig: Buffer.alloc(64).toString('base64') });
  check((await wait(C, (o) => o.t === 'wallet' && o.a !== 'nonce')).a === 'err', 'a forged signature is rejected');

  for (let round = 0; round < 2; round++) {
    send(A, { t: 'lock', v: true });
    const commits = await Promise.all([A, B, C].map((c) => wait(c, (o) => o.t === 'prize' && o.a === 'commit')));
    check(commits.every((x) => x.hash === commits[0].hash) && /^[0-9a-f]{64}$/.test(commits[0].hash), `round ${round + 1}: everyone gets the same commit`);
    const winners = [A.id, B.id];
    send(A, { t: 'result', r: commits[0].round, w: winners });
    send(B, { t: 'result', r: commits[0].round, w: winners });
    send(C, { t: 'result', r: commits[0].round, w: round === 0 ? winners : [C.id] });   // round 2: C lies
    const rev = await wait(B, (o) => o.t === 'prize' && o.a === 'reveal');
    if (process.env.DEBUG) console.log(JSON.stringify(commits[0]), JSON.stringify(rev));
    check(createHash('sha256').update(rev.seed).digest('hex') === commits[0].hash, `round ${round + 1}: sha256(seed) == commit`);
    if (round === 0) {
      check(rev.status === 'dry-run' && [A.wallet, B.wallet].includes(rev.winner?.wallet), `round 1: dry-run prize to a verified winner (${rev.winner?.name} ${rev.winner?.wallet?.slice(0, 6)}…)`);
      check(rev.prizeSol >= 0.12 - 1e-9 && rev.prizeSol <= 0.6 + 1e-9, `round 1: prize ${rev.prizeSol} SOL within 1–5% of 12 SOL`);
    } else check(rev.status === 'void' && /disagree/.test(rev.reason), `round 2: disagreeing reports → void (${rev.reason})`);
    send(A, { t: 'lock', v: false });
    await new Promise((r) => setTimeout(r, 200));
  }
  const log = await (await fetch(RELAY.replace(/^ws/, 'http') + '/prize/log')).json();
  check(log.length >= 2 && log[0].seed && log[0].commit, `GET /prize/log lists settled rounds with seed + commit (${log.length})`);
  for (const c of [A, B, C]) c.ws.close();
} catch (e) { check(false, String(e.stack || e)); }
rpc.close();
console.log(fails ? `PRIZE TEST FAIL (${fails})` : 'PRIZE TEST OK');
process.exit(fails ? 1 : 0);
