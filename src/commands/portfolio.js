const dayjs = require('dayjs');
const chalk = require('chalk');
const Table = require('cli-table3');

const { getPool } = require('../config/database');
const { getKite, marketValidation } = require('../config/kite');
const { calculateWeights } = require('../services/allocation');
const { getNifty50Symbols } = require('../services/nse');
const { calculateRankings } = require('../services/ranking');
const { getCurrentPrices, executeBuy } = require('../services/rebalance');
const { xirr } = require('../services/xirr');
const { confirm, inr, inrd, pct } = require('../helpers');

// ─── rankings ────────────────────────────────────────────────────────────────

async function showRankings() {
  const pool = getPool();
  const [heldRows] = await pool.execute('SELECT symbol FROM holdings WHERE quantity > 0');
  const held = heldRows.map(r => r.symbol);

  console.log('Fetching Nifty 50 list and calculating rankings...\n');
  const symbols = await getNifty50Symbols();
  const rankings = await calculateRankings(symbols);

  const table = new Table({
    head: ['Rank', 'Symbol', 'LTP', '12M Return', '6M Return', '3M Return', 'Score', 'Status'],
    style: { head: ['cyan'] },
    colAligns: ['right', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
  });

  for (const r of rankings) {
    const isHeld = held.includes(r.symbol);
    let status = '';
    if (r.failed) {
      status = chalk.yellow('DATA ERROR');
    } else if (isHeld) {
      status = r.rank <= 20 ? chalk.green('HOLD') : chalk.red('SELL');
    } else if (r.rank <= 12) {
      status = chalk.yellow('BUY ELIGIBLE');
    }

    table.push([
      r.rank,
      r.symbol + (isHeld ? chalk.cyan(' *') : ''),
      inr(r.priceLTP),
      pct(r.ret12m),
      pct(r.ret6m),
      pct(r.ret3m),
      pct(r.score),
      status,
    ]);
  }

  console.log('\n' + table.toString());
  console.log(chalk.gray('* = currently held'));
  console.log(chalk.gray('Entry eligible: rank ≤ 12 | Hold: rank ≤ 20 | Exit: rank > 20'));
}

// ─── transactions ─────────────────────────────────────────────────────────────

async function showTransactions(symbol) {
  const pool = getPool();

  const [rows] = symbol
    ? await pool.execute(
        'SELECT * FROM transactions WHERE symbol = ? ORDER BY trade_date DESC, id DESC LIMIT 100',
        [symbol]
      )
    : await pool.execute(
        'SELECT * FROM transactions ORDER BY trade_date DESC, id DESC LIMIT 100'
      );

  if (!rows.length) {
    console.log('No transactions found.');
    return;
  }

  const table = new Table({
    head: ['Date', 'Symbol', 'Type', 'Qty', 'Price', 'Amount', 'Order ID'],
    style: { head: ['cyan'] },
    colAligns: ['left', 'left', 'left', 'right', 'right', 'right', 'left'],
  });

  for (const tx of rows) {
    const typeStr = tx.type === 'BUY' ? chalk.green('BUY') : chalk.red('SELL');
    table.push([
      dayjs(tx.trade_date).format('DD-MMM-YYYY'),
      tx.symbol,
      typeStr,
      tx.quantity,
      inr(tx.price),
      inr(tx.amount),
      tx.order_id || '-',
    ]);
  }

  console.log('\n' + table.toString());
}

// ─── init ─────────────────────────────────────────────────────────────────────

/**
 * First-time portfolio setup:
 *  1. Buy exactly 1 share of each of the top-15 ranked stocks (rank order,
 *     stop if pool runs dry for a stock).
 *  2. Save the remaining cash in portfolio_pool.
 *  3. The first monthly rebalance will then run the full weighted allocation
 *     against that pool (by which point the positions have real returns).
 */
async function initPortfolio(totalAmount, execute = false) {
  const pool = getPool();

  const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM holdings WHERE quantity > 0');
  if (cnt > 0) {
    console.log(chalk.yellow(`\nWarning: Strategy portfolio already has ${cnt} position(s).`));
    if (execute) {
      const ans = await confirm('Continue anyway? (yes/no): ');
      if (ans !== 'yes') { console.log('Aborted.'); return; }
    }
  }

  console.log(chalk.bold(`\n${'═'.repeat(55)}`));
  console.log(chalk.bold(`  PORTFOLIO INITIALISATION${execute ? '' : chalk.yellow(' [PREVIEW]')}`));
  console.log(chalk.bold(`${'═'.repeat(55)}\n`));
  console.log(`Total capital : ${chalk.cyan(inr(totalAmount))}\n`);

  console.log(chalk.bold('Step 1: Fetching Nifty 50 list...'));
  const nifty50 = await getNifty50Symbols();
  console.log(`  → ${nifty50.length} stocks\n`);

  console.log(chalk.bold('Step 2: Calculating ranking scores...'));
  const rankings = await calculateRankings(nifty50);
  const top15 = rankings.slice(0, 15);

  console.log(chalk.bold('\nFetching current prices...'));
  const prices = await getCurrentPrices(top15.map(r => r.symbol));

  // Determine which stocks can afford a first share
  let poolBalance = totalAmount;
  const orders = [];
  const skipped = [];

  for (const r of top15) {
    const price = prices[r.symbol] || 0;
    if (!price || poolBalance < price) {
      skipped.push({ symbol: r.symbol, price, poolAt: poolBalance });
      continue;
    }
    orders.push({ symbol: r.symbol, price, rank: r.rank, score: r.score });
    poolBalance -= price;
  }

  // Display plan
  const table = new Table({
    head: ['Rank', 'Symbol', 'Score', 'Price', 'Qty'],
    style: { head: ['cyan'] },
    colAligns: ['right', 'left', 'right', 'right', 'right'],
  });

  for (const o of orders) {
    table.push([o.rank, o.symbol, pct(o.score), inrd(o.price), 1]);
  }

  console.log('\n' + chalk.bold('─── INITIAL BUY PLAN (1 share each) ─────────────────────'));
  console.log(table.toString());

  const totalSpent = orders.reduce((s, o) => s + o.price, 0);
  console.log(`Total capital    : ${inr(totalAmount)}`);
  console.log(`Spent on shares  : ${chalk.cyan(inr(totalSpent))}`);

  if (skipped.length) {
    console.log(chalk.yellow(`\n${skipped.length} stock(s) skipped — price exceeded remaining pool:`));
    skipped.forEach(s => console.log(chalk.yellow(`  ${s.symbol.padEnd(15)} ₹${s.price.toFixed(2)} > pool ${inr(s.poolAt)}`)));
  }

  if (!execute) {
    console.log(chalk.yellow('\nPreview only — no orders placed.'));
    console.log(`To execute: node src/index.js portfolio init --amount ${totalAmount} --execute`);
    return;
  }

  console.log(chalk.bold.red('\n⚠  This will place REAL orders on your Zerodha account.'));
  const ans = await confirm(`Buy 1 share each of ${orders.length} stocks? (yes/no): `);
  if (ans !== 'yes') { console.log('Aborted.'); return; }

  // ── Verify the if we can place orders ──
  await marketValidation(totalAmount);

  console.log('');

  for (const o of orders) {
    await executeBuy(o.symbol, 1, o.price, pool);
  }

  console.log(chalk.green(`\nInitialisation complete.`));
  console.log(`  node src/index.js rebalance preview --amount <monthly_sip>\n`);
}

// ─── sync ─────────────────────────────────────────────────────────────────────

async function syncFromZerodha() {
  const pool = getPool();

  console.log(chalk.yellow(
    '\n⚠  WARNING: sync imports ALL your Zerodha NSE holdings into the strategy database.\n' +
    '   Only use this if those holdings ARE already your strategy portfolio.\n' +
    '   For a fresh strategy start, use instead:\n' +
    '     node src/index.js portfolio init --amount <total>\n'
  ));
  const ans = await confirm('Proceed with sync? (yes/no): ');
  if (ans !== 'yes') { console.log('Aborted.'); return; }

  const kiteHoldings = await getKite().getHoldings();

  const nseHoldings = kiteHoldings.filter(h => h.exchange === 'NSE' && h.quantity > 0);
  if (!nseHoldings.length) {
    console.log('No NSE holdings found in your Zerodha account.');
    return;
  }

  console.log(`\nFound ${nseHoldings.length} NSE holding(s) in Zerodha:\n`);

  const today = dayjs().format('YYYY-MM-DD');
  let imported = 0;
  let skipped = 0;

  for (const h of nseHoldings) {
    const sym = h.tradingsymbol;
    const [existing] = await pool.execute('SELECT id FROM holdings WHERE symbol = ?', [sym]);

    if (existing.length) {
      console.log(chalk.gray(`  SKIP  ${sym.padEnd(15)} — already in DB`));
      skipped++;
      continue;
    }

    await pool.execute(
      'INSERT INTO holdings (symbol, quantity, average_price, first_buy_date) VALUES (?, ?, ?, ?)',
      [sym, h.quantity, h.average_price, today]
    );
    console.log(chalk.green(`  ADDED ${sym.padEnd(15)} qty=${h.quantity}  avg=₹${h.average_price}`));
    imported++;
  }

  console.log(`\n${imported} imported, ${skipped} skipped.`);
  console.log(chalk.yellow(
    '\nNote: first_buy_date defaults to today. Update it via:\n' +
    '  node src/index.js portfolio set-date <SYMBOL> <YYYY-MM-DD>'
  ));
}

// ─── add (manual) ─────────────────────────────────────────────────────────────

async function addHolding(symbol, quantity, avgPrice, date) {
  const pool = getPool();
  const sym = symbol.toUpperCase().trim();
  const qty = parseInt(quantity);
  const avg = parseFloat(avgPrice);
  const d = dayjs(date, 'YYYY-MM-DD');

  if (!d.isValid()) throw new Error(`Invalid date: ${date}. Use YYYY-MM-DD format.`);
  if (isNaN(qty) || qty <= 0) throw new Error('Quantity must be a positive integer.');
  if (isNaN(avg) || avg <= 0) throw new Error('Average price must be positive.');

  const [existing] = await pool.execute('SELECT id, quantity, average_price FROM holdings WHERE symbol = ?', [sym]);

  if (existing.length) {
    const h = existing[0];
    const newQty = h.quantity + qty;
    const newAvg = (h.quantity * h.average_price + qty * avg) / newQty;
    await pool.execute(
      'UPDATE holdings SET quantity = ?, average_price = ?, updated_at = NOW() WHERE symbol = ?',
      [newQty, newAvg, sym]
    );
    console.log(`Updated ${sym}: qty ${h.quantity} → ${newQty}, avg ₹${newAvg.toFixed(2)}`);
  } else {
    await pool.execute(
      'INSERT INTO holdings (symbol, quantity, average_price, first_buy_date) VALUES (?, ?, ?, ?)',
      [sym, qty, avg, d.format('YYYY-MM-DD')]
    );
    console.log(`Added ${sym}: qty=${qty}, avg=₹${avg}, from=${d.format('DD-MMM-YYYY')}`);
  }

  // Also record as a BUY transaction
  await pool.execute(
    'INSERT INTO transactions (symbol, trade_date, type, quantity, price, amount) VALUES (?, ?, ?, ?, ?, ?)',
    [sym, d.format('YYYY-MM-DD'), 'BUY', qty, avg, qty * avg]
  );
}

// ─── set-date ─────────────────────────────────────────────────────────────────

async function setDate(symbol, date) {
  const pool = getPool();
  const sym = symbol.toUpperCase().trim();
  const d = dayjs(date, 'YYYY-MM-DD');
  if (!d.isValid()) throw new Error(`Invalid date: ${date}`);

  const [rows] = await pool.execute('SELECT id FROM holdings WHERE symbol = ?', [sym]);
  if (!rows.length) throw new Error(`${sym} not found in holdings.`);

  await pool.execute('UPDATE holdings SET first_buy_date = ? WHERE symbol = ?', [d.format('YYYY-MM-DD'), sym]);
  console.log(`Updated first_buy_date for ${sym} to ${d.format('DD-MMM-YYYY')}`);
}

// ─── snapshots ────────────────────────────────────────────────────────────────

async function showSnapshots() {
  const pool = getPool();
  const [dates] = await pool.execute(
    'SELECT DISTINCT rebalance_date FROM monthly_snapshots ORDER BY rebalance_date DESC LIMIT 12'
  );

  if (!dates.length) {
    console.log('No rebalance snapshots found.');
    return;
  }

  for (const { rebalance_date } of dates) {
    const [rows] = await pool.execute(
      'SELECT * FROM monthly_snapshots WHERE rebalance_date = ? ORDER BY rank_position',
      [rebalance_date]
    );
    console.log(chalk.bold(`\n${dayjs(rebalance_date).format('DD MMM YYYY')}`));

    const table = new Table({
      head: ['Rank', 'Symbol', 'Ranking Score', 'Alloc Score', 'Action'],
      style: { head: ['cyan'] },
    });

    for (const r of rows.slice(0, 20)) {
      const action = r.action === 'BUY' ? chalk.green('BUY')
        : r.action === 'SELL' ? chalk.red('SELL')
        : r.action === 'HOLD' ? chalk.green('HOLD')
        : '';
      table.push([r.rank_position, r.symbol, pct(r.ranking_score), r.allocation_score !== null ? pct(r.allocation_score) : '-', action]);
    }
    console.log(table.toString());
  }
}

// ─── details ──────────────────────────────────────────────────────────────────

function formatHeldDuration(firstBuyDate) {
  const start = dayjs(firstBuyDate);
  const now = dayjs();

  const years = now.diff(start, 'year');
  const afterYears = start.add(years, 'year');
  const months = now.diff(afterYears, 'month');
  const afterMonths = afterYears.add(months, 'month');
  const days = now.diff(afterMonths, 'day');

  const parts = [];
  if (years > 0) parts.push(`${years}y`);
  if (months > 0) parts.push(`${months}m`);
  if (days > 0) parts.push(`${days}d`);

  return parts.length ? parts.join(' ') : '0d';
}

async function showDetails() {
  const pool = getPool();
  const [holdings] = await pool.execute('SELECT * FROM holdings WHERE quantity > 0');

  if (!holdings.length) {
    console.log('No holdings found.');
    return;
  }

  const symbols = holdings.map(h => h.symbol);
  const prices = await getCurrentPrices(symbols);

  let totalValue = 0;
  let totalInvested = 0;
  let totalCashPool = 0;

  const rows = holdings.map(h => {
    const ltp = prices[h.symbol] || 0;
    const value = ltp * h.quantity;
    const invested = h.average_price * h.quantity;
    const gainLoss = value - invested;
    const ret = invested > 0 ? (value - invested) / invested : 0;
    const cashPool = parseFloat(h.cash_pool || 0);
    totalValue += value;
    totalInvested += invested;
    totalCashPool += cashPool;
    return { symbol: h.symbol, qty: h.quantity, avgPrice: h.average_price,
             firstBuyDate: h.first_buy_date, ltp, value, invested, gainLoss, ret, cashPool };
  });

  rows.sort((a, b) => b.value - a.value);

  // Single query for all transactions — used for both portfolio XIRR and per-stock XIRR
  const [allTxns] = await pool.execute(
    'SELECT symbol, trade_date, type, quantity, price FROM transactions ORDER BY trade_date ASC'
  );

  // Portfolio-level XIRR
  let portfolioXIRR = null;
  if (allTxns.length) {
    const pfCashflows = allTxns.map(tx => ({
      amount: tx.type === 'BUY' ? -(tx.quantity * tx.price) : (tx.quantity * tx.price),
      date: new Date(tx.trade_date),
    }));
    for (const r of rows) {
      pfCashflows.push({ amount: r.value, date: new Date() });
    }
    const result = xirr(pfCashflows);
    portfolioXIRR = isFinite(result) ? result : null;
  }

  // Per-stock XIRR (only for holdings >= 12 months, filter from already-fetched allTxns)
  const xirrMap = {};
  const needXIRR = rows.filter(r => dayjs().diff(dayjs(r.firstBuyDate), 'month') >= 12);
  if (needXIRR.length) {
    const needSet = new Set(needXIRR.map(r => r.symbol));
    const txnBySymbol = {};
    for (const tx of allTxns) {
      if (!needSet.has(tx.symbol)) continue;
      if (!txnBySymbol[tx.symbol]) txnBySymbol[tx.symbol] = [];
      txnBySymbol[tx.symbol].push(tx);
    }
    for (const r of needXIRR) {
      const symTxns = txnBySymbol[r.symbol] || [];
      if (!symTxns.length) continue;
      const cashflows = symTxns.map(tx => ({
        amount: tx.type === 'BUY' ? -(tx.quantity * tx.price) : (tx.quantity * tx.price),
        date: new Date(tx.trade_date),
      }));
      cashflows.push({ amount: r.value, date: new Date() });
      const result = xirr(cashflows);
      xirrMap[r.symbol] = isFinite(result) ? result : null;
    }
  }

  const portfolioReturn = totalInvested > 0 ? (totalValue - totalInvested) / totalInvested : 0;
  const unrealizedPnL = totalValue - totalInvested;
  const lastInvestmentDate = allTxns.length
    ? allTxns.reduce((latest, tx) => (tx.trade_date > latest ? tx.trade_date : latest), allTxns[0].trade_date)
    : null;

  const signedPct = (n) => {
    const s = (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
    return n >= 0 ? chalk.green(s) : chalk.red(s);
  };
  const signedInr = (n) => {
    const abs = Math.round(Math.abs(n)).toLocaleString('en-IN');
    const s = (n >= 0 ? '+₹' : '-₹') + abs;
    return n >= 0 ? chalk.green(s) : chalk.red(s);
  };

  // ─── 1. Portfolio Summary ────────────────────────────────────────────────────
  console.log('');
  console.log(`Portfolio Value      : ${chalk.cyan(inr(totalValue))}`);
  console.log(`Invested Amount      : ${inr(totalInvested)}`);
  console.log(`Unrealized P&L       : ${signedInr(unrealizedPnL)} (${signedPct(portfolioReturn)})`);
  console.log('');
  console.log(`Portfolio Return     : ${signedPct(portfolioReturn)}`);
  console.log(`Portfolio XIRR       : ${portfolioXIRR !== null ? signedPct(portfolioXIRR) : chalk.gray('-')}`);
  console.log('');
  console.log(`Stock Pool Amount    : ${inr(totalCashPool)}`);
  console.log(`Stocks Held          : ${rows.length}`);
  console.log(`Last Invested        : ${lastInvestmentDate ? dayjs(lastInvestmentDate).format('DD MMM YYYY') : chalk.gray('-')}`);

  // ─── 2. Holdings Table ────────────────────────────────────────────────────────
  const table = new Table({
    head: ['Symbol', 'Qty', 'Avg Price', 'LTP', 'Value', 'Alloc %', 'Held', 'Gain/Loss', 'Return', 'XIRR'],
    style: { head: ['cyan'] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  });

  for (const r of rows) {
    const allocPct = totalValue > 0 ? (r.value / totalValue) * 100 : 0;
    const xirrVal = r.symbol in xirrMap ? xirrMap[r.symbol] : undefined;
    const xirrStr = xirrVal !== undefined && xirrVal !== null
      ? signedPct(xirrVal)
      : chalk.gray('-');

    table.push([
      r.symbol,
      r.qty,
      inrd(r.avgPrice),
      inrd(r.ltp),
      inr(r.value),
      allocPct.toFixed(1) + '%',
      formatHeldDuration(r.firstBuyDate),
      signedInr(r.gainLoss),
      signedPct(r.ret),
      xirrStr,
    ]);
  }

  console.log('\n' + table.toString());

  // ─── 3. Key Insights ─────────────────────────────────────────────────────────
  const best = rows.reduce((a, b) => (a.ret > b.ret ? a : b));
  const worst = rows.reduce((a, b) => (a.ret < b.ret ? a : b));
  const largest = rows[0]; // already sorted by value desc
  const profitable = rows.filter(r => r.ret > 0).length;
  const largestAllocPct = totalValue > 0 ? (largest.value / totalValue) * 100 : 0;

  console.log('');
  console.log(`Best Performer       : ${chalk.green(best.symbol)} (${signedPct(best.ret)})`);
  console.log(`Worst Performer      : ${chalk.red(worst.symbol)} (${signedPct(worst.ret)})`);
  console.log('');
  console.log(`Largest Holding      : ${chalk.cyan(largest.symbol)} (${largestAllocPct.toFixed(1)}%)`);
  console.log(`Portfolio Win Rate   : ${profitable} / ${rows.length} (${((profitable / rows.length) * 100).toFixed(1)}%)`);
  console.log('');
}

module.exports = { initPortfolio, showRankings, showTransactions, syncFromZerodha, addHolding, setDate, showSnapshots, showDetails };
