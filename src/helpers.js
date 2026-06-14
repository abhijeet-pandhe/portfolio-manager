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

module.exports = { POOL_KEY, sleep, sqlIn, confirm, inr, inrd, pct };
