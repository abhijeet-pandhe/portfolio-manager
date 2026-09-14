const dayjs = require('dayjs');
const chalk = require('chalk');
const Table = require('cli-table3');

const { yf: yahooFinance, toYFSymbol } = require('../config/yahoo');

const { pool } = require('../config/database');
const { getKite, marketValidation } = require('../config/kite');
const { getNifty50Symbols } = require('./nse');
const { calculateRankings } = require('./ranking');
const { calculateWeights } = require('./allocation');
const { checkAndApplySplits } = require('./corporateActions');
const { sleep, sqlIn, confirm, inr, inrd, pct, withRetry, cleanYahooError } = require('../helpers');

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function getHeldSymbols() {
  const [rows] = await pool.execute('SELECT symbol FROM holdings WHERE quantity > 0');
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

// Poll each order until it reaches a terminal state or this deadline passes.
const ORDER_POLL_INTERVAL_MS = 5000;
const ORDER_POLL_MAX_WAIT_MS = 60 * 1000;

async function placeOrder(transactionType, symbol, qty, price) {
  const label = transactionType === 'BUY' ? 'BUY  ' : 'SELL ';
  process.stdout.write(`  ${label} ${qty} × ${symbol.padEnd(12)} @ ${inrd(price)}...`);

  try {
    const res = await getKite().placeOrder('regular', {
      tradingsymbol: symbol, exchange: 'NSE',
      transaction_type: transactionType, order_type: 'MARKET',
      quantity: qty, product: 'CNC', market_protection: 0.5,
      tag: 'MY_STRATEGY'
    });
    process.stdout.write(chalk.green(` ✓ order ${res.order_id}\n`));
    return { type: transactionType, symbol, qty, price, orderId: res.order_id };
  } catch (err) {
    process.stdout.write(chalk.red(` ✗ FAILED: ${err.message}\n`));
    return null;
  }
}

async function placeBuyOrder(symbol, qty, price) {
  return placeOrder('BUY', symbol, qty, price);
}

async function placeSellOrder(symbol, qty, price) {
  return placeOrder('SELL', symbol, qty, price);
}

async function getFinalOrderStatus(orderId) {
  const history = await getKite().getOrderHistory(orderId);
  return history && history.length ? history[history.length - 1] : null;
}

async function waitForOrderCompletion(orderId) {
  const deadline = Date.now() + ORDER_POLL_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const final = await getFinalOrderStatus(orderId);
    if (final) {
      const { status } = final;
      if (status === 'COMPLETE' || status === 'CANCELLED' || status === 'REJECTED') return final;
    }
    await sleep(ORDER_POLL_INTERVAL_MS);
  }
  return getFinalOrderStatus(orderId);
}

async function upsertCashPool(symbol, amount, today) {
  const cashPool = amount.toFixed(2);
  await pool.execute(
    `INSERT INTO holdings (symbol, quantity, average_price, first_buy_date, cash_pool)
     VALUES (?, 0, 0, ?, ?)
     ON DUPLICATE KEY UPDATE cash_pool=?, updated_at=NOW()`,
    [symbol, today, cashPool, cashPool]
  );
}

/**
 * Polls previously-placed orders until they settle, then records each COMPLETE fill.
 * Returns one result per placed order ({ recorded, amount, fillQty, ... }).
 */
async function finalizeOrders(orders) {
  const placed = orders.filter(Boolean);
  if (!placed.length) return [];

  console.log(chalk.bold(`\nConfirming ${placed.length} order(s) (up to ${ORDER_POLL_MAX_WAIT_MS / 1000}s each)...`));
  const today = dayjs().format('YYYY-MM-DD');
  const results = [];

  for (const o of placed) {
    let final = null;
    try {
      final = await waitForOrderCompletion(o.orderId);
    } catch (err) {
      process.stdout.write(chalk.yellow(`  ⚠ ${o.symbol} order ${o.orderId} — could not confirm status (${err.message})\n`));
      results.push({ order: o, recorded: false, amount: 0, fillQty: 0 });
      continue;
    }

    const status = final ? final.status : null;

    if (status === 'CANCELLED' || status === 'REJECTED') {
      process.stdout.write(chalk.red(`  ✗ ${o.symbol} ${o.type} order ${o.orderId} ${status.toLowerCase()} — no transaction recorded\n`));
      if (o.type === 'BUY' && o.totalPool !== undefined) {
        await upsertCashPool(o.symbol, o.totalPool, today);
        process.stdout.write(`    → ${inr(o.totalPool)} returned to ${o.symbol} cash pool\n`);
      }
      results.push({ order: o, recorded: false, amount: 0, fillQty: 0 });
      continue;
    }

    if (status !== 'COMPLETE') {
      process.stdout.write(chalk.yellow(`  ⚠ ${o.symbol} order ${o.orderId} status ${status || 'UNKNOWN'} — not recorded\n`));
      results.push({ order: o, recorded: false, amount: 0, fillQty: 0 });
      continue;
    }

    const fillQty = Number(final.filled_quantity) || 0;
    if (fillQty <= 0) {
      process.stdout.write(chalk.yellow(`  ⚠ ${o.symbol} order ${o.orderId} COMPLETE but 0 filled — not recorded\n`));
      results.push({ order: o, recorded: false, amount: 0, fillQty: 0 });
      continue;
    }

    const fillPrice = Number(final.average_price) || o.price;
    const amount = fillQty * fillPrice;
    process.stdout.write(`  ✓ ${o.symbol} ${o.type} filled ${fillQty} @ ${inrd(fillPrice)}\n`);

    await pool.execute(
      'INSERT INTO transactions (symbol,trade_date,type,quantity,price,amount,order_id) VALUES (?,?,?,?,?,?,?)',
      [o.symbol, today, o.type, fillQty, fillPrice, amount, o.orderId]
    );

    if (o.type === 'SELL') {
      const [[existing]] = await pool.execute('SELECT quantity FROM holdings WHERE symbol=?', [o.symbol]);
      if (existing && fillQty >= existing.quantity) {
        await pool.execute('DELETE FROM holdings WHERE symbol=?', [o.symbol]);
      } else if (existing) {
        await pool.execute(
          'UPDATE holdings SET quantity=quantity-?, updated_at=NOW() WHERE symbol=?',
          [fillQty, o.symbol]
        );
      }
      results.push({ order: o, recorded: true, amount, fillQty, fillPrice });
      continue;
    }

    const cashPool = o.totalPool !== undefined ? (o.totalPool - amount).toFixed(2) : null;
    const [[existing]] = await pool.execute(
      'SELECT quantity, average_price FROM holdings WHERE symbol=?', [o.symbol]
    );
    if (existing) {
      const newQty = existing.quantity + fillQty;
      const newAvg = (existing.quantity * existing.average_price + amount) / newQty;
      if (cashPool !== null) {
        await pool.execute(
          'UPDATE holdings SET quantity=?, average_price=?, cash_pool=?, updated_at=NOW() WHERE symbol=?',
          [newQty, newAvg, cashPool, o.symbol]
        );
      } else {
        await pool.execute(
          'UPDATE holdings SET quantity=?, average_price=?, updated_at=NOW() WHERE symbol=?',
          [newQty, newAvg, o.symbol]
        );
      }
    } else {
      await pool.execute(
        'INSERT INTO holdings (symbol,quantity,average_price,first_buy_date,cash_pool) VALUES (?,?,?,?,?)',
        [o.symbol, fillQty, fillPrice, today, cashPool !== null ? cashPool : 0]
      );
    }
    results.push({ order: o, recorded: true, amount, fillQty, fillPrice });
  }

  return results;
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

  const sorted = [...buyPlan].sort((a, b) => b.weight - a.weight);
  for (const b of sorted) {
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

async function saveSnapshot(rankings, toSell, toBuy, weights) {
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

async function buildBuyPlan(finalHoldings, existingHoldings, toBuy, prices, poolToDistribute) {
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
  const buyPlan = await buildBuyPlan(finalHoldings, heldAfterSell, toBuy, prices, workingPool);

  printAllocationTable(buyPlan, workingPool, firstShareCosts);

  if (dryRun) {
    console.log(chalk.yellow('\nDry run complete. No orders placed.'));
    console.log(`Execute: node src/index.js rebalance run --amount ${sip}`);
    return;
  }

  // ── Confirm ──
  console.log(chalk.bold.red('\n⚠  This will place REAL orders on your Zerodha account.'));
  if (await confirm('Type "yes" to proceed: ') !== 'yes') { console.log('Aborted.'); return; }

  // ── Verify the if we can place orders ──
  await marketValidation(sip);

  // ── Place and confirm sell orders before any buys ──
  const sellOrders = [];
  const sellCashPoolMap = Object.fromEntries(sellData.map(d => [d.symbol, d.cashPool]));
  console.log(chalk.bold('\nPlacing sell orders...'));
  for (const d of sellData) {
    const order = await placeSellOrder(d.symbol, d.qty, prices[d.symbol] || 0);
    if (order) sellOrders.push(order);
  }

  const sellResults = await finalizeOrders(sellOrders);
  let actualProceeds = 0;
  let actualRecovered = 0;
  for (const r of sellResults) {
    if (!r.recorded) continue;
    actualProceeds += r.amount;
    actualRecovered += sellCashPoolMap[r.order.symbol] || 0;
  }

  // ── Update portfolio pool from confirmed sells ──
  let remaining = actualProceeds + actualRecovered + sip;
  console.log(chalk.cyan(`\n  Pool after confirmed sells: ${inr(remaining)}`));

  // ── Place first share buy orders ──
  const buyOrders = [];
  console.log(chalk.bold('\nPlacing first-share buy orders for new entries...'));
  for (const sym of toBuy) {
    const price = firstShareCosts[sym] || 0;
    if (!price || remaining < price) {
      console.log(chalk.red(`  SKIP ${sym} — pool (${inr(remaining)}) < price (${inr(price)})`));
      continue;
    }
    const order = await placeBuyOrder(sym, 1, price);
    if (order) { buyOrders.push(order); remaining -= price; }
  }

  // ── Distribute pool to stock pools and place buy orders ──
  // Reuse weights from the preview buyPlan — same proportions, applied to actual pool.
  console.log(chalk.bold('\nDistributing pool and placing buy orders...'));

  const today = dayjs().format('YYYY-MM-DD');

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

    if (qty > 0) {
      const order = await placeBuyOrder(b.symbol, qty, price);
      if (order) {
        buyOrders.push({ ...order, totalPool });
        continue;
      }
    }

    // No order placed (nothing to buy, or placement failed) — the full
    // reserved amount stays parked in this stock's pool untouched.
    await upsertCashPool(b.symbol, totalPool, today);
  }

  // ── Confirm buy fills and record transactions/holdings ──
  await finalizeOrders(buyOrders);

  await saveSnapshot(rankings, toSell, toBuy, buyPlan);
  console.log(chalk.green('\nRebalance complete. Stock pools updated.'));
}

module.exports = { runRebalance, getCurrentPrices, placeBuyOrder, placeSellOrder, finalizeOrders };
