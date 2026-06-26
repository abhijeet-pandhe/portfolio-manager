# Command Reference

## One-time Setup

```bash
node src/index.js setup db
```
Creates all required MySQL tables.

---

```bash
node src/index.js auth login
```
Prints the Zerodha login URL. Open it in a browser, complete login, then copy the `request_token` from the redirect URL.

---

```bash
node src/index.js auth callback <request_token>
```
Exchanges the request_token for an access token and saves it to the database.

---

```bash
node src/index.js portfolio init --amount <total>
```
Ranks all Nifty 50 stocks, picks the top 15, and shows how the capital would be split equally. **Preview only — no orders placed.**

---

```bash
node src/index.js portfolio init --amount <total> --execute
```
Same as above but places the actual buy orders on Zerodha.

---

## Every Trading Day

```bash
node src/index.js auth status
```
Checks if the stored token is still valid. Kite tokens expire at midnight, so re-auth is needed each day.

---

```bash
node src/index.js auth callback <request_token>
```
Re-authenticate. Run `auth login` first to get a fresh URL, then this to save the new token.

---

```bash
node src/index.js portfolio status
```
Shows all held positions — quantity, average cost, current price, P&L, and the allocation score each position would get in the next monthly investment.

---

## Every Month (1st Trading Day)

```bash
node src/index.js rebalance preview --amount <monthly_investment>
```
Shows what the rebalance would do: which stocks exit (rank > 20), which stocks enter, and how the monthly investment is split across all 15 positions. **No orders placed.**

---

```bash
node src/index.js rebalance run --amount <monthly_investment>
```
Executes the rebalance — sells exits, buys new entries, and distributes the monthly investment. Asks for confirmation before placing any order.

---

## Utilities

```bash
node src/index.js portfolio details
```
Concise portfolio dashboard: summary (value, invested, P&L, return, XIRR, cash pools), holdings table sorted by market value, and key insights (best/worst performer, largest holding, win rate). XIRR is shown per stock only for positions held ≥ 12 months.

---

```bash
node src/index.js portfolio rankings
```
Shows the full Nifty 50 ranking table with each stock's 12M return, 3M return, and composite score. Highlights which held stocks are at risk of exit.

---

```bash
node src/index.js portfolio transactions
node src/index.js portfolio transactions <SYMBOL>
```
Shows transaction history. Pass a symbol to filter to one stock.

---

```bash
node src/index.js portfolio snapshots
```
Shows the ranking and allocation data saved from each past rebalance.

---

```bash
node src/index.js portfolio set-date <SYMBOL> <YYYY-MM-DD>
```
Updates the first buy date for a holding. Matters for the performance metric — positions held less than 12 months use absolute return; 12 months or more use XIRR.
