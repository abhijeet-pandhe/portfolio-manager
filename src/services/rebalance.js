const dayjs = require('dayjs');
const chalk = require('chalk');
const Table = require('cli-table3');
const readline = require('readline');

const { getPool } = require('../config/database');
const { getKite } = require('../config/kite');
const { getNifty50Symbols } = require('./nse');
const { calculateRankings } = require('./ranking');
const { calculateAllocation } = require('./allocation');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inr(n) {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function pct(n) {
  const s = (n * 100).toFixed(2) + '%';
  return n >= 0 ? chalk.green(s) : chalk.red(s);
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, ans => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function getHeldSymbols() {
  const [rows] = await getPool().execute(
    'SELECT symbol FROM holdings WHERE quantity > 0'
  );
  return rows.map(r => r.symbol);
}

async function getCurrentPrices(symbols) {
  if (!symbols.length) return {};
  const instruments = symbols.map(s => `NSE:${s}`);
  const quotes = await getKite().getQuote(instruments);
  const prices = {};
  for (const [key, val] of Object.entries(quotes)) {
    prices[key.replace('NSE:', '')] = val.last_price;
  }
  return prices;
}

// ─── Display ─────────────────────────────────────────────────────────────────

function printRankingsTable(rankings, heldSymbols) {
  const table = new Table({
    head: ['Rank', 'Symbol', '12M Return', '3M Return', 'Score', 'Status'],
    style: { head: ['cyan'] },
    colAligns: ['right', 'left', 'right', 'right', 'right', 'left'],
  });

  for (const r of rankings.slice(0, 25)) {
    const isHeld = heldSymbols.includes(r.symbol);
    let status = '';
    if (isHeld) {
      status = r.rank <= 20 ? chalk.green('HOLD') : chalk.red('SELL');
    } else if (r.rank <= 12) {
      status = chalk.yellow('BUY ELIGIBLE');
    }
    table.push([
      r.rank,
      r.symbol + (isHeld ? ' *' : ''),
      pct(r.ret12m),
      pct(r.ret3m),
      pct(r.score),
      status,
    ]);
  }

  console.log(table.toString());
  console.log(chalk.gray('* = currently held | Showing top 25'));
}

function printTradePlan(plan, prices) {
  console.log('\n' + chalk.bold('─── EXITS ───────────────────────────────────'));
  if (plan.toSell.length === 0) {
    console.log('  No exits required.');
  } else {
    for (const s of plan.toSell) {
      console.log(chalk.red(`  SELL  ${s.padEnd(15)} @ ${inr(prices[s] || 0)}`));
    }
  }

  console.log('\n' + chalk.bold('─── ENTRIES ─────────────────────────────────'));
  if (plan.toBuy.length === 0) {
    console.log('  No new entries required.');
  } else {
    for (const s of plan.toBuy) {
      console.log(chalk.green(`  BUY   ${s.padEnd(15)} @ ${inr(prices[s] || 0)}`));
    }
  }

  console.log('\n' + chalk.bold('─── MONTHLY INVESTMENT ALLOCATION ───────────'));
  const table = new Table({
    head: ['Symbol', 'Score', 'Weight', 'Amount', 'Price', 'Qty'],
    style: { head: ['cyan'] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
  });

  for (const a of plan.allocation) {
    const price = prices[a.symbol] || 0;
    const qty = price > 0 ? Math.floor(a.amount / price) : 0;
    const label = a.symbol + (plan.toBuy.includes(a.symbol) ? chalk.yellow(' NEW') : '');
    table.push([
      label,
      pct(a.rawScore),
      (a.weight * 100).toFixed(2) + '%',
      inr(a.amount),
      inr(price),
      qty > 0 ? qty : chalk.gray('0'),
    ]);
  }
  console.log(table.toString());
  console.log(chalk.gray(`Total investment: ${inr(plan.monthlyAmount)}`));
}

// ─── Order execution ─────────────────────────────────────────────────────────

async function placeSellOrders(toSell, prices, pool) {
  const today = dayjs().format('YYYY-MM-DD');

  for (const symbol of toSell) {
    const [rows] = await pool.execute(
      'SELECT quantity FROM holdings WHERE symbol = ?',
      [symbol]
    );
    if (!rows.length || rows[0].quantity === 0) continue;

    const qty = rows[0].quantity;
    const price = prices[symbol] || 0;

    process.stdout.write(`  Selling ${qty} × ${symbol}...`);

    let orderId = null;
    try {
      const res = await getKite().placeOrder('regular', {
        tradingsymbol: symbol,
        exchange: 'NSE',
        transaction_type: 'SELL',
        order_type: 'MARKET',
        quantity: qty,
        product: 'CNC',
      });
      orderId = res.order_id;
      process.stdout.write(chalk.green(` order ${orderId}\n`));
    } catch (err) {
      process.stdout.write(chalk.red(` FAILED: ${err.message}\n`));
      continue;
    }

    await pool.execute(
      'INSERT INTO transactions (symbol, trade_date, type, quantity, price, amount, order_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [symbol, today, 'SELL', qty, price, qty * price, orderId]
    );
    await pool.execute('DELETE FROM holdings WHERE symbol = ?', [symbol]);
  }
}

async function placeBuyOrders(allocation, prices, pool) {
  const today = dayjs().format('YYYY-MM-DD');

  for (const a of allocation) {
    if (a.amount < 10) continue;
    const price = prices[a.symbol] || 0;
    if (!price) continue;

    const qty = Math.floor(a.amount / price);
    if (qty < 1) {
      console.log(chalk.gray(`  Skipping ${a.symbol}: allocated ${inr(a.amount)} < 1 share @ ${inr(price)}`));
      continue;
    }

    const actualAmount = qty * price;
    process.stdout.write(`  Buying  ${qty} × ${a.symbol} @ ${inr(price)}...`);

    let orderId = null;
    try {
      const res = await getKite().placeOrder('regular', {
        tradingsymbol: a.symbol,
        exchange: 'NSE',
        transaction_type: 'BUY',
        order_type: 'MARKET',
        quantity: qty,
        product: 'CNC',
      });
      orderId = res.order_id;
      process.stdout.write(chalk.green(` order ${orderId}\n`));
    } catch (err) {
      process.stdout.write(chalk.red(` FAILED: ${err.message}\n`));
      continue;
    }

    await pool.execute(
      'INSERT INTO transactions (symbol, trade_date, type, quantity, price, amount, order_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [a.symbol, today, 'BUY', qty, price, actualAmount, orderId]
    );

    // Upsert holding
    const [existing] = await pool.execute(
      'SELECT id, quantity, average_price FROM holdings WHERE symbol = ?',
      [a.symbol]
    );

    if (existing.length) {
      const h = existing[0];
      const newQty = h.quantity + qty;
      const newAvg = (h.quantity * h.average_price + actualAmount) / newQty;
      await pool.execute(
        'UPDATE holdings SET quantity = ?, average_price = ?, updated_at = NOW() WHERE symbol = ?',
        [newQty, newAvg, a.symbol]
      );
    } else {
      await pool.execute(
        'INSERT INTO holdings (symbol, quantity, average_price, first_buy_date) VALUES (?, ?, ?, ?)',
        [a.symbol, qty, price, today]
      );
    }
  }
}

async function saveSnapshot(rankings, plan, pool) {
  const today = dayjs().format('YYYY-MM-DD');
  const alloc = Object.fromEntries(plan.allocation.map(a => [a.symbol, a.rawScore]));

  for (const r of rankings) {
    let action = null;
    if (plan.toSell.includes(r.symbol)) action = 'SELL';
    else if (plan.toBuy.includes(r.symbol)) action = 'BUY';
    else if (plan.allocation.some(a => a.symbol === r.symbol)) action = 'HOLD';

    await pool.execute(
      'INSERT INTO monthly_snapshots (rebalance_date, symbol, rank_position, ranking_score, allocation_score, action) VALUES (?, ?, ?, ?, ?, ?)',
      [today, r.symbol, r.rank, r.score, alloc[r.symbol] ?? null, action]
    );
  }
}

// ─── Main rebalance ───────────────────────────────────────────────────────────

/**
 * @param {number} monthlyAmount  Monthly investment in INR
 * @param {boolean} dryRun        If true, only preview — no orders placed
 */
async function runRebalance(monthlyAmount, dryRun = true) {
  const pool = getPool();

  console.log(chalk.bold(`\n${'═'.repeat(50)}`));
  console.log(chalk.bold(`  MONTHLY REBALANCE${dryRun ? chalk.yellow(' [DRY RUN]') : ''}`));
  console.log(chalk.bold(`${'═'.repeat(50)}\n`));
  console.log(`Monthly investment: ${chalk.cyan(inr(monthlyAmount))}`);
  console.log(`Date: ${dayjs().format('DD MMM YYYY')}\n`);

  // Step 1 — Nifty 50 list
  console.log(chalk.bold('Step 1: Fetching Nifty 50 constituents...'));
  const nifty50 = await getNifty50Symbols();
  console.log(`  → ${nifty50.length} stocks found\n`);

  // Step 2-3 — Rankings
  console.log(chalk.bold('Step 2-3: Calculating ranking scores...'));
  const rankings = await calculateRankings(nifty50);
  console.log('');

  // Step 4 — Identify exits
  console.log(chalk.bold('Step 4: Identifying exits...'));
  const heldBefore = await getHeldSymbols();

  const toSell = heldBefore.filter(sym => {
    if (!nifty50.includes(sym)) {
      console.log(`  ${chalk.red('EXIT')} ${sym} — removed from Nifty 50`);
      return true;
    }
    const r = rankings.find(x => x.symbol === sym);
    if (r && r.rank > 20) {
      console.log(`  ${chalk.red('EXIT')} ${sym} — rank ${r.rank} > 20`);
      return true;
    }
    return false;
  });

  if (toSell.length === 0) console.log('  No exits required.');
  console.log('');

  // Step 5 — Identify entries
  console.log(chalk.bold('Step 5: Identifying entries...'));
  const heldAfterSell = heldBefore.filter(s => !toSell.includes(s));
  const needed = 15 - heldAfterSell.length;

  const toBuy = rankings
    .filter(r => !heldAfterSell.includes(r.symbol))
    .slice(0, needed)
    .map(r => r.symbol);

  const finalHoldings = [...heldAfterSell, ...toBuy];

  if (toBuy.length === 0) {
    console.log('  No new entries required.');
  } else {
    for (const s of toBuy) {
      const r = rankings.find(x => x.symbol === s);
      console.log(`  ${chalk.green('ENTRY')} ${s} — rank ${r?.rank}`);
    }
  }
  console.log('');

  // Fetch current prices for all relevant symbols
  console.log(chalk.bold('Fetching current prices...'));
  const allSymbols = [...new Set([...heldBefore, ...finalHoldings])];
  const prices = await getCurrentPrices(allSymbols);
  console.log(`  → Prices fetched for ${Object.keys(prices).length} symbols\n`);

  // Step 6-8 — Capital allocation
  console.log(chalk.bold('Step 6-8: Calculating allocation scores...'));
  const allocScores = await calculateAllocation(finalHoldings, prices);
  const allocation = allocScores.map(a => ({
    ...a,
    amount: a.weight * monthlyAmount,
  }));
  console.log('');

  const plan = { toSell, toBuy, allocation, monthlyAmount };

  // Print full trade plan
  printTradePlan(plan, prices);
  console.log('');
  printRankingsTable(rankings, heldBefore);

  if (dryRun) {
    console.log(chalk.yellow('\nDry run complete. No orders placed.'));
    console.log(`Run with real orders: ${chalk.cyan('node src/index.js rebalance run --amount ' + monthlyAmount)}`);
    return;
  }

  // Confirm before placing real orders
  console.log(chalk.bold.red('\n⚠  This will place REAL orders on your Zerodha account.'));
  const ans = await confirm('Type "yes" to proceed: ');
  if (ans !== 'yes') {
    console.log('Aborted.');
    return;
  }

  // Step 9 — Execute
  console.log(chalk.bold('\nExecuting sells...'));
  await placeSellOrders(toSell, prices, pool);

  console.log(chalk.bold('\nExecuting buys...'));
  await placeBuyOrders(allocation, prices, pool);

  // Save snapshot
  await saveSnapshot(rankings, plan, pool);
  console.log(chalk.green('\nRebalance complete. Snapshot saved.'));
}

module.exports = { runRebalance };
