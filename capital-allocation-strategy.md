# Allocation Strategy

## Overview

The allocation strategy determines how new capital is distributed among stocks already present in the portfolio.

The strategy uses:

* `portfolio_pool` for central cash management.
* `stock_pool` for each stock to accumulate uninvested cash.
* Absolute Return for positions held less than 12 months.
* Position XIRR for positions held 12 months or longer.

Stock selection and portfolio entry/exit are handled separately.

---

# Cash Structures

## Portfolio Pool

Central cash account.

Contains:

* Monthly SIP contributions
* Proceeds from stock sales

Example:

```text
portfolio_pool = ₹50,000
```

---

## Stock Pool

Every stock has an individual cash bucket.

Example:

```text
RELIANCE = ₹400
TRENT = ₹850
SBIN = ₹1200
```

Money remains in the stock pool until enough accumulates to purchase whole shares.

---

# Monthly Allocation Cycle

## Step 1 - Sell Exited Stocks

For every stock removed from the portfolio:

1. Sell all shares.
2. Add sale proceeds to `portfolio_pool`.
3. Add remaining `stock_pool` balance to `portfolio_pool`.
4. Delete the stock's `stock_pool`.

Example:

```text
TCS Shares Value = ₹42,000
TCS Stock Pool = ₹700
```

Result:

```text
portfolio_pool += ₹42,700
```

---

## Step 2 - Add Monthly SIP

Monthly investment amount is added to `portfolio_pool`.

Example:

```text
Monthly SIP = ₹15,000
```

```text
portfolio_pool += ₹15,000
```

---

## Step 3 - Process New Entries

For every stock entering the portfolio:

### Mandatory First Share Rule

The stock must receive at least one share before it becomes eligible for allocation-based investing.

Example:

```text
TRENT enters portfolio
Current Price = ₹7,200
```

### Entry Conditions

If:

```text
portfolio_pool >= stock_price
```

Then:

1. Buy 1 share.
2. Deduct purchase amount from `portfolio_pool`.
3. Create stock holding.
4. Create empty `stock_pool`.

Example:

```text
portfolio_pool = ₹50,000

Buy 1 TRENT share = ₹7,200

portfolio_pool = ₹42,800
TRENT stock_pool = ₹0
```

### Insufficient Funds

If:

```text
portfolio_pool < stock_price
```

Then:

1. Do not add the stock.
2. Skip entry for this rebalance cycle.
3. Re-evaluate next month.

Example:

```text
portfolio_pool = ₹4,000
TRENT price = ₹7,200

TRENT not added
```

This prevents partially initialized positions.

---

## Step 4 - Calculate Position Performance Score

Every held stock receives a performance score.

### Holding Period < 12 Months

Use Absolute Return.

Formula:

```text
(Current Value - Total Invested)
/ Total Invested
```

Example:

```text
Invested = ₹10,000
Current Value = ₹11,500

Score = 15%
```

---

### Holding Period >= 12 Months

Use Position XIRR.

Position XIRR is calculated using:

* All buy transactions
* All sell transactions
* Current market value as terminal cashflow

Example:

```text
Score = 22%
```

---

## Step 5 - Convert Scores into Allocation Weights

Find lowest score.

Example:

| Stock    | Score |
| -------- | ----- |
| TRENT    | 25    |
| BEL      | 18    |
| SBIN     | 10    |
| RELIANCE | -5    |

Minimum:

```text
-5
```

Offset scores:

```text
adjusted_score =
score - minimum_score
```

Result:

| Stock    | Adjusted Score |
| -------- | -------------- |
| TRENT    | 30             |
| BEL      | 23             |
| SBIN     | 15             |
| RELIANCE | 0              |

---

## Step 6 - Calculate Allocation Percentages

Calculate total score.

```text
30 + 23 + 15 + 0 = 68
```

Weight:

```text
adjusted_score / total_adjusted_score
```

Result:

| Stock    | Weight |
| -------- | ------ |
| TRENT    | 44.1%  |
| BEL      | 33.8%  |
| SBIN     | 22.1%  |
| RELIANCE | 0%     |

---

## Step 7 - Distribute Portfolio Pool

Example:

```text
portfolio_pool = ₹50,000
```

Allocation:

| Stock    | Amount  |
| -------- | ------- |
| TRENT    | ₹22,050 |
| BEL      | ₹16,900 |
| SBIN     | ₹11,050 |
| RELIANCE | ₹0      |

Move money into stock pools.

```text
TRENT stock_pool += ₹22,050
BEL stock_pool += ₹16,900
SBIN stock_pool += ₹11,050
```

Portfolio pool becomes:

```text
₹0
```

---

## Step 8 - Execute Purchases

For each stock:

```text
shares_to_buy =
floor(stock_pool / current_price)
```

Purchase shares.

Deduct purchase amount.

Store remaining balance back in stock pool.

---

### Example

TRENT:

```text
stock_pool = ₹22,050
price = ₹7,200
```

Buy:

```text
3 shares
```

Cost:

```text
₹21,600
```

Remaining:

```text
₹450
```

Store:

```text
TRENT stock_pool = ₹450
```

---

## Step 9 - End State

Portfolio consists of:

### Holdings

```text
TRENT = 8 shares
BEL = 12 shares
SBIN = 20 shares
```

### Stock Pools

```text
TRENT = ₹450
BEL = ₹400
SBIN = ₹150
```

### Portfolio Pool

```text
₹0
```

---

# Key Principles

1. New stocks must receive at least one share before participating in allocation.
2. Stocks cannot enter if portfolio cash is insufficient to buy the first share.
3. Holdings less than 12 months use Absolute Return.
4. Holdings 12 months or older use Position XIRR.
5. Allocation is proportional to performance score.
6. Stock pools accumulate leftover cash.
7. Portfolio pool manages all incoming and outgoing cash.
8. No fractional shares are used.
9. Better-performing positions automatically receive more future capital.
