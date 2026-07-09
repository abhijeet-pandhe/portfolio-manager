const dayjs = require('dayjs');
const { yf: yahooFinance, toYFSymbol } = require('../config/yahoo');
const { sleep, inrd, withRetry, cleanYahooError } = require('../helpers');

async function fetchReturns(symbol) {
  const from = dayjs().subtract(13, 'month').toDate();
  const to = new Date();

  const result = await yahooFinance.chart(toYFSymbol(symbol), {
    period1: from,
    period2: to,
    interval: '1wk',
  });

  const valid = (result.quotes || []).filter(c => c.adjclose != null);
  if (valid.length < 4) return { ret12m: 0, ret3m: 0 };

  const latest = valid[valid.length - 1].adjclose;

  const nearest = (targetDayjs) => {
    const ts = targetDayjs.valueOf();
    return valid.reduce((best, c) =>
      Math.abs(dayjs(c.date).valueOf() - ts) < Math.abs(dayjs(best.date).valueOf() - ts) ? c : best
    );
  };

  const c12 = nearest(dayjs().subtract(12, 'month'));
  const c3  = nearest(dayjs().subtract(3, 'month'));

  return {
    ret12m:      (latest - c12.adjclose) / c12.adjclose,
    ret3m:       (latest - c3.adjclose)  / c3.adjclose,
    priceLTP:    latest,
    price12m:    c12.adjclose,
    price3m:     c3.adjclose,
  };
}

/**
 * Ranks all Nifty 50 symbols by: 70% × 12M return + 30% × 3M return.
 * Returns array sorted by score descending, with rank field.
 */
async function calculateRankings(symbols) {
  const results = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];

    try {
      const { ret12m, ret3m, priceLTP, price12m, price3m } = await withRetry(() => fetchReturns(symbol));
      const score = 0.7 * ret12m + 0.3 * ret3m;
      results.push({ symbol, ret12m, ret3m, score, priceLTP, price12m, price3m });
      console.log(formatLine(symbol, priceLTP, price12m, ret12m, price3m, ret3m, score));
    } catch (err) {
      console.log(`  ${symbol.padEnd(15)} ERROR: ${cleanYahooError(err)}`);
      results.push({ symbol, ret12m: 0, ret3m: 0, score: 0, failed: true });
    }

    // Small delay to avoid hammering Yahoo Finance
    await sleep(200);
  }

  results.sort((a, b) => b.score - a.score);
  return results.map((item, idx) => ({ ...item, rank: idx + 1 }));
}

function formatLine(symbol, ltp, p12m, r12m, p3m, r3m, score) {
  const price = (n) => inrd(n).padStart(12);
  const ret   = (n) => `(${((n * 100).toFixed(2) + '%').padStart(9)})`;
  const sc    = (n) => `${((n * 100).toFixed(2) + '%').padStart(9)}`;
  return (
    `${symbol.padEnd(15)} LTP: ${price(ltp)}` +
    `  12M: ${price(p12m)} ${ret(r12m)}` +
    `  3M: ${price(p3m)} ${ret(r3m)}` +
    `  Score: ${sc(score)}`
  );
}

module.exports = { calculateRankings };
