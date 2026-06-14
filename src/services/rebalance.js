const dayjs = require('dayjs');
const chalk = require('chalk');
const Table = require('cli-table3');

const { yf: yahooFinance, toYFSymbol } = require('../config/yahoo');

const { getPool } = require('../config/database');
const { getKite } = require('../config/kite');
const { getNifty50Symbols } = require('./nse');
const { calculateRankings } = require('./ranking');
const { calculateWeights } = require('./allocation');
const { checkAndApplySplits } = require('./corporateActions');
const { POOL_KEY, sqlIn, confirm, inr, inrd, pct } = require('../helpers');

// ─── Portfolio pool (stored in config table) ──────────────────────────────────

async function getPortfolioPool(pool) {
  const [rows] = await pool.execute(
    'SELECT `value` FROM config WHERE `key` = ?', [POOL_KEY]
  );
  return rows.length ? parseFloat(rows[0].value) : 0;
}

async function setPortfolioPool(pool, amount) {
  const v = Math.max(0, amount).toFixed(2);
  await pool.execute(
    'INSERT INTO config (`key`,`value`) VALUES (?,?) ON DUPLICATE KEY UPDATE `value`=?, updated_at=NOW()',
    [POOL_KEY, v, v]
  );
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getHeldSymbols() {
  const [rows] = await getPool().execute('SELECT symbol FROM holdings WHERE quantity > 0');
  return rows.map(r => r.symbol);
}

async function getCurrentPrices(symbols) {
  if (!symbols.length) return {};
  const results = await yahooFinance.quote(symbols.map(toYFSymbol));
  const arr = Array.isArray(results) ? results : [results];
  const prices = {};
  for (const r of arr) prices[r.symbol.replace('.NS', '')] = r.regularMarketPrice;
  return prices;
}

// ─── Order helpers ────────────────────────────────────────────────────────────

async function executeSell(symbol, qty, price, pool) {
  const today = dayjs().format('YYYY-MM-DD');
  process.stdout.write(`  SELL  ${qty} × ${symbol.padEnd(12)} @ ${inrd(price)}...`);

  let orderId = null;
  try {
    const res = await getKite().placeOrder('regular', {
      tradingsymbol: symbol, exchange: 'NSE',
      transaction_type: 'SELL', order_type: 'MARKET',
      quantity: qty, product: 'CNC',
    });
    orderId = res.order_id;
    process.stdout.write(chalk.green(` ✓ order ${orderId}\n`));
  } catch (err) {
    process.stdout.write(chalk.red(` ✗ FAILED: ${err.message}\n`));
    return false;
  }

  const amount = qty * price;
  await pool.execute(
    'INSERT INTO transactions (symbol,trade_date,type,quantity,price,amount,order_id) VALUES (?,?,?,?,?,?,?)',
    [symbol, today, 'SELL', qty, price, amount, orderId]
  );
  await pool.execute('DELETE FROM holdings WHERE symbol=?', [symbol]);
  return true;
}

async function executeBuy(symbol, qty, price, pool) {
  const today = dayjs().format('YYYY-MM-DD');
  const amount = qty * price;
  process.stdout.write(`  BUY   ${qty} × ${symbol.padEnd(12)} @ ${inrd(price)}...`);

  let orderId = null;
  try {
    const res = await getKite().placeOrder('regular', {
      tradingsymbol: symbol, exchange: 'NSE',
      transaction_type: 'BUY', order_type: 'MARKET',
      quantity: qty, product: 'CNC',
    });
    orderId = res.order_id;
    process.stdout.write(chalk.green(` ✓ order ${orderId}\n`));
  } catch (err) {
    process.stdout.write(chalk.red(` ✗ FAILED: ${err.message}\n`));
    return false;
  }

  await pool.execute(
    'INSERT INTO transactions (symbol,trade_date,type,quantity,price,amount,order_id) VALUES (?,?,?,?,?,?,?)',
    [symbol, today, 'BUY', qty, price, amount, orderId]
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
      [symbol, qty, price, today]
    );
  }
  return true;
}

// ─── Display ──────────────────────────────────────────────────────────────────

function printPoolSummary(prev, sellProceeds, recoveredPools, sip, working) {
  console.log(chalk.bold('\n─── PORTFOLIO POOL ──────────────────────────────'));
  console.log(`  Previous balance       : ${inr(prev).padStart(12)}`);
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

function printAllocationTable(buyPlan, poolToDistribute) {
  console.log(chalk.bold('\n─── ALLOCATION FROM POOL ────────────────────────'));
  console.log(`  Pool to distribute: ${chalk.cyan(inr(poolToDistribute))}\n`);

  const table = new Table({
    head: ['Symbol', 'Score', 'Weight', '+Pool', 'Cur Pool', 'Total Pool', 'Buy', 'Spent', 'Remaining'],
    style: { head: ['cyan'] },
    colAligns: ['left','right','right','right','right','right','right','right','right'],
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
      b.qty > 0 ? b.qty : chalk.gray('0'),
      inr(b.spent),
      inr(b.remaining),
    ]);
  }
  console.log(table.toString());

  const totalSpent     = buyPlan.reduce((s, b) => s + b.spent, 0);
  const totalRemaining = buyPlan.reduce((s, b) => s + b.remaining, 0);
  console.log(`  Total spent          : ${inr(totalSpent)}`);
  console.log(`  Carried to next month: ${chalk.gray(inr(totalRemaining))}`);
}

function printRankingsTable(rankings, heldSymbols) {
  const table = new Table({
    head: ['Rank', 'Symbol', '12M Return', '3M Return', 'Score', 'Status'],
    style: { head: ['cyan'] },
    colAligns: ['right','left','right','right','right','left'],
  });
  for (const r of rankings.slice(0, 25)) {
    const isHeld = heldSymbols.includes(r.symbol);
    let status = '';
    if (isHeld)         status = r.rank <= 20 ? chalk.green('HOLD') : chalk.red('SELL');
    else if (r.rank<=12) status = chalk.yellow('BUY ELIGIBLE');
    table.push([r.rank, r.symbol + (isHeld ? ' *' : ''), pct(r.ret12m), pct(r.ret3m), pct(r.score), status]);
  }
  console.log('\n' + table.toString());
  console.log(chalk.gray('* = currently held | top 25 shown'));
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
  const prevPool   = await getPortfolioPool(pool);
  let workingPool  = prevPool + totalSellProceeds + totalRecoveredPools + sip;

  printPoolSummary(prevPool, totalSellProceeds, totalRecoveredPools, sip, workingPool);

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

  printAllocationTable(buyPlan, workingPool);
  printRankingsTable(rankings, heldBefore);

  if (dryRun) {
    console.log(chalk.yellow('\nDry run complete. No orders placed.'));
    console.log(`Execute: node src/index.js rebalance run --amount ${sip}`);
    return;
  }

  // ── Confirm ──
  console.log(chalk.bold.red('\n⚠  This will place REAL orders on your Zerodha account.'));
  if (await confirm('Type "yes" to proceed: ') !== 'yes') { console.log('Aborted.'); return; }

  // ── Execute sells ──
  let actualProceeds = 0;
  let actualRecovered = 0;
  console.log(chalk.bold('\nExecuting sells...'));
  for (const d of sellData) {
    const ok = await executeSell(d.symbol, d.qty, prices[d.symbol] || 0, pool);
    if (ok) { actualProceeds += (prices[d.symbol] || 0) * d.qty; actualRecovered += d.cashPool; }
  }

  // ── Update portfolio pool ──
  const actualPool = prevPool + actualProceeds + actualRecovered + sip;
  let remaining = actualPool;
  await setPortfolioPool(pool, remaining);

  // ── Execute first share buys ──
  console.log(chalk.bold('\nBuying first shares for new entries...'));
  for (const sym of toBuy) {
    const price = firstShareCosts[sym] || 0;
    if (!price || remaining < price) {
      console.log(chalk.red(`  SKIP ${sym} — pool (${inr(remaining)}) < price (${inr(price)})`));
      continue;
    }
    const ok = await executeBuy(sym, 1, price, pool);
    if (ok) remaining -= price;
  }

  // ── Distribute pool to stock pools and buy ──
  // Reuse weights from the preview buyPlan — same proportions, applied to actual pool.
  console.log(chalk.bold('\nDistributing pool and buying shares...'));

  let strandedCash = 0; // cash that couldn't be saved because the holding row doesn't exist

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
    const leftover  = totalPool - qty * price;

    if (qty > 0) await executeBuy(b.symbol, qty, price, pool);

    // UPDATE only works if the holding row exists. If the first-share buy also failed,
    // there is no row — save the entire allocation back to the portfolio pool for next month.
    const [result] = await pool.execute(
      'UPDATE holdings SET cash_pool=?, updated_at=NOW() WHERE symbol=?',
      [leftover.toFixed(2), b.symbol]
    );
    if (result.affectedRows === 0) {
      strandedCash += totalPool;
      console.log(chalk.yellow(`  WARNING: no holding row for ${b.symbol} — ${inr(totalPool)} carried to next month's pool`));
    }
  }

  // Preserve stranded cash so it is not lost; zeroes on a clean run.
  await setPortfolioPool(pool, strandedCash);

  await saveSnapshot(rankings, toSell, toBuy, buyPlan, pool);
  console.log(chalk.green('\nRebalance complete. Portfolio pool zeroed. Stock pools updated.'));
}

module.exports = { runRebalance, getCurrentPrices, getPortfolioPool, setPortfolioPool, executeBuy };
