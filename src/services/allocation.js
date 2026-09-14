const dayjs = require('dayjs');
const { pool } = require('../config/database');
const { xirr } = require('./xirr');
const { sqlIn } = require('../helpers');

/**
 * Calculates proportional allocation weights for all held symbols.
 * Batches all DB reads to avoid N+1 queries.
 * < 12 months held → absolute return; >= 12 months → XIRR.
 */
async function calculateWeights(symbols, currentPrices) {
  if (!symbols.length) return [];

  // Batch-fetch all holdings in one query
  const [holdings] = await pool.execute(
    `SELECT symbol, quantity, average_price, first_buy_date FROM holdings WHERE symbol IN (${sqlIn(symbols)})`,
    symbols
  );
  const holdingMap = Object.fromEntries(holdings.map(h => [h.symbol, h]));

  // Identify symbols that need transaction history (held >= 12 months)
  const needTxns = holdings
    .filter(h => h.quantity > 0 && dayjs().diff(dayjs(h.first_buy_date), 'month') >= 12)
    .map(h => h.symbol);

  // Batch-fetch each symbol's BUYs since its last SELL (or all BUYs if never sold)
  const buyMap = {};
  if (needTxns.length) {
    const [buys] = await pool.execute(
      `SELECT symbol, trade_date, quantity, price FROM transactions t
       WHERE symbol IN (${sqlIn(needTxns)}) AND type = 'BUY'
         AND trade_date > COALESCE(
           (SELECT MAX(trade_date) FROM transactions WHERE symbol = t.symbol AND type = 'SELL'),
           '1900-01-01'
         )
       ORDER BY symbol, trade_date ASC`,
      needTxns
    );
    for (const tx of buys) {
      if (!buyMap[tx.symbol]) buyMap[tx.symbol] = [];
      buyMap[tx.symbol].push(tx);
    }
  }

  // Compute score for each symbol
  const scores = symbols.map(symbol => {
    const price = currentPrices[symbol];
    const h = holdingMap[symbol];

    if (!price || !h || h.quantity === 0) return { symbol, rawScore: 0 };

    const monthsHeld = dayjs().diff(dayjs(h.first_buy_date), 'month');
    const fallback = (price - h.average_price) / h.average_price;

    if (monthsHeld < 12) return { symbol, rawScore: fallback };

    const buys = buyMap[symbol];
    if (!buys || !buys.length) return { symbol, rawScore: fallback };

    const cashflows = buys.map(tx => ({
      amount: -(tx.quantity * tx.price),
      date: new Date(tx.trade_date),
    }));
    cashflows.push({ amount: h.quantity * price, date: new Date() });

    const xirrResult = xirr(cashflows);
    // xirr can return NaN if Newton-Raphson diverges; fall back to absolute return
    return { symbol, rawScore: isFinite(xirrResult) ? xirrResult : fallback };
  });

  const minScore = Math.min(...scores.map(s => s.rawScore));
  const adjusted = scores.map(s => ({ ...s, adjustedScore: s.rawScore - minScore }));
  const total    = adjusted.reduce((sum, s) => sum + s.adjustedScore, 0);

  return adjusted.map(s => ({
    ...s,
    weight: total > 0 ? s.adjustedScore / total : 1 / adjusted.length,
  }));
}

module.exports = { calculateWeights };
