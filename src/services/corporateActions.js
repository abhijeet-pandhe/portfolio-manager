const dayjs = require('dayjs');
const chalk = require('chalk');
const { yf: yahooFinance, toYFSymbol } = require('../config/yahoo');

const { getPool } = require('../config/database');
const { sleep } = require('../helpers');

// ─── Config helpers ───────────────────────────────────────────────────────────

async function getSplitsLastChecked() {
  const pool = getPool();
  const [rows] = await pool.execute(
    "SELECT `value` FROM config WHERE `key` = 'splits_last_checked'"
  );
  return rows.length ? dayjs(rows[0].value) : null;
}

async function setSplitsLastChecked() {
  const pool = getPool();
  const today = dayjs().format('YYYY-MM-DD');
  await pool.execute(
    "INSERT INTO config (`key`, `value`) VALUES ('splits_last_checked', ?)" +
    " ON DUPLICATE KEY UPDATE `value` = ?, updated_at = NOW()",
    [today, today]
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * For each held symbol, fetches splits from Yahoo Finance and adjusts
 * quantity and average_price in the holdings table.
 *
 * First run (no splits_last_checked in config): checks from each stock's
 * first_buy_date so any historical splits since purchase are caught.
 *
 * Subsequent runs: checks only from the last checked date so nothing is
 * applied twice.
 *
 * Note: Yahoo Finance reports Indian bonus issues as splits (same mechanics),
 * so both are handled automatically.
 */
async function checkAndApplySplits(heldSymbols) {
  const pool = getPool();
  const lastChecked = await getSplitsLastChecked();

  console.log(chalk.bold('Checking for splits / bonus issues...'));
  if (lastChecked) {
    console.log(`  Period : ${lastChecked.format('DD-MMM-YYYY')} → today`);
  } else {
    console.log('  First run — checking from each stock\'s first buy date.');
  }

  let adjustedCount = 0;

  for (const symbol of heldSymbols) {
    const [[h]] = await pool.execute(
      'SELECT quantity, average_price, first_buy_date FROM holdings WHERE symbol = ?',
      [symbol]
    );
    if (!h) continue;

    // On first run, go back to first_buy_date.
    // On subsequent runs, use lastChecked (but never before first_buy_date).
    const firstBuy = dayjs(h.first_buy_date);
    const since = !lastChecked
      ? firstBuy
      : lastChecked.isBefore(firstBuy) ? firstBuy : lastChecked;

    try {
      const result = await yahooFinance.chart(toYFSymbol(symbol), {
        period1: since.toDate(),
        period2: new Date(),
        interval: '1wk',
        events: 'splits',
      });

      const splits = result.events?.splits;
      if (!splits || Object.keys(splits).length === 0) {
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
        'UPDATE holdings SET quantity = ?, average_price = ?, updated_at = NOW() WHERE symbol = ?',
        [newQty, newAvg, symbol]
      );

      console.log(chalk.green(
        `         ${symbol.padEnd(15)} qty ${h.quantity} → ${newQty}` +
        `   avg ₹${parseFloat(h.average_price).toFixed(2)} → ₹${newAvg.toFixed(2)}`
      ));
      adjustedCount++;
    } catch (err) {
      console.log(chalk.gray(`  Warning: ${symbol} — ${err.message}`));
    }

    await sleep(120);
  }

  if (adjustedCount === 0) console.log('  No splits detected.');
  console.log('');

  // Always update the checked date so next run only looks at the new window
  await setSplitsLastChecked();

  return adjustedCount;
}

module.exports = { checkAndApplySplits };
