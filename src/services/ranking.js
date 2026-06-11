const dayjs = require('dayjs');
const { getKite } = require('../config/kite');

// Kite API: max 3 req/sec. Sleep between historical data calls.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let instrumentCache = null;

async function getInstrumentMap(symbols) {
  if (!instrumentCache) {
    process.stdout.write('Loading instrument list from Kite...');
    const all = await getKite().getInstruments('NSE');
    instrumentCache = {};
    for (const inst of all) {
      if (inst.segment === 'NSE' && inst.instrument_type === 'EQ') {
        instrumentCache[inst.tradingsymbol] = inst.instrument_token;
      }
    }
    process.stdout.write(' done.\n');
  }

  const map = {};
  for (const sym of symbols) {
    if (instrumentCache[sym]) map[sym] = instrumentCache[sym];
  }
  return map;
}

async function fetchReturns(token) {
  const kite = getKite();
  const to = dayjs().format('YYYY-MM-DD');
  const from = dayjs().subtract(13, 'month').format('YYYY-MM-DD');

  const candles = await kite.getHistoricalData(token, 'week', from, to);
  if (!candles || candles.length < 4) return { ret12m: 0, ret3m: 0 };

  const latest = candles[candles.length - 1].close;

  const target12 = dayjs().subtract(12, 'month');
  const target3 = dayjs().subtract(3, 'month');

  const nearest = (target) => {
    const ts = target.valueOf();
    return candles.reduce((best, c) => {
      const diff = Math.abs(dayjs(c.date).valueOf() - ts);
      const bestDiff = Math.abs(dayjs(best.date).valueOf() - ts);
      return diff < bestDiff ? c : best;
    });
  };

  const c12 = nearest(target12);
  const c3 = nearest(target3);

  return {
    ret12m: (latest - c12.close) / c12.close,
    ret3m: (latest - c3.close) / c3.close,
  };
}

/**
 * Ranks all Nifty 50 symbols by: 70% × 12M return + 30% × 3M return.
 * Returns array sorted by score descending with rank field.
 */
async function calculateRankings(symbols) {
  console.log(`\nFetching instrument tokens for ${symbols.length} symbols...`);
  const tokenMap = await getInstrumentMap(symbols);

  const results = [];
  const missing = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const token = tokenMap[symbol];

    if (!token) {
      missing.push(symbol);
      continue;
    }

    process.stdout.write(`  [${i + 1}/${symbols.length}] ${symbol.padEnd(15)}`);

    try {
      const { ret12m, ret3m } = await fetchReturns(token);
      const score = 0.7 * ret12m + 0.3 * ret3m;
      results.push({ symbol, ret12m, ret3m, score });
      process.stdout.write(`12M: ${pct(ret12m)}  3M: ${pct(ret3m)}  Score: ${pct(score)}\n`);
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message}\n`);
      results.push({ symbol, ret12m: 0, ret3m: 0, score: 0 });
    }

    // Rate limit: ~2.5 req/sec
    await sleep(400);
  }

  if (missing.length) {
    console.log(`\nWarning: No token found for: ${missing.join(', ')}`);
  }

  results.sort((a, b) => b.score - a.score);
  return results.map((item, idx) => ({ ...item, rank: idx + 1 }));
}

function pct(n) {
  return `${(n * 100).toFixed(2)}%`.padStart(9);
}

module.exports = { calculateRankings };
