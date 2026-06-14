const dayjs = require('dayjs');
const { getPool } = require('../config/database');
const { xirr } = require('./xirr');
const { sqlIn } = require('../helpers');

/**
 * Calculates proportional allocation weights for all held symbols.
 * Batches all DB reads to avoid N+1 queries.
 * < 12 months held → absolute return; >= 12 months → XIRR.
 */
async function calculateWeights(symbols, currentPrices) {
  if (!symbols.length) return [];

  const pool = getPool();

  // Batch-fetch all holdings in one query
  const [holdings] = await pool.execute(
    `SELECT symbol, quantity, average_price, first_buy_date FROM holdings WHERE symbol IN (${sqlIn(symbols)})`,
    symbols
  );
  const holdingMap = Object.fromEntries(holdings.map(h => [h.symbol, h]));

  // Identify symbols that need transaction history (held >= 12 months)
  const needTxns = [];
  for (const h of holdings) {
    if (h.quantity > 0 && dayjs().diff(dayjs(h.first_buy_date), 'month') >= 12) {
      needTxns.push(h.symbol);
    }
  }

  // Batch-fetch transactions for all long-held positions in one query
  const txnMap = {};
  if (needTxns.length) {
    const [txns] = await pool.execute(
      `SELECT symbol, trade_date, type, quantity, price FROM transactions WHERE symbol IN (${sqlIn(needTxns)}) ORDER BY symbol, trade_date ASC`,
      needTxns
    );
    for (const tx of txns) {
      if (!txnMap[tx.symbol]) txnMap[tx.symbol] = [];
      txnMap[tx.symbol].push(tx);
    }
  }

  // Compute score for each symbol
  const scores = symbols.map(symbol => {
    const price = currentPrices[symbol];
    const h = holdingMap[symbol];

    if (!price || !h || h.quantity === 0) return { symbol, rawScore: 0 };

    const monthsHeld = dayjs().diff(dayjs(h.first_buy_date), 'month');

    if (monthsHeld < 12) {
      return { symbol, rawScore: (price - h.average_price) / h.average_price };
    }

    const txns = txnMap[symbol];
    if (!txns || !txns.length) {
      return { symbol, rawScore: (price - h.average_price) / h.average_price };
    }

    const cashflows = txns.map(tx => ({
      amount: tx.type === 'BUY' ? -(tx.quantity * tx.price) : (tx.quantity * tx.price),
      date: new Date(tx.trade_date),
    }));
    cashflows.push({ amount: h.quantity * price, date: new Date() });

    const xirrResult = xirr(cashflows);
    // xirr can return NaN if Newton-Raphson diverges; fall back to absolute return
    const rawScore = isFinite(xirrResult) ? xirrResult : (price - h.average_price) / h.average_price;
    return { symbol, rawScore };
  });

  const minScore = Math.min(...scores.map(s => s.rawScore));
  const adjusted = scores.map(s => ({ ...s, adjustedScore: s.rawScore - minScore }));
  const total    = adjusted.reduce((sum, s) => sum + s.adjustedScore, 0);

  return adjusted.map(s => ({
    ...s,
    weight: total > 0 ? s.adjustedScore / total : 1 / adjusted.length,
  }));
}

// Kept for portfolio status display (single-symbol score lookup)
async function getPositionScore(symbol, currentPrice) {
  const pool = getPool();
  const [holdings] = await pool.execute(
    'SELECT quantity, average_price, first_buy_date FROM holdings WHERE symbol = ?',
    [symbol]
  );
  if (!holdings.length || holdings[0].quantity === 0) return 0;

  const h = holdings[0];
  const monthsHeld = dayjs().diff(dayjs(h.first_buy_date), 'month');

  if (monthsHeld < 12) return (currentPrice - h.average_price) / h.average_price;

  const [txns] = await pool.execute(
    'SELECT trade_date, type, quantity, price FROM transactions WHERE symbol = ? ORDER BY trade_date ASC',
    [symbol]
  );
  if (!txns.length) return (currentPrice - h.average_price) / h.average_price;

  const cashflows = txns.map(tx => ({
    amount: tx.type === 'BUY' ? -(tx.quantity * tx.price) : (tx.quantity * tx.price),
    date: new Date(tx.trade_date),
  }));
  cashflows.push({ amount: h.quantity * currentPrice, date: new Date() });

  const result = xirr(cashflows);
  return isFinite(result) ? result : (currentPrice - h.average_price) / h.average_price;
}

module.exports = { calculateWeights, getPositionScore };
