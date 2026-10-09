import test from 'node:test';
import assert from 'node:assert/strict';
import { PrizeLedger } from '../src/ledger.js';
import { sha256Hex, b58encode, b64decode, verifyEd25519 } from '../src/solana.js';
import { drawRound, prizeConfig, eligibleCandidates } from '../src/prize-core.js';

const W = ['4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'];

class MemStorage {   // the bits of the Durable Object storage API the ledger uses
  constructor() { this.m = new Map(); }
  async get(k) { return structuredClone(this.m.get(k)); }
  async put(k, v) { this.m.set(k, structuredClone(v)); }
  async delete(k) { for (const x of [].concat(k)) this.m.delete(x); }
  async list({ prefix = '', reverse = false, limit = Infinity } = {}) {
    let ks = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (reverse) ks.reverse();
    return new Map(ks.slice(0, limit).map((k) => [k, structuredClone(this.m.get(k))]));
  }
}

function fakeRpc(state) {
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    state.calls.push(method);
    const ok = (result) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
    if (method === 'getBalance') return ok({ value: state.balance });
    if (method === 'getTokenAccountsByOwner') return ok({ value: (state.holdings[params[0]] && params[1].programId.startsWith('Tokenkeg')) ? [{ account: { data: { parsed: { info: { mint: state.mint, tokenAmount: { uiAmountString: String(state.holdings[params[0]]) } } } } } }] : [] });
    if (method === 'getLatestBlockhash') return ok({ value: { blockhash: b58encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 99 } });
    if (method === 'sendTransaction') { state.sent.push(params[0]); return ok('SIG' + state.sent.length); }
    throw new Error('unexpected ' + method);
  };
}

async function treasury() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const seed = Buffer.from(jwk.d, 'base64url'), pub = Buffer.from(jwk.x, 'base64url');
  return { pub: b58encode(pub), pubBytes: Uint8Array.from(pub), secret: JSON.stringify([...seed, ...pub]) };
}

const players = [{ id: 'A', name: 'Ann', wallet: W[0] }, { id: 'B', name: 'Bo', wallet: W[1] }, { id: 'C', name: 'Cy', wallet: null }];

test('dry-run: commit hides the seed, settle reveals it, nothing is sent, cooldown + log recorded', async () => {
  const t = await treasury();
  const state = { balance: 10e9, calls: [], sent: [], holdings: {}, mint: null };
  const logs = [];
  const L = new PrizeLedger({ env: { SOLANA_RPC_URL: 'http://rpc', TREASURY_PUBLIC_KEY: t.pub }, storage: new MemStorage(), fetchFn: fakeRpc(state), log: (o) => logs.push(o) });
  const c = await L.commit('r1', 'ROOM1', 3);
  assert.match(c.hash, /^[0-9a-f]{64}$/);
  assert.equal(c.poolSol, 10);
  assert.ok(!JSON.stringify(c).includes('seed'));
  const rec = await L.settle({ round: 'r1', players, winners: ['A', 'B', 'C'] });
  assert.equal(rec.status, 'dry-run');
  assert.equal(await sha256Hex(rec.seed), c.hash);   // the reveal matches the commitment
  const again = await drawRound(rec.seed, 10e9, eligibleCandidates({ players, winners: ['A', 'B', 'C'], cfg: prizeConfig({ SOLANA_RPC_URL: 'x', TREASURY_PUBLIC_KEY: t.pub }) }).candidates, prizeConfig({ SOLANA_RPC_URL: 'x', TREASURY_PUBLIC_KEY: t.pub }));
  assert.equal(rec.winner.wallet, again.winner.wallet);
  assert.equal(rec.lamports, again.lamports);
  assert.equal(state.sent.length, 0);
  assert.ok(!state.calls.includes('sendTransaction'));
  assert.deepEqual(rec.rejected, [{ id: 'C', reason: 'no verified wallet' }]);
  assert.equal(logs[0].prize, 'dry-run');
  assert.equal((await L.recent()).length, 1);
  assert.equal((await L.settle({ round: 'r1', players, winners: ['A'] })).status, 'unknown round');   // settles once
  // the winner is now on cooldown: next round with only them wins nothing
  await L.commit('r2', 'ROOM1', 2);
  const r2 = await L.settle({ round: 'r2', players, winners: [rec.winner.id] });
  assert.equal(r2.status, 'void');
  assert.equal(r2.reason, 'no eligible winners');
});

test('skips: too few humans, void rounds still reveal', async () => {
  const t = await treasury();
  const state = { balance: 10e9, calls: [], sent: [], holdings: {} };
  const L = new PrizeLedger({ env: { SOLANA_RPC_URL: 'http://rpc', TREASURY_PUBLIC_KEY: t.pub, MIN_HUMAN_PLAYERS: '3' }, storage: new MemStorage(), fetchFn: fakeRpc(state), log: () => {} });
  assert.equal((await L.commit('x', 'R', 2)).skip, 'needs 3+ human players');
  const c = await L.commit('y', 'R', 3);
  const rec = await L.settle({ round: 'y', players, voidReason: 'players disagree on the result' });
  assert.equal(rec.status, 'void');
  assert.equal(await sha256Hex(rec.seed), c.hash);
});

test('token holding minimum is checked on-chain', async () => {
  const t = await treasury(), mint = 'So11111111111111111111111111111111111111112';
  const state = { balance: 10e9, calls: [], sent: [], holdings: { [W[0]]: 50, [W[1]]: 5000 }, mint };
  const L = new PrizeLedger({ env: { SOLANA_RPC_URL: 'http://rpc', TREASURY_PUBLIC_KEY: t.pub, TOKEN_MINT: mint, MIN_TOKEN_HOLDING: '1000' }, storage: new MemStorage(), fetchFn: fakeRpc(state), log: () => {} });
  await L.commit('r', 'R', 2);
  const rec = await L.settle({ round: 'r', players, winners: ['A', 'B'] });
  assert.equal(rec.winner.id, 'B');
  assert.deepEqual(rec.rejected, [{ id: 'A', reason: 'token holding below minimum' }]);
});

test('live mode (against a fake RPC): signs a transfer with the env key and records the signature', async () => {
  const t = await treasury();
  const state = { balance: 10e9, calls: [], sent: [], holdings: {} };
  const L = new PrizeLedger({ env: { SOLANA_RPC_URL: 'http://rpc', TREASURY_PUBLIC_KEY: t.pub, TREASURY_SECRET_KEY: t.secret, PAYOUT_MODE: 'live' }, storage: new MemStorage(), fetchFn: fakeRpc(state), log: () => {} });
  await L.commit('r', 'R', 2);
  const rec = await L.settle({ round: 'r', players, winners: ['A', 'B'] });
  assert.equal(rec.status, 'paid');
  assert.equal(rec.tx, 'SIG1');
  const tx = b64decode(state.sent[0]);
  assert.equal(await verifyEd25519(t.pubBytes, tx.slice(65), tx.slice(1, 65)), true);
  // a key that doesn't match TREASURY_PUBLIC_KEY is refused
  const other = await treasury();
  const bad = new PrizeLedger({ env: { SOLANA_RPC_URL: 'http://rpc', TREASURY_PUBLIC_KEY: t.pub, TREASURY_SECRET_KEY: other.secret, PAYOUT_MODE: 'live' }, storage: new MemStorage(), fetchFn: fakeRpc(state), log: () => {} });
  await bad.commit('r', 'R', 2);
  const f = await bad.settle({ round: 'r', players, winners: ['A'] });
  assert.equal(f.status, 'failed');
  assert.match(f.reason, /does not match/);
  assert.equal(state.sent.length, 1);
});

test('settles are serialised: concurrent rounds never read a stale pool', async () => {
  const t = await treasury();
  const state = { balance: 10e9, calls: [], sent: [], holdings: {} };
  const L = new PrizeLedger({ env: { SOLANA_RPC_URL: 'http://rpc', TREASURY_PUBLIC_KEY: t.pub, PRIZE_COOLDOWN_SEC: '0' }, storage: new MemStorage(), fetchFn: fakeRpc(state), log: () => {} });
  await L.commit('a', 'R', 2); await L.commit('b', 'S', 2);
  const [a, b] = await Promise.all([L.settle({ round: 'a', players, winners: ['A'] }), L.settle({ round: 'b', players, winners: ['B'] })]);
  assert.equal(a.status, 'dry-run'); assert.equal(b.status, 'dry-run');
  assert.equal(state.calls.filter((m) => m === 'getBalance').length, 3);   // commit (cached) + one fresh read per settle
});

test('disabled config: status says so and never calls the RPC', async () => {
  const state = { calls: [] };
  const L = new PrizeLedger({ env: {}, storage: new MemStorage(), fetchFn: fakeRpc(state), log: () => {} });
  assert.equal((await L.status()).enabled, false);
  assert.equal((await L.commit('r', 'R', 8)).skip, 'prizes disabled');
  assert.equal(state.calls.length, 0);
});
