const dayjs = require('dayjs');
const chalk = require('chalk');
const Table = require('cli-table3');

const { yf: yahooFinance, toYFSymbol } = require('../config/yahoo');

const { getPool } = require('../config/database');
const { getKite, assertValidSession, assertSufficientFunds } = require('../config/kite');
const { getNifty50Symbols } = require('./nse');
const { calculateRankings } = require('./ranking');
const { calculateWeights } = require('./allocation');
const { checkAndApplySplits } = require('./corporateActions');
const { sleep, sqlIn, confirm, inr, inrd, pct, withRetry, cleanYahooError } = require('../helpers');

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getHeldSymbols() {
  const [rows] = await getPool().execute('SELECT symbol FROM holdings WHERE quantity > 0');
  return rows.map(r => r.symbol);
}

async function getCurrentPrices(symbols) {
  if (!symbols.length) return {};
  let results;
  try {
    results = await withRetry(() => yahooFinance.quote(symbols.map(toYFSymbol)));
  } catch (err) {
    throw new Error(`Failed to fetch current prices: ${cleanYahooError(err)}`);
  }
  const arr = Array.isArray(results) ? results : [results];
  const prices = {};
  for (const r of arr) prices[r.symbol.replace('.NS', '')] = r.regularMarketPrice;
  return prices;
}

// ─── Order helpers ────────────────────────────────────────────────────────────

/**
 * Fetches the actual weighted-average fill price from Zerodha after an order
 * executes. Market orders typically fill within 1-2 seconds during market hours.
 * Returns fallbackPrice if trades are not yet available (e.g., AMO placed after
 * hours, or a brief delay before the exchange acknowledges the fill).
 */
async function getActualFillPrice(orderId, fallbackPrice) {
  await sleep(1500);
  try {
    const trades = await getKite().getOrderTrades(orderId);
    if (!trades || !trades.length) {
      process.stdout.write(chalk.yellow(`\n          ⚠ fill not yet confirmed — using indicative price ${inrd(fallbackPrice)}\n`));
      return fallbackPrice;
    }
    const totalQty   = trades.reduce((s, t) => s + t.quantity, 0);
    const totalValue = trades.reduce((s, t) => s + t.average_price * t.quantity, 0);
    const fillPrice  = totalQty > 0 ? totalValue / totalQty : fallbackPrice;
    process.stdout.write(`  actual fill: ${inrd(fillPrice)}\n`);
    return fillPrice;
  } catch (err) {
    process.stdout.write(chalk.yellow(`\n          ⚠ could not fetch fill price (${err.message}) — using indicative price\n`));
    return fallbackPrice;
  }
}

async function executeSell(symbol, qty, price, pool) {
  const today = dayjs().format('YYYY-MM-DD');
  process.stdout.write(`  SELL  ${qty} × ${symbol.padEnd(12)} @ ${inrd(price)}...`);

  let orderId = null;
  try {
    const res = await getKite().placeOrder('regular', {
      tradingsymbol: symbol, exchange: 'NSE',
      transaction_type: 'SELL', order_type: 'MARKET',
      quantity: qty, product: 'CNC', market_protection: 0.5,
      tag: 'MY_STRATEGY'
    });
    orderId = res.order_id;
    process.stdout.write(chalk.green(` ✓ order ${orderId}\n`));
  } catch (err) {
    process.stdout.write(chalk.red(` ✗ FAILED: ${err.message}\n`));
    return false;
  }

  const fillPrice = await getActualFillPrice(orderId, price);
  const amount    = qty * fillPrice;

  await pool.execute(
    'INSERT INTO transactions (symbol,trade_date,type,quantity,price,amount,order_id) VALUES (?,?,?,?,?,?,?)',
    [symbol, today, 'SELL', qty, fillPrice, amount, orderId]
  );
  await pool.execute('DELETE FROM holdings WHERE symbol=?', [symbol]);
  return true;
}

async function executeBuy(symbol, qty, price, pool) {
  const today = dayjs().format('YYYY-MM-DD');
  process.stdout.write(`  BUY   ${qty} × ${symbol.padEnd(12)} @ ${inrd(price)}...`);

  let orderId = null;
  try {
    const res = await getKite().placeOrder('regular', {
      tradingsymbol: symbol, exchange: 'NSE',
      transaction_type: 'BUY', order_type: 'MARKET',
      quantity: qty, product: 'CNC', market_protection: 0.5,
      tag: 'MY_STRATEGY'
    });
    orderId = res.order_id;
    process.stdout.write(chalk.green(` ✓ order ${orderId}\n`));
  } catch (err) {
    process.stdout.write(chalk.red(` ✗ FAILED: ${err.message}\n`));
    return false;
  }

  const fillPrice = await getActualFillPrice(orderId, price);
  const amount    = qty * fillPrice;

  await pool.execute(
    'INSERT INTO transactions (symbol,trade_date,type,quantity,price,amount,order_id) VALUES (?,?,?,?,?,?,?)',
    [symbol, today, 'BUY', qty, fillPrice, amount, orderId]
  );

  const [[existing]] = await pool.execute(
    'SELECT quantity, average_price FROM holdings WHERE symbol=?', [symbol]
  );
  if (existing) {
    const newQty = existing.quantity + qty;
    const newAvg = (existing.quantity * existing.average_price + amount) / newQty;
    await pool.execute(
      'UPDATE holdings SET quantity=?, average_price=?, updated_at=NOW() WHERE symbol=?',
      [newQty, newAvg, symbol]
    );
  } else {
    await pool.execute(
      'INSERT INTO holdings (symbol,quantity,average_price,first_buy_date,cash_pool) VALUES (?,?,?,?,0)',
      [symbol, qty, fillPrice, today]
    );
  }
  return true;
}

// ─── Display ──────────────────────────────────────────────────────────────────

function printPoolSummary(sellProceeds, recoveredPools, sip, working) {
  console.log(chalk.bold('\n─── PORTFOLIO POOL ──────────────────────────────'));
  console.log(`  Sell proceeds          : ${inr(sellProceeds).padStart(12)}`);
  console.log(`  Recovered stock pools  : ${inr(recoveredPools).padStart(12)}`);
  console.log(`  Monthly SIP            : ${inr(sip).padStart(12)}`);
  console.log(chalk.cyan(`  Working pool           : ${inr(working).padStart(12)}`));
}

function printEntries(toBuy, skipped, firstShareCosts, prices) {
  console.log(chalk.bold('\n─── NEW ENTRIES (mandatory first share) ─────────'));
  if (toBuy.length === 0 && skipped.length === 0) {
    console.log('  No new entries.');
    return;
  }
  for (const sym of toBuy) {
    const cost = firstShareCosts[sym] || 0;
    console.log(chalk.green(`  ENTRY  ${sym.padEnd(15)} 1 share @ ${inrd(cost)}`));
  }
  for (const s of skipped) {
    console.log(chalk.red(`  SKIP   ${s.symbol.padEnd(15)} price ${inr(s.price)} > pool ${inr(s.poolAt)}`));
  }
}

function printAllocationTable(buyPlan, poolToDistribute, firstShareCosts = {}) {
  console.log(chalk.bold('\n─── ALLOCATION FROM POOL ────────────────────────'));
  console.log(`  Pool to distribute: ${chalk.cyan(inr(poolToDistribute))}\n`);

  const table = new Table({
    head: ['Symbol', 'Score', 'Weight', '+Pool', 'Cur Pool', 'Total Pool', 'LTP', 'Buy', 'Spent', 'Remaining'],
    style: { head: ['cyan'] },
    colAligns: ['left','right','right','right','right','right','right','right','right','right'],
  });

  for (const b of buyPlan) {
    const label = b.symbol + (b.isNew ? chalk.yellow(' NEW') : '');
    table.push([
      label,
      pct(b.rawScore),
      (b.weight * 100).toFixed(1) + '%',
      inr(b.poolAddition),
      inr(b.existingPool),
      inr(b.totalPool),
      inr(b.price),
      b.qty > 0 ? b.qty : chalk.gray('0'),
      inr(b.spent),
      inr(b.remaining),
    ]);
  }
  console.log(table.toString());

  const firstShareTotal = Object.values(firstShareCosts).reduce((s, c) => s + c, 0);
  const allocationSpent = buyPlan.reduce((s, b) => s + b.spent, 0);
  const totalSpent      = allocationSpent + firstShareTotal;
  const totalRemaining  = buyPlan.reduce((s, b) => s + b.remaining, 0);
  console.log(`  Allocation spent      : ${chalk.gray(inr(allocationSpent))}`);
  console.log(`  Carried to next month : ${chalk.gray(inr(totalRemaining))}`);
  console.log(`  Total spent           : ${chalk.cyan(inr(totalSpent))}`);
}

async function saveSnapshot(rankings, toSell, toBuy, weights, pool) {
  const today = dayjs().format('YYYY-MM-DD');
  const scoreMap = Object.fromEntries(weights.map(w => [w.symbol, w.rawScore]));
  for (const r of rankings) {
    let action = null;
    if (toSell.includes(r.symbol))                         action = 'SELL';
    else if (toBuy.includes(r.symbol))                     action = 'BUY';
    else if (weights.some(w => w.symbol === r.symbol))     action = 'HOLD';
    await pool.execute(
      'INSERT INTO monthly_snapshots (rebalance_date,symbol,rank_position,ranking_score,allocation_score,action) VALUES (?,?,?,?,?,?)',
      [today, r.symbol, r.rank, r.score, scoreMap[r.symbol] ?? null, action]
    );
  }
}

// ─── Core allocation builder ──────────────────────────────────────────────────

async function buildBuyPlan(finalHoldings, existingHoldings, toBuy, prices, poolToDistribute, pool) {
  const weights = await calculateWeights(finalHoldings, prices);

  // Batch-fetch cash_pool for all existing holdings in one query
  const cashPoolMap = {};
  if (existingHoldings.length) {
    const [rows] = await pool.execute(
      `SELECT symbol, cash_pool FROM holdings WHERE symbol IN (${sqlIn(existingHoldings)})`,
      existingHoldings
    );
    for (const r of rows) cashPoolMap[r.symbol] = parseFloat(r.cash_pool || 0);
  }

  return weights.map(w => {
    const poolAddition = w.weight * poolToDistribute;
    const existingPool = cashPoolMap[w.symbol] ?? 0;
    const totalPool    = existingPool + poolAddition;
    const price        = prices[w.symbol] || 0;
    const qty          = price > 0 ? Math.floor(totalPool / price) : 0;
    const spent        = qty * price;

    return {
      ...w,
      poolAddition,
      existingPool,
      totalPool,
      price,
      qty,
      spent,
      remaining: totalPool - spent,
      isNew: toBuy.includes(w.symbol),
    };
  });
}

// ─── Main rebalance ───────────────────────────────────────────────────────────

async function runRebalance(sip, dryRun = true) {
  const pool = getPool();

  console.log(chalk.bold(`\n${'═'.repeat(55)}`));
  console.log(chalk.bold(`  MONTHLY REBALANCE${dryRun ? chalk.yellow(' [DRY RUN]') : ''}`));
  console.log(chalk.bold(`${'═'.repeat(55)}\n`));
  console.log(`Monthly SIP : ${chalk.cyan(inr(sip))}`);
  console.log(`Date        : ${dayjs().format('DD MMM YYYY')}\n`);

  // ── Step 1: Nifty 50 ──
  console.log(chalk.bold('Step 1: Fetching Nifty 50...'));
  const nifty50 = await getNifty50Symbols();
  console.log(`  → ${nifty50.length} constituents\n`);

  // ── Step 2-3: Rankings ──
  console.log(chalk.bold('Step 2-3: Calculating rankings...'));
  const rankings = await calculateRankings(nifty50);
  console.log('');

  // ── Step 3.5: Corporate actions ──
  const heldBefore = await getHeldSymbols();
  await checkAndApplySplits(heldBefore);

  // ── Step 4: Identify exits ──
  console.log(chalk.bold('Step 4: Identifying exits...'));
  const toSell = heldBefore.filter(sym => {
    if (!nifty50.includes(sym)) { console.log(`  ${chalk.red('EXIT')} ${sym} — removed from Nifty 50`); return true; }
    const r = rankings.find(x => x.symbol === sym);
    if (r && r.failed) { console.log(`  ${chalk.yellow('SKIP')} ${sym} — ranking data unavailable this run, holding until next rebalance`); return false; }
    if (r && r.rank > 20) { console.log(`  ${chalk.red('EXIT')} ${sym} — rank ${r.rank} > 20`); return true; }
    return false;
  });
  if (!toSell.length) console.log('  None.');
  console.log('');

  // ── Prices ──
  console.log(chalk.bold('Fetching prices...'));
  const allSymbols = [...new Set([...heldBefore, ...rankings.slice(0, 15).map(r => r.symbol)])];
  const prices = await getCurrentPrices(allSymbols);
  console.log(`  → ${Object.keys(prices).length} symbols\n`);

  // ── Step 1 (strategy): collect sell proceeds + stock pools ──
  const sellData = [];
  for (const sym of toSell) {
    const [[h]] = await pool.execute('SELECT quantity, cash_pool FROM holdings WHERE symbol=?', [sym]);
    if (h) sellData.push({ symbol: sym, qty: h.quantity, cashPool: parseFloat(h.cash_pool || 0) });
  }
  const totalSellProceeds  = sellData.reduce((s, d) => s + (prices[d.symbol] || 0) * d.qty, 0);
  const totalRecoveredPools = sellData.reduce((s, d) => s + d.cashPool, 0);

  // ── Step 2 (strategy): add SIP ──
  let workingPool  = totalSellProceeds + totalRecoveredPools + sip;

  printPoolSummary(totalSellProceeds, totalRecoveredPools, sip, workingPool);

  // ── Step 3 (strategy): new entries — mandatory first share ──
  const heldAfterSell = heldBefore.filter(s => !toSell.includes(s));
  const needed        = 15 - heldAfterSell.length;
  const candidates    = rankings
    .filter(r => r.rank <= 12 && !heldAfterSell.includes(r.symbol))
    .slice(0, needed);

  const toBuy    = [];
  const skipped  = [];
  const firstShareCosts = {};

  for (const c of candidates) {
    const price = prices[c.symbol] || 0;
    if (!price || workingPool < price) {
      skipped.push({ symbol: c.symbol, price, poolAt: workingPool });
      continue;
    }
    toBuy.push(c.symbol);
    firstShareCosts[c.symbol] = price;
    workingPool -= price;
  }

  printEntries(toBuy, skipped, firstShareCosts, prices);

  if (toBuy.length) {
    console.log(chalk.cyan(`\n  Pool after first shares: ${inr(workingPool)}`));
  }

  // ── Steps 4-8 (strategy): weights → distribute pool → buy from stock pools ──
  const finalHoldings = [...heldAfterSell, ...toBuy];
  const buyPlan = await buildBuyPlan(finalHoldings, heldAfterSell, toBuy, prices, workingPool, pool);

  printAllocationTable(buyPlan, workingPool, firstShareCosts);

  if (dryRun) {
    console.log(chalk.yellow('\nDry run complete. No orders placed.'));
    console.log(`Execute: node src/index.js rebalance run --amount ${sip}`);
    return;
  }

  // ── Verify the Kite session is actually live before touching real orders ──
  await assertValidSession();

  // ── Confirm ──
  console.log(chalk.bold.red('\n⚠  This will place REAL orders on your Zerodha account.'));
  if (await confirm('Type "yes" to proceed: ') !== 'yes') { console.log('Aborted.'); return; }

  // ── Verify enough funds are available to cover this month's SIP ──
  await assertSufficientFunds(sip);

  // ── Execute sells ──
  let actualProceeds = 0;
  let actualRecovered = 0;
  console.log(chalk.bold('\nExecuting sells...'));
  for (const d of sellData) {
    const ok = await executeSell(d.symbol, d.qty, prices[d.symbol] || 0, pool);
    if (ok) { actualProceeds += (prices[d.symbol] || 0) * d.qty; actualRecovered += d.cashPool; }
  }

  // ── Update portfolio pool ──
  let remaining = actualProceeds + actualRecovered + sip;

  // ── Execute first share buys ──
  console.log(chalk.bold('\nBuying first shares for new entries...'));
  for (const sym of toBuy) {
    const price = firstShareCosts[sym] || 0;
    if (!price || remaining < price) {
      console.log(chalk.red(`  SKIP ${sym} — pool (${inr(remaining)}) < price (${inr(price)})`));
      continue;
    }
    await executeBuy(sym, 1, price, pool);
    remaining -= price;
  }

  // ── Distribute pool to stock pools and buy ──
  // Reuse weights from the preview buyPlan — same proportions, applied to actual pool.
  console.log(chalk.bold('\nDistributing pool and buying shares...'));

  // Batch-fetch current cash_pool balances for all symbols in one query
  const symbols = buyPlan.map(b => b.symbol);
  const [poolRows] = await pool.execute(
    `SELECT symbol, cash_pool FROM holdings WHERE symbol IN (${sqlIn(symbols)})`,
    symbols
  );
  const currentPoolMap = Object.fromEntries(poolRows.map(r => [r.symbol, parseFloat(r.cash_pool || 0)]));

  for (const b of buyPlan) {
    const addition  = b.weight * remaining;
    const curPool   = currentPoolMap[b.symbol] ?? 0;
    const totalPool = curPool + addition;
    const price     = prices[b.symbol] || 0;
    const qty       = price > 0 ? Math.floor(totalPool / price) : 0;
    let leftover    = totalPool;

    if (qty > 0) {
      const ok = await executeBuy(b.symbol, qty, price, pool);
      if (ok) leftover -= - qty * price;
    }

    // UPDATE only works if the holding row exists. If the first-share buy also failed,
    // there is no row — drop the leftover cash
    const [result] = await pool.execute(
      'UPDATE holdings SET cash_pool=?, updated_at=NOW() WHERE symbol=?',
      [leftover.toFixed(2), b.symbol]
    );
  }

  await saveSnapshot(rankings, toSell, toBuy, buyPlan, pool);
  console.log(chalk.green('\nRebalance complete. Stock pools updated.'));
}

module.exports = { runRebalance, getCurrentPrices, executeBuy };
