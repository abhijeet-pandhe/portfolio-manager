require('dotenv').config();
const { program } = require('commander');
const chalk = require('chalk');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function handleError(err) {
  console.error(chalk.red(`\nError: ${err.message || err}`));
  if (process.env.DEBUG === '1') console.error(err.stack);
  process.exit(1);
}

async function requireAuth() {
  const { loadAccessToken } = require('./commands/auth');
  const ok = await loadAccessToken();
  if (!ok) {
    console.error('Not authenticated. Run: node src/index.js auth login');
    process.exit(1);
  }
}

function parseAmount(raw) {
  const amount = parseFloat(raw);
  if (isNaN(amount) || amount <= 0) {
    console.error('--amount must be a positive number');
    process.exit(1);
  }
  return amount;
}

// ─── auth ─────────────────────────────────────────────────────────────────────

const authCmd = program
  .command('auth')
  .description('Zerodha authentication');

authCmd
  .command('login')
  .description('Print login URL to start authentication')
  .action(async () => {
    try {
      const { login } = require('./commands/auth');
      await login();
    } catch (err) {
      handleError(err);
    }
  });

authCmd
  .command('callback <request_token>')
  .description('Complete auth by exchanging request_token for access_token')
  .action(async (token) => {
    try {
      const { callback } = require('./commands/auth');
      await callback(token);
    } catch (err) {
      handleError(err);
    }
  });

authCmd
  .command('status')
  .description('Check whether the stored token is valid')
  .action(async () => {
    try {
      const { status } = require('./commands/auth');
      await status();
    } catch (err) {
      handleError(err);
    }
  });

// ─── portfolio ────────────────────────────────────────────────────────────────

const portfolioCmd = program
  .command('portfolio')
  .description('View and manage portfolio');

portfolioCmd
  .command('init')
  .description('First-time setup: rank Nifty 50, buy 1 share each of top 15, save remainder to pool')
  .requiredOption('-a, --amount <number>', 'Total initial capital in INR')
  .option('--execute', 'Place real orders (default is preview/dry-run)')
  .action(async (options) => {
    try {
      const { initPortfolio } = require('./commands/portfolio');
      const amount = parseAmount(options.amount);
      await requireAuth();
      await initPortfolio(amount, !!options.execute);
    } catch (err) {
      handleError(err);
    }
  });

portfolioCmd
  .command('status')
  .description('Current holdings with P&L and allocation scores')
  .action(async () => {
    try {
      const { showStatus } = require('./commands/portfolio');
      await requireAuth();
      await showStatus();
    } catch (err) {
      handleError(err);
    }
  });

portfolioCmd
  .command('rankings')
  .description('Full Nifty 50 ranking table')
  .action(async () => {
    try {
      const { showRankings } = require('./commands/portfolio');
      await requireAuth();
      await showRankings();
    } catch (err) {
      handleError(err);
    }
  });

portfolioCmd
  .command('transactions [symbol]')
  .description('Transaction history (optionally filter by symbol)')
  .action(async (symbol) => {
    try {
      const { showTransactions } = require('./commands/portfolio');
      await requireAuth();
      await showTransactions(symbol);
    } catch (err) {
      handleError(err);
    }
  });

portfolioCmd
  .command('sync')
  .description('Import holdings from your Zerodha account')
  .action(async () => {
    try {
      const { syncFromZerodha } = require('./commands/portfolio');
      await requireAuth();
      await syncFromZerodha();
    } catch (err) {
      handleError(err);
    }
  });

portfolioCmd
  .command('add <symbol> <quantity> <avg_price> <date>')
  .description('Manually add a holding (date: YYYY-MM-DD)')
  .action(async (symbol, quantity, avgPrice, date) => {
    try {
      const { addHolding } = require('./commands/portfolio');
      await requireAuth();
      await addHolding(symbol, quantity, avgPrice, date);
    } catch (err) {
      handleError(err);
    }
  });

portfolioCmd
  .command('set-date <symbol> <date>')
  .description('Update first_buy_date for a holding (date: YYYY-MM-DD)')
  .action(async (symbol, date) => {
    try {
      const { setDate } = require('./commands/portfolio');
      await requireAuth();
      await setDate(symbol, date);
    } catch (err) {
      handleError(err);
    }
  });

portfolioCmd
  .command('snapshots')
  .description('View past rebalance snapshots')
  .action(async () => {
    try {
      const { showSnapshots } = require('./commands/portfolio');
      await requireAuth();
      await showSnapshots();
    } catch (err) {
      handleError(err);
    }
  });

portfolioCmd
  .command('details')
  .description('Portfolio summary, holdings table, and key insights')
  .action(async () => {
    try {
      const { showDetails } = require('./commands/portfolio');
      await requireAuth();
      await showDetails();
    } catch (err) {
      handleError(err);
    }
  });

// ─── rebalance ────────────────────────────────────────────────────────────────

const rebalanceCmd = program
  .command('rebalance')
  .description('Monthly rebalance operations');

rebalanceCmd
  .command('preview')
  .description('Show what the rebalance would do — no orders placed')
  .requiredOption('-a, --amount <number>', 'Monthly investment amount in INR')
  .action(async (options) => {
    try {
      const { runRebalance } = require('./services/rebalance');
      const amount = parseAmount(options.amount);
      await requireAuth();
      await runRebalance(amount, true);
    } catch (err) {
      handleError(err);
    }
  });

rebalanceCmd
  .command('run')
  .description('Execute monthly rebalance and place real orders on Zerodha')
  .requiredOption('-a, --amount <number>', 'Monthly investment amount in INR')
  .action(async (options) => {
    try {
      const { runRebalance } = require('./services/rebalance');
      const amount = parseAmount(options.amount);
      await requireAuth();
      await runRebalance(amount, false);
    } catch (err) {
      handleError(err);
    }
  });

// ─── setup ────────────────────────────────────────────────────────────────────

const setupCmd = program
  .command('setup')
  .description('One-time setup utilities');

setupCmd
  .command('db')
  .description('Create database tables (run once after creating the MySQL database)')
  .action(async () => {
    try {
      const { setupDatabase } = require('./commands/setup');
      await setupDatabase();
    } catch (err) {
      handleError(err);
    }
  });

// ─── Run ─────────────────────────────────────────────────────────────────────

program
  .name('portfolio-manager')
  .description('Nifty 50 Capital Efficiency Portfolio Manager')
  .version('1.0.0');

program.parseAsync(process.argv).catch(handleError);
