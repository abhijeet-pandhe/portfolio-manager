const readline = require('readline');
const chalk = require('chalk');

// Shared config key for portfolio cash pool
const POOL_KEY = 'portfolio_pool_balance';

// Rate-limiting delay
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Build a MySQL IN-clause placeholder string: sqlIn(['A','B']) → '?,?'
function sqlIn(arr) {
  return arr.map(() => '?').join(',');
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(question, ans => { rl.close(); r(ans.trim().toLowerCase()); }));
}

// Whole-rupee formatting for large allocation amounts
function inr(n) {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

// Two-decimal formatting for unit prices
function inrd(n) {
  return `₹${Number(n).toFixed(2)}`;
}

function pct(n) {
  const s = (n * 100).toFixed(2) + '%';
  return n >= 0 ? chalk.green(s) : chalk.red(s);
}

// Retries a flaky call (e.g. Yahoo Finance) a few times with backoff before giving up.
async function withRetry(fn, { retries = 2, delayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

// Yahoo occasionally returns an HTML error page (e.g. a 502) instead of JSON.
// Collapse it into a short, readable reason instead of dumping the whole page.
function cleanYahooError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  if (/<!DOCTYPE html>|<html/i.test(msg)) {
    const statusMatch = msg.match(/status code\s*:\s*(\d+)/i);
    return statusMatch ? `Yahoo Finance unavailable (HTTP ${statusMatch[1]})` : 'Yahoo Finance unavailable (bad response)';
  }
  return msg;
}

module.exports = { POOL_KEY, sleep, sqlIn, confirm, inr, inrd, pct, withRetry, cleanYahooError };
