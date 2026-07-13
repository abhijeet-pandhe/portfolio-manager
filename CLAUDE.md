# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal Node.js CLI that implements a Nifty 50 momentum portfolio strategy. It connects to Zerodha Kite (for placing live orders) and Yahoo Finance (for all market data). There is no GUI — everything is operated from the terminal.

## Commands

```bash
# First-time setup
node src/index.js setup db                          # create MySQL tables

# Auth (Kite tokens expire at midnight — re-auth every trading day)
node src/index.js auth login                        # print login URL
node src/index.js auth callback <request_token>     # exchange token
node src/index.js auth status                       # verify token is live

# Portfolio initialisation (one time)
node src/index.js portfolio init --amount 500000            # preview
node src/index.js portfolio init --amount 500000 --execute  # place real orders

# Daily
node src/index.js portfolio details        # holdings + P&L + pool balances
node src/index.js portfolio rankings      # full Nifty 50 ranking table

# Monthly rebalance (1st trading day)
node src/index.js rebalance preview --amount 15000   # dry run
node src/index.js rebalance run     --amount 15000   # places real orders

# Utilities
node src/index.js portfolio transactions [SYMBOL]
node src/index.js portfolio snapshots
node src/index.js portfolio add <SYMBOL> <qty> <avg_price> <YYYY-MM-DD>
node src/index.js portfolio set-date <SYMBOL> <YYYY-MM-DD>

# Smoke-test all modules load without error
node -e "require('dotenv').config(); require('./src/services/rebalance'); console.log('OK')"
```

`DEBUG=1` in `.env` prints full stack traces on errors.

## Architecture

### Data flow

```
NSE CSV  ──→  nse.js            (Nifty 50 constituent list)
Yahoo Finance ──→  ranking.js    (12M / 3M adjclose returns, chart API)
               ──→  rebalance.js  (getCurrentPrices via quote API)
               ──→  corporateActions.js (split events)
Zerodha Kite  ──→  rebalance.js  (placeOrder — buy/sell)
               ──→  auth.js       (generateSession, getProfile)
MySQL         ──→  all services   (holdings, transactions, snapshots, config)
```

### Strategy logic (see strategy.md for full spec)

1. **Ranking** (`services/ranking.js`): score = 70% × 12M adjclose return + 30% × 3M adjclose return. All 50 Nifty stocks are scored; top 15 form the portfolio.
2. **Entry/Exit rules**: entry eligible = rank ≤ 12; hold buffer = rank 13–20; exit = rank > 20 or removed from Nifty 50.
3. **Capital allocation** (`services/allocation.js`): score = absolute return (< 12 months held) or XIRR (≥ 12 months). Scores are offset by the minimum, then normalised to weights. The portfolio pool is distributed proportionally; the worst position gets weight 0.
4. **Pool accounting** (`services/rebalance.js`): a central `portfolio_pool` in the `config` table accumulates SIP + sell proceeds. Each stock also has a per-position `cash_pool` (stored in `holdings.cash_pool`) that carries over fractional allocation that couldn't buy a whole share. Both zero out after a successful rebalance.
5. **Corporate actions** (`services/corporateActions.js`): on every rebalance, splits/bonuses are detected via Yahoo Finance `chart(..., { events: 'splits' })`. Detected splits adjust `holdings.quantity` and `holdings.average_price` before any allocation runs.

### Key modules

| File | Role |
|---|---|
| `src/helpers.js` | Shared utilities: `sleep`, `sqlIn`, `confirm`, `inr`, `inrd`, `pct` |
| `src/config/yahoo.js` | Yahoo Finance singleton + `toYFSymbol()` (adds `.NS` suffix) |
| `src/config/kite.js` | KiteConnect singleton |
| `src/config/database.js` | mysql2 connection pool |
| `src/services/rebalance.js` | Full monthly cycle orchestration; exports `executeBuy`, `getCurrentPrices` |
| `src/services/allocation.js` | `calculateWeights` (batched, 2 DB queries) |
| `src/services/ranking.js` | `calculateRankings` — 50 sequential Yahoo Finance calls, 200ms sleep between each (~10s total) |
| `src/services/corporateActions.js` | `checkAndApplySplits` — called at start of every rebalance |
| `src/db/migrations.js` | Creates tables and seeds `portfolio_pool_balance = 0` |

### Database tables

- `config` — key-value store; holds `access_token`, `portfolio_pool_balance`, `splits_last_checked`
- `holdings` — current positions: `symbol`, `quantity`, `average_price`, `first_buy_date`, `cash_pool`
- `transactions` — every buy/sell: used for XIRR calculation when a position is held ≥ 12 months
- `monthly_snapshots` — per-rebalance ranking and allocation audit trail

### Shared constants and helpers

Always import from `src/helpers.js`, never redefine locally:
- `sleep(ms)` — rate-limit delay between Yahoo Finance calls
- `sqlIn(arr)` — builds MySQL `IN` clause placeholder string
- `toYFSymbol(sym)` — lives in `src/config/yahoo.js`; appends `.NS` for Yahoo Finance

### Preview vs execute pattern

All destructive commands (`portfolio init`, `rebalance run`) default to dry-run. Pass `--execute` or confirm the `yes/no` prompt to place real Kite orders. The `dryRun` flag is threaded through `runRebalance(amount, dryRun)`.

## Environment

Copy `.env.example` to `.env`. Required keys:

```
KITE_API_KEY=
KITE_API_SECRET=
KITE_ALLOWED_IPS=          # comma-separated static IP(s) whitelisted on the Kite developer console
DB_HOST=localhost
DB_PORT=3306
DB_USER=
DB_PASSWORD=
DB_NAME=portfolio_manager
```

MySQL database must be created manually before running `setup db`.

`assertAllowedIp()` (`src/config/kite.js`) checks the machine's current public egress IP against `KITE_ALLOWED_IPS` before any real order is placed (`portfolio init --execute`, `rebalance run`), so a non-whitelisted IP fails fast with a clear error instead of failing per-order against the Kite API.
