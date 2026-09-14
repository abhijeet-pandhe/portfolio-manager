const dayjs = require('dayjs');
const chalk = require('chalk');
const { yf: yahooFinance, toYFSymbol } = require('../config/yahoo');

const { pool } = require('../config/database');
const { sleep, withRetry, cleanYahooError } = require('../helpers');

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * For each held symbol, fetches splits from Yahoo Finance and adjusts
 * quantity and average_price in the holdings table.
 *
 * The check window is tracked per symbol via holdings.last_split_check,
 * so one symbol's Yahoo Finance failure doesn't block the checkpoint from
 * advancing for the others.
 *
 * No last_split_check yet (new holding): checks from the stock's
 * first_buy_date so any historical splits since purchase are caught.
 *
 * Subsequent runs: checks only from last_split_check so nothing is applied
 * twice.
 *
 * Note: Yahoo Finance reports Indian bonus issues as splits (same mechanics),
 * so both are handled automatically.
 */
async function checkAndApplySplits(heldSymbols) {
  console.log(chalk.bold('Checking for splits / bonus issues...'));

  let adjustedCount = 0;

  for (const symbol of heldSymbols) {
    const [[h]] = await pool.execute(
      'SELECT quantity, average_price, first_buy_date, last_split_check FROM holdings WHERE symbol = ?',
      [symbol]
    );
    if (!h) continue;

    // No checkpoint yet, go back to first_buy_date.
    // Otherwise use last_split_check (but never before first_buy_date).
    const firstBuy = dayjs(h.first_buy_date);
    const since = !h.last_split_check
      ? firstBuy
      : dayjs(h.last_split_check).isBefore(firstBuy) ? firstBuy : dayjs(h.last_split_check);
    const today = dayjs().format('YYYY-MM-DD');

    try {
      const result = await withRetry(() => yahooFinance.chart(toYFSymbol(symbol), {
        period1: since.toDate(),
        period2: new Date(),
        interval: '1wk',
        events: 'splits',
      }));

      const splits = result.events?.splits;
      if (!splits || Object.keys(splits).length === 0) {
        await pool.execute('UPDATE holdings SET last_split_check = ? WHERE symbol = ?', [today, symbol]);
        await sleep(120);
        continue;
      }

      // Sort chronologically and accumulate the combined ratio
      const entries = Object.entries(splits).sort(([a], [b]) => a.localeCompare(b));
      let ratio = 1;
      for (const [, split] of entries) {
        ratio *= split.numerator / split.denominator;
        const date = dayjs(split.date).format('DD-MMM-YYYY');
        console.log(chalk.yellow(
          `  SPLIT  ${symbol.padEnd(15)} ${split.splitRatio.padEnd(6)}  on ${date}`
        ));
      }

      const newQty = Math.round(h.quantity * ratio);
      const newAvg = parseFloat((h.average_price / ratio).toFixed(4));

      await pool.execute(
        'UPDATE holdings SET quantity = ?, average_price = ?, last_split_check = ?, updated_at = NOW() WHERE symbol = ?',
        [newQty, newAvg, today, symbol]
      );

      console.log(chalk.green(
        `         ${symbol.padEnd(15)} qty ${h.quantity} → ${newQty}` +
        `   avg ₹${parseFloat(h.average_price).toFixed(2)} → ₹${newAvg.toFixed(2)}`
      ));
      adjustedCount++;
    } catch (err) {
      // last_split_check is left untouched for this symbol — its missed
      // window will be retried in full next run instead of being skipped.
      console.log(chalk.yellow(`  Warning: ${symbol} — ${cleanYahooError(err)} — will re-check next run`));
    }

    await sleep(120);
  }

  if (adjustedCount === 0) console.log('  No splits detected.');
  console.log('');

  return adjustedCount;
}

module.exports = { checkAndApplySplits };
