# Nifty 50 Capital Efficiency Portfolio Strategy

## Objective

Build and maintain a concentrated portfolio of 15 Nifty 50 stocks.

The strategy separates:

1. **Stock Selection** → Which stocks should be in the portfolio.
2. **Capital Allocation** → Which existing positions deserve additional capital.

The goal is to continuously move capital toward positions that have generated the best returns on invested capital while replacing underperforming holdings with stronger stocks from the Nifty 50 universe.

---

# Portfolio Rules

## Universe

* Current Nifty 50 constituents only.
* Constituents must be fetched from NSE during every monthly rebalance.
* Any stock removed from Nifty 50 automatically becomes ineligible for holding.

---

## Portfolio Size

Target portfolio size:

```text
15 Stocks
```

The portfolio should always contain exactly 15 stocks.

---

# Monthly Rebalance Process

Rebalancing occurs once every month.

Recommended schedule:

```text
1st Trading Day of Every Month
```

No trades should occur outside scheduled rebalancing.

---

# Stock Selection Logic

Stock selection determines:

* New entries
* Existing exits

It does NOT determine capital allocation.

---

## Ranking Metric

Every Nifty 50 stock receives a ranking score.

Recommended formula:

```text
Ranking Score =
70% × 12 Month Return
+
30% × 3 Month Return
```

The ranking score is calculated for all current Nifty 50 stocks.

---

## Ranking Example

| Stock    | 12M Return | 3M Return | Score |
| -------- | ---------- | --------- | ----- |
| BEL      | 40%        | 10%       | 31%   |
| SBIN     | 35%        | 15%       | 29%   |
| Reliance | 20%        | 8%        | 16.4% |
| TCS      | 5%         | -2%       | 2.9%  |

Stocks are sorted descending by score.

---

# Entry Rule

A stock is eligible for entry if:

```text
Rank <= 12
```

Example:

| Rank | Stock       |
| ---- | ----------- |
| 1    | BEL         |
| 2    | SBIN        |
| ...  | ...         |
| 12   | Eicher      |
| 13   | Tata Motors |

Only ranks 1–12 qualify for new entry.

---

# Hold Rule

Existing holdings remain in portfolio when:

```text
Rank 13–20
```

Example:

Current holding:

```text
SBIN
```

New rank:

```text
17
```

Action:

```text
KEEP
```

No trade required.

---

# Exit Rule

A stock must be sold if:

```text
Rank > 20
```

Example:

Current holding:

```text
TCS
```

New rank:

```text
24
```

Action:

```text
SELL
```

---

# Portfolio Replacement Example

Current Portfolio:

```text
A
B
C
D
E
...
O
```

After ranking:

```text
C -> Rank 25
G -> Rank 22
```

Sell:

```text
C
G
```

Highest ranked non-held stocks:

```text
X -> Rank 5
Y -> Rank 8
```

Buy:

```text
X
Y
```

Portfolio size remains:

```text
15 Stocks
```

---

# Capital Allocation Logic

Capital allocation determines:

```text
How monthly investment is distributed
```

Capital allocation is completely independent of stock selection.

---

# Performance Metric

For each held position:

### If Holding Period < 12 Months

Use:

```text
Absolute Return
```

Example:

```text
Invested: ₹10,000
Current Value: ₹11,500

Return = 15%
```

---

### If Holding Period >= 12 Months

Use:

```text
Position XIRR
```

Position XIRR must be calculated using:

* Every buy transaction
* Every sell transaction (if partial)
* Current market value as terminal cashflow

This reflects actual capital efficiency of the position.

---

# Allocation Score

For each held stock:

```text
Allocation Score =
Absolute Return
```

or

```text
Allocation Score =
Position XIRR
```

depending on holding duration.

---

# Weight Normalization

Find lowest score:

Example:

| Stock | Score |
| ----- | ----- |
| A     | 50    |
| B     | 48    |
| C     | 47    |
| D     | 5     |
| E     | -10   |

Minimum:

```text
-10
```

Adjusted scores:

```text
Adjusted Score =
Score - Minimum Score
```

Result:

| Stock | Adjusted |
| ----- | -------- |
| A     | 60       |
| B     | 58       |
| C     | 57       |
| D     | 15       |
| E     | 0        |

---

# Monthly Capital Allocation Example

Monthly investment:

```text
₹100,000
```

Adjusted scores:

| Stock | Adjusted |
| ----- | -------- |
| A     | 60       |
| B     | 58       |
| C     | 57       |
| D     | 15       |
| E     | 0        |

Total:

```text
190
```

Weights:

| Stock | Allocation |
| ----- | ---------- |
| A     | ₹31,579    |
| B     | ₹30,526    |
| C     | ₹30,000    |
| D     | ₹7,895     |
| E     | ₹0         |

Result:

* Best positions receive more capital.
* Weak positions receive less capital.
* Worst position receives no new capital.

---

# Monthly Workflow

## Step 1

Fetch latest Nifty 50 constituents.

---

## Step 2

Calculate ranking scores for all Nifty 50 stocks.

---

## Step 3

Generate ranking.

```text
Rank 1 → Best
Rank 50 → Worst
```

---

## Step 4

Sell holdings:

* Not in Nifty 50
* Rank > 20

---

## Step 5

Buy highest-ranked non-held stocks until portfolio size reaches 15.

---

## Step 6

Calculate position performance score:

```text
Absolute Return (<12 months)
Position XIRR (>=12 months)
```

---

## Step 7

Normalize allocation scores.

---

## Step 8

Distribute monthly investment proportionally.

---

## Step 9

Place orders through Zerodha Kite API.

---

# Required Data Storage

## Holdings

Current portfolio positions.

Fields:

```text
symbol
quantity
average_price
first_buy_date
```

---

## Transactions

Every buy and sell transaction.

Fields:

```text
symbol
trade_date
type
quantity
price
amount
```

Used for XIRR calculation.

---

## Monthly Snapshots

Store monthly ranking results.

Fields:

```text
rebalance_date
symbol
rank
ranking_score
allocation_score
```

Useful for auditing and backtesting.

---

# Expected Behaviour

The strategy naturally:

* Rewards positions that generate the highest return on deployed capital.
* Stops allocating fresh capital to poor positions.
* Continuously rotates into stronger Nifty 50 stocks.
* Avoids frequent trading through entry/exit buffers.
* Remains fully rules-based and automatable through Zerodha APIs.
