# $SPLURT prize pool (optional)

> **Legal warning — read before going live.** Paying random cash (SOL) prizes to players, funded by trading fees of a
> token people can buy (here $SPLURT), may be regulated as **gambling, a lottery or a sweepstakes**, and the token itself may be
> treated as a **security** (prizes funded by its trading volume can look like a return on holding it). Rules differ by
> country and by US state; some ban this outright, others require licences, age checks, KYC/AML, tax reporting or a
> free way to enter. **Get legal advice before setting `PAYOUT_MODE=live`.** Nothing here is legal advice. The default
> is dry-run: prizes are drawn and logged but nothing is ever sent.

The game is unchanged when this is not configured: no wallet UI, no requests, no prizes. Offline / solo play never
has prizes.

## How it works

1. **Fees → treasury.** Launch the $SPLURT coin (e.g. on pump.fun) with a creator wallet you control, or point creator fees at
   a dedicated *treasury* wallet. Creator trading fees accumulate there (on pump.fun you claim them to the creator
   wallet; move them to the treasury if they differ). The treasury's SOL balance **is** the prize pool.
2. **Players link a wallet.** In an online room the lobby shows a *Prize pool* card. "Connect wallet" uses the
   browser's injected Solana wallet (Phantom, Solflare, Backpack…) and asks it to **sign a one-time text message**
   from the relay (no transaction, no spending approval). The relay checks the Ed25519 signature, so a player can only
   claim a wallet they hold. One wallet per player per room; it can't change while a match runs.
3. **Match start — commit.** When the host starts a match the relay snapshots the humans in the room and their
   verified wallets, and the ledger draws a secret 32-byte seed and announces only `commit = sha256(seed)` to
   everyone (shown as a toast).
4. **Match end — reveal + draw.** Every human's browser reports the winners it was shown. If all remaining humans agree,
   the ledger:
   - keeps the winning team's humans who: have a verified wallet, are still connected, aren't the treasury, aren't on
     cooldown, (optionally) hold ≥ `MIN_TOKEN_HOLDING` $SPLURT (`TOKEN_MINT`), and drops repeated wallets;
   - reads the pool balance and draws `pct` uniformly in [`PRIZE_MIN_PCT`, `PRIZE_MAX_PCT`];
     `prize = min(pool·pct, PRIZE_MAX_SOL, pool − PRIZE_RESERVE_SOL − fee)` (skipped below 0.001 SOL);
   - picks one candidate (sorted by address) with the seed;
   - pays it (live) or logs what it would pay (dry-run), puts the wallet on cooldown, and reveals the seed.
   The results screen shows a banner: amount, winner, seed (and tx signature when live).
5. Rounds that don't qualify (fewer than `MIN_HUMAN_PLAYERS` humans, e.g. one player + bots; players disagreeing on
   the result; nobody eligible; pool too small) are void, and still reveal their seed.

### Verifying a round

Every settled round is in `GET <relay>/prize/log` (latest first) with `commit`, `seed`, `candidates`, `poolSol`,
`pct`, `prizeSol`, `winner` and `tx`. Anyone can check:

```sh
echo -n "<seed>" | sha256sum            # must equal the commit shown at match start
# u = first 8 bytes of sha256("<seed>:amount") / 2^64      → pct = MIN + u·(MAX−MIN)
# i = first 8 bytes of sha256("<seed>:winner") mod n        → winner = candidates[i] (sorted by address)
echo -n "<seed>:winner" | sha256sum
```

`drawRound()` in `server/src/prize-core.js` is the reference implementation. The tx signature can be looked up on
any Solana explorer.

### Trust model / known limits

- The relay is the authority for wallets, randomness, eligibility and payouts; the key lives only in its env.
- **Who won** is still decided by the host's browser (the game is host-simulated: see NET.md). Every human must report
  the same winners or the round is void, but a modified host client could lie to everyone. The random pick inside the
  winning team, the cooldown, the cap and the minimum-humans rule limit what that's worth; for real money consider
  requiring more humans, a token holding, smaller caps, and watching `/prize/log`. A fully server-simulated match
  would be needed to remove this.
- Several browsers controlled by one person count as several humans (each needs its own wallet). Raise
  `MIN_HUMAN_PLAYERS` / `MIN_TOKEN_HOLDING` to make farming costlier.
- A room that dies mid-match never reveals its seed (no prize was drawn for it).

### Example

Pool = 12 SOL of $SPLURT creator fees, defaults (1–5 %, max 1 SOL, 0.05 SOL reserve). A round draws u = 0.55 →
pct = 1 + 0.55·4 = 3.2 % → prize 0.384 SOL to one verified winner on the winning team who holds ≥ `MIN_TOKEN_HOLDING`
$SPLURT and hasn't won in the last hour.

## Quick Play

The online hub's **Quick Play** button asks the relay (`GET /quick`) for the next public room: the `Matchmaker`
Durable Object returns the fullest public room that has space and isn't mid-match, or a fresh code. Public room codes
are 6 characters starting with `QP` (private codes stay 5 characters and work as before). The first player in hosts;
30 s after a second player arrives the host's game starts the match (5 s once all 8 slots are taken), and bots fill
the empty slots. After the results the room stays open and the next countdown starts on its own. The lobby's prize
card shows what this match pays (`prizeMinSol`/`prizeMaxSol` from `GET /prize`).

## Configuration (relay env)

See `.env.example`. Off unless both `SOLANA_RPC_URL` and `TREASURY_PUBLIC_KEY` are set.

| var | default | |
|---|---|---|
| `SOLANA_RPC_URL` | — | JSON-RPC endpoint (devnet for testing; a paid provider for mainnet). Never sent to clients. |
| `TREASURY_PUBLIC_KEY` | — | wallet that receives creator fees and pays prizes |
| `TREASURY_SECRET_KEY` | — | **secret**: keypair JSON array or base58. Only needed for live. `wrangler secret put` only. |
| `PAYOUT_MODE` | `dry-run` | anything other than exactly `live` is dry-run |
| `TOKEN_MINT` | — | the $SPLURT mint address (for the holding check / shown in the UI) |
| `PRIZE_PCT` | — | fixed prize per match, % of the pool (overrides the range below) |
| `PRIZE_MIN_PCT` / `PRIZE_MAX_PCT` | 1 / 5 | prize range, % of the pool (when `PRIZE_PCT` is empty) |
| `PRIZE_MAX_SOL` | 1 | cap per round |
| `PRIZE_RESERVE_SOL` | 0.05 | never paid out |
| `MIN_HUMAN_PLAYERS` | 2 | humans **with a verified wallet** at match start for a prize round; at the end there must be a wallet holder on **each** team (no farming with two wallets on one side) |
| `MIN_TOKEN_HOLDING` | 0 | $SPLURT a winner must hold (e.g. `100000` = 100k $SPLURT) |
| `PRIZE_COOLDOWN_SEC` | 3600 | a wallet can win once per this many seconds |

## Running it

Local, dry-run (needs Node ≥ 22 for wrangler):

```sh
npm install
cp .env.example server/.dev.vars     # fill TREASURY_PUBLIC_KEY (any devnet address); keep PAYOUT_MODE=dry-run
npm run relay                        # relay on :8787 (wrangler dev)
npm run serve                        # game on :8490 → http://localhost:8490, Online → create a room
```

Open a second browser profile (or another machine on the LAN) to join with a second human. Tests:
`npm test` (unit tests, no network) and `node tools/prize-test.mjs` (end-to-end against the local relay with a fake
RPC — start it first with `node tools/prize-test.mjs --rpc` and the `.dev.vars` it prints).

### Deploying (playsplurt.online)

The relay only accepts browsers from `https://playsplurt.online`, `https://www.playsplurt.online`,
`https://splurt.pages.dev` (+ preview subdomains), the original INKWAVE site and localhost / LAN (`ORIGIN_OK` in
`server/src/index.js`). The client picks its relay in `relayURL()` (`src/net/transport.js`): on `playsplurt.online`,
its subdomains and `splurt.pages.dev` it connects to **`wss://api.playsplurt.online`** (`SPLURT_RELAY`); localhost uses
`ws://localhost:8787`; `?relay=wss://…` overrides everything.

Current setup: `server/wrangler.jsonc` routes the custom domain `api.playsplurt.online` to the `inkwave-net` Worker
(`cd server && npx wrangler deploy`). The static client is the Cloudflare Pages project **`splurt`**: run
`python3 tools/build-dist.py`, copy `dist/` to a temp folder (drop `.vercel`/`vercel.json`, add a `_headers` file with
`Cache-Control: public, max-age=0, must-revalidate`) and `npx wrangler pages deploy . --project-name splurt --branch main`
from that folder. `playsplurt.online` and `www.playsplurt.online` are attached as Pages custom domains; each needs a
proxied DNS `CNAME` → `splurt.pages.dev` in the zone.

Production (Cloudflare): `cd server && npx wrangler deploy` with the vars set in `wrangler.jsonc` / the dashboard,
then `npx wrangler secret put TREASURY_SECRET_KEY` and set `PAYOUT_MODE=live` only after legal review and a devnet
trial. Use a dedicated treasury wallet holding only the pool, never your main wallet. Payouts are logged as JSON lines
(`wrangler tail`) and kept in `/prize/log`.

## Code

- `server/src/prize-core.js` — config, commit-reveal draws, prize math, eligibility, consensus (pure, unit-tested)
- `server/src/ledger.js` — the ledger (one Durable Object `Prizes`): commits, cooldowns, pool reads, payouts, log
- `server/src/solana.js` — base58, Ed25519 (WebCrypto), JSON-RPC, a hand-built System transfer (byte-for-byte
  checked against `@solana/web3.js` in the tests when it is installed) — no runtime dependencies in the Worker
- `server/src/index.js` — relay wiring: `/prize`, `/prize/log`, wallet proofs, round start/settle
- `src/ui/prize.js` — lobby card, commit toast, results banner; `src/net/session.js` reports results
- `server/test/*.test.mjs` (`npm test`), `tools/prize-test.mjs`
