# Orderflow Volume Clusters — MVP

This repo contains a minimal MVP that:
- backfills trades from multiple exchanges (Binance, OKX, Bybit) into a local SQLite DB
- computes simple price-bucket volume clusters from stored trades
- serves a small mobile-friendly web UI to query top clusters

## Files
- server/ (Node.js server)
  - package.json
  - index.js
  - data.sqlite (created at runtime)
- web/
  - index.html (mobile UI)

## Run locally (step-by-step)

1. Save files (they are in this ZIP).
2. Install Node.js (>=16 recommended).
3. Start:
```bash
cd server
npm install
node index.js
# or for dev:
# npx nodemon index.js
```
4. Open http://localhost:3000 on your phone or desktop.

## Backfill example (populate DB)
To fetch recent trades (Binance example):
```bash
curl -X POST http://localhost:3000/api/backfill \
 -H "Content-Type: application/json" \
 -d '{"symbol":"BTCUSDT","exchange":"binance"}'
```
You can include `startTs` and `endTs` (ms) for a specific window.

## Quick troubleshooting
- CORS: UI served by server, so same origin; if hosting UI separately, enable CORS or proxy.
- Rate limits: Exchanges rate-limit — for large backfills add more robust pagination and exponential backoff.
- OKX / Bybit: The public endpoints differ by contract type; adjust symbol mapping for spot vs swap.
- Permissions: `better-sqlite3` may need build tools on some platforms (install build-essential / Python on Linux).
- If `npm install` fails on `better-sqlite3`, run:
  - `npm i --build-from-source better-sqlite3` or use `sqlite3` as alternative.

## Next steps (suggestions)
- Add job queue for backfill, durable state and progress tracking.
- Use exchange websockets to capture live trades for streaming clusters.
- Improve bucket logic to respect tick size / instrument increments.
- Add authentication and deploy to Railway / Render with Dockerfile/docker-compose.

-- End of README
