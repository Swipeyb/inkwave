// node --test server/test   (no dependencies; the @solana/web3.js cross-check runs only if it is installed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { b58encode, b58decode, parsePubkey, verifyEd25519, parseSecretKey, importSigner, signedTransfer, transferMessage, b64encode, b64decode, sha256Hex } from '../src/solana.js';

async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const dec = (s) => Uint8Array.from(Buffer.from(s, 'base64url'));
  return { seed: dec(jwk.d), pubkey: dec(jwk.x), privateKey: kp.privateKey };
}

test('base58 round-trips, keeps leading zeros, matches known vectors', () => {
  assert.equal(b58encode(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.equal(b58encode(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
  for (const bytes of [[0, 0, 1, 2, 3], [255, 254], [], [0]]) assert.deepEqual([...b58decode(b58encode(bytes) || '1')], bytes.length ? bytes : [0]);
  assert.throws(() => b58decode('0OIl'));
  assert.equal(parsePubkey('So11111111111111111111111111111111111111112')?.length, 32);
  assert.equal(parsePubkey('not a key'), null);
  assert.equal(parsePubkey('abc'), null);
});

test('base64 and sha256 helpers', async () => {
  const b = Uint8Array.from([0, 1, 2, 250, 251, 255]);
  assert.deepEqual([...b64decode(b64encode(b))], [...b]);
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('wallet signMessage proofs verify, tampering fails', async () => {
  const k = await keypair();
  const msg = 'SPLATR prize wallet check\nnonce: 123';
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, k.privateKey, new TextEncoder().encode(msg)));
  assert.equal(await verifyEd25519(k.pubkey, msg, sig), true);
  assert.equal(await verifyEd25519(k.pubkey, msg + 'x', sig), false);
  const other = await keypair();
  assert.equal(await verifyEd25519(other.pubkey, msg, sig), false);
  assert.equal(await verifyEd25519(k.pubkey, msg, sig.slice(0, 10)), false);
});

test('secret key parsing: solana-keygen JSON array and base58', async () => {
  const k = await keypair();
  const full = Uint8Array.from([...k.seed, ...k.pubkey]);
  for (const raw of [JSON.stringify([...full]), b58encode(full)]) {
    const p = parseSecretKey(raw);
    assert.deepEqual([...p.pubkey], [...k.pubkey]);
    assert.deepEqual([...p.seed], [...k.seed]);
  }
  assert.throws(() => parseSecretKey('[1,2,3]'));
});

test('transfer transaction: signed by the treasury, decodes as a System transfer', async () => {
  const k = await keypair(), to = (await keypair()).pubkey, bh = crypto.getRandomValues(new Uint8Array(32));
  const signer = await importSigner(k);
  const { tx, signature } = await signedTransfer(signer, to, 123456789, bh);
  assert.equal(tx[0], 1);
  const sig = tx.slice(1, 65), msg = tx.slice(65);
  assert.deepEqual([...msg], [...transferMessage(k.pubkey, to, 123456789, bh)]);
  assert.equal(await verifyEd25519(k.pubkey, msg, sig), true);
  assert.equal(signature, b58encode(sig));
  assert.throws(() => transferMessage(k.pubkey, to, 0, bh));
  assert.throws(() => transferMessage(k.pubkey, to, 1.5, bh));

  let web3;
  try { web3 = await import('@solana/web3.js'); } catch { return; }   // optional cross-check
  const decoded = web3.Transaction.from(Buffer.from(tx));
  assert.equal(decoded.verifySignatures(), true);
  const ix = web3.SystemInstruction.decodeTransfer(decoded.instructions[0]);
  assert.equal(ix.fromPubkey.toBase58(), b58encode(k.pubkey));
  assert.equal(ix.toPubkey.toBase58(), b58encode(to));
  assert.equal(Number(ix.lamports), 123456789);
  const ref = new web3.Transaction({ feePayer: new web3.PublicKey(k.pubkey), recentBlockhash: b58encode(bh) })
    .add(web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(k.pubkey), toPubkey: new web3.PublicKey(to), lamports: 123456789 }));
  assert.deepEqual([...ref.serializeMessage()], [...msg]);
});

test('multi-transfer: one payment is byte-identical to the single transfer; two payments have two instructions', async () => {
  const { multiTransferMessage, transferMessage } = await import('../src/solana.js');
  const from = new Uint8Array(32).fill(7), a = new Uint8Array(32).fill(1), b = new Uint8Array(32).fill(2), bh = new Uint8Array(32).fill(9);
  assert.deepEqual([...multiTransferMessage(from, [{ to: a, lamports: 5000000 }], bh)], [...transferMessage(from, a, 5000000, bh)]);
  const m = multiTransferMessage(from, [{ to: a, lamports: 1000000 }, { to: b, lamports: 2000000 }], bh);
  assert.deepEqual([...m.slice(0, 4)], [1, 0, 1, 4]);                 // fee payer + 2 recipients + system program
  assert.equal(m[4 + 4 * 32 + 32], 2);                                 // two instructions
  assert.throws(() => multiTransferMessage(from, [], bh));
});
