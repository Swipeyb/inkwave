// Local preview: serves ../site and the API (League on Node's SQLite with a fake market). node --import ./test/cf-shim.mjs dev.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
const { League } = await import('./src/index.js');
const worker = (await import('./src/index.js')).default;
const db = new DatabaseSync(':memory:');
const storage = { sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows }; } } };
const lg = new League({ storage }, {});
const H = 3600e3, names = ['WIFHAT', 'GOOBER', 'PEPEK', 'MOONCAT', 'BONKER', 'TRUMPET', 'FROGGO', 'SHIBAI', 'NEIRO2', 'SIGMA', 'CHAD', 'GIGA', 'BRAINROT', 'DUCKY', 'POPCORN', 'ZOOM', 'RIZZ', 'YAPPER'];
const coins = names.map((s, i) => ({ mint: ('Mnt' + s + 'abcdefghjkmnpqrstuvwxyz123456789').slice(0, 40).replace(/[0OIl]/g, 'x'), s, p: 0.0001 * (1 + i), created: Date.now() - (0.5 + i * 0.9) * H }));
lg.fetchFn = async (url) => {
  const u = String(url); let body = [];
  if (u.includes('token-profiles') || u.includes('token-boosts')) body = coins.map((c) => ({ chainId: 'solana', tokenAddress: c.mint }));
  else if (u.includes('geckoterminal')) body = { data: [] };
  else if (u.includes('/tokens/v1/solana/')) body = u.split('/tokens/v1/solana/')[1].split(',').map((m) => coins.find((c) => c.mint === m)).filter(Boolean).map((c) => {
    c.p *= 1 + (Math.random() - 0.45) * 0.3;
    return { chainId: 'solana', url: 'https://dexscreener.com/solana/' + c.mint, baseToken: { address: c.mint, name: c.s[0] + c.s.slice(1).toLowerCase() + ' Coin', symbol: c.s }, priceUsd: String(c.p), liquidity: { usd: 15000 + Math.random() * 90000 }, marketCap: c.p * 1e9, volume: { h1: 5000 + Math.random() * 200000, h24: 1e6 }, priceChange: { h1: (Math.random() - 0.4) * 80, h24: 0 }, pairCreatedAt: c.created, info: {} };
  });
  return { ok: true, status: 200, json: async () => body };
};
await lg.refresh();
for (const n of ['degen_dan', 'sol_sister', 'apeking']) { const p = await lg.join(n); await lg.draft(p, coins.slice(Math.floor(Math.random() * 10), 50).slice(0, 5).map((c) => c.mint)); }
await lg.refresh();
setInterval(() => lg.refresh(), 15000);
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const env = { LEAGUE: { idFromName: () => 'main', get: () => lg } };
const types = { html: 'text/html', js: 'text/javascript', css: 'text/css' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const body = req.method === 'POST' ? await new Promise((r) => { let d = ''; req.on('data', (x) => (d += x)); req.on('end', () => r(d)); }) : undefined;
    const r = await worker.fetch(new Request('http://localhost:8600' + req.url, { method: req.method, headers: req.headers, body }), env, { waitUntil() {} });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return;
  }
  const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  try { const b = await readFile(new URL('../site/' + f, import.meta.url)); res.writeHead(200, { 'content-type': types[f.split('.').pop()] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(8600, '127.0.0.1', () => console.log('http://127.0.0.1:8600'));
