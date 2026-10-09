// Minimal, dependency-free Solana helpers for the relay Worker: base58 / base64, Ed25519 via WebCrypto (works in
// Workers and Node ≥ 20), JSON-RPC, and a legacy-format System Program SOL transfer. Kept tiny on purpose: the relay
// is bundled on its own and only ever needs "read a balance", "verify a wallet signature" and "send one transfer".
// server/test/solana.test.mjs cross-checks the transaction bytes against @solana/web3.js.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const SYSTEM_PROGRAM = new Uint8Array(32);   // 11111111111111111111111111111111

export function b58encode(bytes) {
  bytes = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return '1'.repeat(zeros) + out;
}

export function b58decode(str) {
  if (typeof str !== 'string' || !str.length) throw new Error('empty base58');
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of str) { const v = B58_MAP.get(c); if (v === undefined) throw new Error('bad base58'); n = n * 58n + BigInt(v); }
  const body = [];
  while (n > 0n) { body.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

/** A 32-byte public key in base58, or null. */
export function parsePubkey(s) {
  try { const b = b58decode(String(s).trim()); return b.length === 32 ? b : null; } catch { return null; }
}

export function b64encode(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
export function b64decode(s) { const r = atob(s); const out = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) out[i] = r.charCodeAt(i); return out; }
const b64url = (bytes) => b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sha256Hex(str) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Verify a wallet's signMessage signature (Ed25519 over the exact message bytes). */
export async function verifyEd25519(pubkey32, message, sig64) {
  try {
    if (pubkey32.length !== 32 || sig64.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', pubkey32, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig64, typeof message === 'string' ? new TextEncoder().encode(message) : message);
  } catch { return false; }
}

/**
 * Parse a Solana keypair secret: a solana-keygen JSON array of 64 numbers, or a base58 string of the 64 bytes
 * (what wallets export). Returns { seed, pubkey } (32 bytes each). Throws on anything else.
 */
export function parseSecretKey(raw) {
  const s = String(raw || '').trim();
  let bytes;
  if (s.startsWith('[')) bytes = Uint8Array.from(JSON.parse(s));
  else bytes = b58decode(s);
  if (bytes.length !== 64) throw new Error('TREASURY_SECRET_KEY must be a 64-byte Solana keypair');
  return { seed: bytes.slice(0, 32), pubkey: bytes.slice(32) };
}

export async function importSigner({ seed, pubkey }) {
  const jwk = { kty: 'OKP', crv: 'Ed25519', d: b64url(seed), x: b64url(pubkey), ext: false };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
  return { pubkey, sign: async (msg) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, msg)) };
}

function compactU16(n) {
  const out = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n) { out.push(b | 0x80); } else { out.push(b); return out; } }
}
function u64le(n) {
  let v = BigInt(n); const out = [];
  for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
  return out;
}

/** Legacy message for one SystemProgram.transfer(from → to, lamports), fee payer = from. */
export function transferMessage(from32, to32, lamports, blockhash32) {
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error('bad lamports');
  const data = [2, 0, 0, 0, ...u64le(lamports)];   // SystemInstruction::Transfer = 2
  return Uint8Array.from([
    1, 0, 1,                                     // header: 1 signer, 0 readonly signed, 1 readonly unsigned (system)
    ...compactU16(3), ...from32, ...to32, ...SYSTEM_PROGRAM,
    ...blockhash32,
    ...compactU16(1), 2, ...compactU16(2), 0, 1, ...compactU16(data.length), ...data,
  ]);
}

export async function signedTransfer(signer, to32, lamports, blockhash32) {
  const msg = transferMessage(signer.pubkey, to32, lamports, blockhash32);
  const sig = await signer.sign(msg);
  return { tx: Uint8Array.from([...compactU16(1), ...sig, ...msg]), signature: b58encode(sig) };
}

// ---- JSON-RPC ---------------------------------------------------------------------------------------------------------
export async function rpc(url, method, params = [], fetchFn = fetch) {
  const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw new Error(`rpc ${method}: http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

export async function getBalanceLamports(url, pubkey, fetchFn) {
  const r = await rpc(url, 'getBalance', [pubkey, { commitment: 'confirmed' }], fetchFn);
  return Number(r?.value ?? r ?? 0);
}

/** Total UI amount of `mint` held by `owner` across its token accounts (SPL Token and Token-2022). */
export async function getTokenHolding(url, owner, mint, fetchFn) {
  let total = 0;
  for (const programId of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    let r;
    try { r = await rpc(url, 'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }], fetchFn); } catch { continue; }
    for (const acc of r?.value || []) {
      const info = acc?.account?.data?.parsed?.info;
      if (info?.mint === mint) total += Number(info.tokenAmount?.uiAmountString ?? info.tokenAmount?.uiAmount ?? 0);
    }
  }
  return total;
}

export async function sendTransfer(url, signer, to32, lamports, fetchFn) {
  const bh = await rpc(url, 'getLatestBlockhash', [{ commitment: 'confirmed' }], fetchFn);
  const { tx, signature } = await signedTransfer(signer, to32, lamports, b58decode(bh.value.blockhash));
  const sent = await rpc(url, 'sendTransaction', [b64encode(tx), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }], fetchFn);
  return { signature: sent || signature, lastValidBlockHeight: bh.value.lastValidBlockHeight };
}
