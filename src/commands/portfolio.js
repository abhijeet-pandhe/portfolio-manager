const dayjs = require('dayjs');
const chalk = require('chalk');
const Table = require('cli-table3');
const readline = require('readline');

const { getPool } = require('../config/database');
const { getKite } = require('../config/kite');
const { getPositionScore } = require('../services/allocation');
const { getNifty50Symbols } = require('../services/nse');
const { calculateRankings } = require('../services/ranking');

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

function inr(n) {
  return `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(n, pad = 0) {
  const s = `${(n * 100).toFixed(2)}%`;
  return n >= 0 ? chalk.green(s.padStart(pad)) : chalk.red(s.padStart(pad));
}

// ─── status ──────────────────────────────────────────────────────────────────

async function showStatus() {
  const pool = getPool();
  const [holdings] = await pool.execute(
    'SELECT * FROM holdings WHERE quantity > 0 ORDER BY symbol'
  );

  if (!holdings.length) {
    console.log('No holdings. Use `portfolio sync` or `portfolio add` to get started.');
    return;
  }

  const instruments = holdings.map(h => `NSE:${h.symbol}`);
  const quotes = await getKite().getQuote(instruments);

  const table = new Table({
    head: ['Symbol', 'Qty', 'Avg Cost', 'LTP', 'Value', 'Abs Return', 'Held', 'Alloc Score'],
    style: { head: ['cyan'] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  });

  let totalCost = 0;
  let totalValue = 0;

  for (const h of holdings) {
    const quote = quotes[`NSE:${h.symbol}`];
    const ltp = quote?.last_price || 0;
    const value = ltp * h.quantity;
    const cost = h.average_price * h.quantity;
    const absReturn = (ltp - h.average_price) / h.average_price;
    const days = dayjs().diff(dayjs(h.first_buy_date), 'day');
    const score = await getPositionScore(h.symbol, ltp);

    totalCost += cost;
    totalValue += value;

    table.push([
      h.symbol,
      h.quantity,
      inr(h.average_price),
      inr(ltp),
      inr(value),
      pct(absReturn),
      `${days}d`,
      pct(score),
    ]);
  }

  console.log('\n' + table.toString());

  const totalReturn = (totalValue - totalCost) / totalCost;
  console.log(`\nTotal Invested : ${inr(totalCost)}`);
  console.log(`Total Value    : ${inr(totalValue)}`);
  console.log(`Total Return   : ${pct(totalReturn)}  (${inr(totalValue - totalCost)})`);
}

// ─── rankings ────────────────────────────────────────────────────────────────

async function showRankings() {
  const pool = getPool();
  const [heldRows] = await pool.execute('SELECT symbol FROM holdings WHERE quantity > 0');
  const held = heldRows.map(r => r.symbol);

  console.log('Fetching Nifty 50 list and calculating rankings...\n');
  const symbols = await getNifty50Symbols();
  const rankings = await calculateRankings(symbols);

  const table = new Table({
    head: ['Rank', 'Symbol', '12M Return', '3M Return', 'Score', 'Status'],
    style: { head: ['cyan'] },
    colAligns: ['right', 'left', 'right', 'right', 'right', 'left'],
  });

  for (const r of rankings) {
    const isHeld = held.includes(r.symbol);
    let status = '';
    if (isHeld) {
      status = r.rank <= 20 ? chalk.green('HOLD') : chalk.red('SELL');
    } else if (r.rank <= 12) {
      status = chalk.yellow('BUY ELIGIBLE');
    }

    table.push([
      r.rank,
      r.symbol + (isHeld ? chalk.cyan(' *') : ''),
      pct(r.ret12m),
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
 * First-time portfolio setup: rank Nifty 50, take top 15, buy equal allocation.
 * @param {number} totalAmount   Total initial capital in INR
 * @param {boolean} execute      false = preview only, true = place real orders
 */
async function initPortfolio(totalAmount, execute = false) {
  const pool = getPool();

  // Warn if strategy DB already has positions
  const [[{ cnt }]] = await pool.execute(
    'SELECT COUNT(*) AS cnt FROM holdings WHERE quantity > 0'
  );
  if (cnt > 0) {
    console.log(chalk.yellow(`\nWarning: Strategy portfolio already has ${cnt} position(s).`));
    console.log(chalk.yellow('initPortfolio will ADD to existing holdings, not replace them.'));
    if (execute) {
      const ans = await confirm('Continue anyway? (yes/no): ');
      if (ans !== 'yes') { console.log('Aborted.'); return; }
    }
  }

  console.log(chalk.bold(`\n${'═'.repeat(52)}`));
  console.log(chalk.bold(`  PORTFOLIO INITIALISATION${execute ? '' : chalk.yellow(' [PREVIEW]')}`));
  console.log(chalk.bold(`${'═'.repeat(52)}\n`));
  console.log(`Total capital : ${chalk.cyan(inr(totalAmount))}`);
  console.log(`Per stock (÷15): ${chalk.cyan(inr(totalAmount / 15))}\n`);

  // Nifty 50 + rankings
  console.log(chalk.bold('Step 1: Fetching Nifty 50 list...'));
  const nifty50 = await getNifty50Symbols();
  console.log(`  → ${nifty50.length} stocks\n`);

  console.log(chalk.bold('Step 2: Calculating ranking scores...'));
  const rankings = await calculateRankings(nifty50);

  const top15 = rankings.slice(0, 15);

  // Current prices
  console.log(chalk.bold('\nFetching current prices...'));
  const instruments = top15.map(r => `NSE:${r.symbol}`);
  const quotes = await getKite().getQuote(instruments);

  const perStock = totalAmount / 15;
  const today = dayjs().format('YYYY-MM-DD');

  const table = new Table({
    head: ['Rank', 'Symbol', 'Score', 'Price', 'Allocation', 'Qty', 'Actual Spend'],
    style: { head: ['cyan'] },
    colAligns: ['right', 'left', 'right', 'right', 'right', 'right', 'right'],
  });

  const orders = [];
  let totalActual = 0;

  for (const r of top15) {
    const price = quotes[`NSE:${r.symbol}`]?.last_price || 0;
    const qty = price > 0 ? Math.floor(perStock / price) : 0;
    const actual = qty * price;
    totalActual += actual;

    table.push([
      r.rank,
      r.symbol,
      pct(r.score),
      inr(price),
      inr(perStock),
      qty > 0 ? qty : chalk.red('0 — price exceeds allocation'),
      inr(actual),
    ]);

    if (qty > 0) orders.push({ symbol: r.symbol, qty, price, amount: actual });
  }

  console.log('\n' + chalk.bold('─── INITIAL BUY PLAN ────────────────────────────────'));
  console.log(table.toString());

  const skipped = top15.length - orders.length;
  console.log(`Total capital  : ${inr(totalAmount)}`);
  console.log(`Actual spend   : ${chalk.cyan(inr(totalActual))} (after floor rounding)`);
  console.log(`Undeployed     : ${chalk.gray(inr(totalAmount - totalActual))}`);
  if (skipped > 0) {
    console.log(chalk.yellow(`\n${skipped} stock(s) skipped — price exceeds per-stock allocation of ${inr(perStock)}`));
  }

  if (!execute) {
    console.log(chalk.yellow('\nPreview only — no orders placed.'));
    console.log(`To execute: node src/index.js portfolio init --amount ${totalAmount} --execute`);
    return;
  }

  // Confirmation before real orders
  console.log(chalk.bold.red('\n⚠  This will place REAL orders on your Zerodha account.'));
  const ans = await confirm(`Place ${orders.length} BUY order(s) totalling ${inr(totalActual)}? (yes/no): `);
  if (ans !== 'yes') { console.log('Aborted.'); return; }

  console.log('');
  for (const o of orders) {
    process.stdout.write(`  Buying ${o.qty.toString().padStart(5)} × ${o.symbol.padEnd(15)}`);

    let orderId = null;
    try {
      const res = await getKite().placeOrder('regular', {
        tradingsymbol: o.symbol,
        exchange: 'NSE',
        transaction_type: 'BUY',
        order_type: 'MARKET',
        quantity: o.qty,
        product: 'CNC',
      });
      orderId = res.order_id;
      process.stdout.write(chalk.green(` ✓ order ${orderId}\n`));
    } catch (err) {
      process.stdout.write(chalk.red(` ✗ FAILED: ${err.message}\n`));
      continue;
    }

    // Record transaction
    await pool.execute(
      'INSERT INTO transactions (symbol, trade_date, type, quantity, price, amount, order_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [o.symbol, today, 'BUY', o.qty, o.price, o.amount, orderId]
    );

    // Upsert holding (handles the rare case of a duplicate)
    const [existing] = await pool.execute(
      'SELECT quantity, average_price FROM holdings WHERE symbol = ?',
      [o.symbol]
    );
    if (existing.length) {
      const h = existing[0];
      const newQty = h.quantity + o.qty;
      const newAvg = (h.quantity * h.average_price + o.amount) / newQty;
      await pool.execute(
        'UPDATE holdings SET quantity = ?, average_price = ?, updated_at = NOW() WHERE symbol = ?',
        [newQty, newAvg, o.symbol]
      );
    } else {
      await pool.execute(
        'INSERT INTO holdings (symbol, quantity, average_price, first_buy_date) VALUES (?, ?, ?, ?)',
        [o.symbol, o.qty, o.price, today]
      );
    }
  }

  console.log(chalk.green('\nInitialisation complete.'));
  console.log(`Run ${chalk.cyan('node src/index.js portfolio status')} to verify.\n`);
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

module.exports = { initPortfolio, showStatus, showRankings, showTransactions, syncFromZerodha, addHolding, setDate, showSnapshots };
