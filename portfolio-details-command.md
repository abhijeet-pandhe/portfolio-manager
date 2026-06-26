# Portfolio Command Specification

## Command

```text
portfolio details
```

---

# Objective

Provide a concise summary of the current portfolio performance and the most important insights required for decision making.

---

# Output Structure

## 1. Portfolio Summary

```text
Portfolio Value      : ₹12,45,320
Invested Amount      : ₹10,85,000
Unrealized P&L       : ₹1,60,320 (+14.78%)

Portfolio Return     : +14.78%
Portfolio XIRR       : +18.21%

Cash Available       : ₹24,510
Stock Pool Amount    : ₹8,200
Stocks Held          : 15
```

### Definitions

**Portfolio Return**

```text
(Current Portfolio Value / Total Invested Amount - 1) * 100
```

**Portfolio XIRR**

Use:

* BUY transactions as negative cashflows.
* SELL transactions as positive cashflows.
* Current market value of open positions as the final positive cashflow.

---

## 2. Holdings

Sort holdings by **Market Value (descending)**.

### Columns

| Symbol | Qty | Avg Price | CMP | Value | Allocation % | Gain/Loss | Return | XIRR |
| ------ | --- | --------- | --- | ----- | ------------ | --------- | ------ | ---- |

Example:

```text
RELIANCE   50   ₹2,450   ₹3,020   ₹1,51,000   12.1%   +₹28,500   +19.3%   16.8%
BEL       100     ₹250     ₹395     ₹39,500    3.2%   +₹14,500   +58.0%   -
TCS        20   ₹3,950   ₹4,100     ₹82,000    6.6%    +₹3,000    +3.8%   4.1%
```

### Column Definitions

#### Return

Available for all stocks.

```text
(Current Value / Total Invested Amount - 1) * 100
```

#### XIRR

If holding period >= 12 months:

```text
Calculate XIRR using all cashflows for the stock.
```

Otherwise:

```text
-
```

#### Allocation %

```text
(Stock Market Value / Portfolio Value) * 100
```

---

## 3. Key Insights

Display only the most valuable insights.

```text
Best Performer      : BEL (+58.2%)
Worst Performer     : HDFCBANK (-8.4%)

Largest Holding     : RELIANCE (12.1%)
Portfolio Win Rate  : 11 / 15 (73.3%)
```

### Definitions

**Best Performer**

Holding with the highest Return.

**Worst Performer**

Holding with the lowest Return.

**Largest Holding**

Holding with the highest Allocation %.

**Portfolio Win Rate**

```text
(Number of profitable holdings / Total holdings)
```

---

# Display Order

```text
1. Portfolio Summary
2. Holdings Table
3. Key Insights
```

---

# Design Principles

* Keep output compact.
* Show only currently held positions.
* Sort holdings by Market Value descending.
* Always show Return.
* Show XIRR only for holdings older than 12 months.
* Avoid excessive statistics.
* Prioritize actionable insights.
* Keep the command readable within a single terminal screen whenever possible.
