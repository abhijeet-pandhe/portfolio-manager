const dayjs = require('dayjs');
const { getPool } = require('../config/database');
const { xirr } = require('./xirr');

/**
 * Returns allocation score for a held position.
 * < 12 months held → absolute return (fraction, e.g. 0.15 = 15%)
 * >= 12 months held → XIRR (annualised, e.g. 0.20 = 20%)
 * New position (no history yet) → 0
 */
async function getPositionScore(symbol, currentPrice) {
  const pool = getPool();

  const [holdings] = await pool.execute(
    'SELECT quantity, average_price, first_buy_date FROM holdings WHERE symbol = ?',
    [symbol]
  );

  // New position not yet in DB — score is 0
  if (!holdings.length || holdings[0].quantity === 0) return 0;

  const h = holdings[0];
  const monthsHeld = dayjs().diff(dayjs(h.first_buy_date), 'month');

  if (monthsHeld < 12) {
    return (currentPrice - h.average_price) / h.average_price;
  }

  // XIRR: use full transaction history + terminal cashflow
  const [txns] = await pool.execute(
    'SELECT trade_date, type, quantity, price FROM transactions WHERE symbol = ? ORDER BY trade_date ASC',
    [symbol]
  );

  if (!txns.length) {
    // No transaction history stored — fall back to absolute return
    return (currentPrice - h.average_price) / h.average_price;
  }

  const cashflows = txns.map(tx => ({
    amount: tx.type === 'BUY' ? -(tx.quantity * tx.price) : (tx.quantity * tx.price),
    date: new Date(tx.trade_date),
  }));

  // Terminal cashflow: current market value of remaining holding
  cashflows.push({
    amount: h.quantity * currentPrice,
    date: new Date(),
  });

  return xirr(cashflows);
}

/**
 * Calculates proportional weights for monthly investment across all held symbols.
 * Returns array of { symbol, rawScore, adjustedScore, weight }
 */
async function calculateAllocation(symbols, currentPrices) {
  const scores = [];

  for (const symbol of symbols) {
    const price = currentPrices[symbol];
    if (!price) {
      scores.push({ symbol, rawScore: 0 });
      continue;
    }
    const rawScore = await getPositionScore(symbol, price);
    scores.push({ symbol, rawScore });
  }

  const minScore = Math.min(...scores.map(s => s.rawScore));

  const adjusted = scores.map(s => ({
    ...s,
    adjustedScore: s.rawScore - minScore,
  }));

  const total = adjusted.reduce((sum, s) => sum + s.adjustedScore, 0);

  return adjusted.map(s => ({
    ...s,
    weight: total > 0 ? s.adjustedScore / total : 1 / adjusted.length,
  }));
}

module.exports = { calculateAllocation, getPositionScore };
