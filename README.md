# DRAFTPUMP

Fantasy memecoins: draft 5 fresh Solana launches a day; your score is their average % move over the next 24 hours.

- `site/`: the web app (plain HTML/CSS/JS, phone-first)
- `api/`: one Cloudflare Worker that serves `site/` and the API under `/api/`, a Durable Object (`League`, SQLite) holding
  players, the draft pool, teams and scores, and a 5-minute cron that pulls launches and prices from DexScreener / GeckoTerminal.
- No wallets: players pick a nickname; the device keeps a secret token.

Local preview: `cd api && node --import ./test/cf-shim.mjs dev.mjs` → http://127.0.0.1:8600 (fake market).
Tests: `cd api && npm test`. Deploys: push to `main` (GitHub Actions → `wrangler deploy`).
