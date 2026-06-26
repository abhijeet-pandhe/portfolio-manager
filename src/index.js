require('dotenv').config();
const { program } = require('commander');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function handleError(err) {
  console.error('\nError:', err.message || err);
  if (process.env.DEBUG === '1') console.error(err.stack);
  process.exit(1);
}

async function requireAuth(fn) {
  const { loadAccessToken } = require('./commands/auth');
  const ok = await loadAccessToken();
  if (!ok) {
    console.error('Not authenticated. Run: node src/index.js auth login');
    process.exit(1);
  }
  return fn();
}

// ─── auth ─────────────────────────────────────────────────────────────────────

const authCmd = program
  .command('auth')
  .description('Zerodha authentication');

authCmd
  .command('login')
  .description('Print login URL to start authentication')
  .action(() => {
    const { login } = require('./commands/auth');
    login().catch(handleError);
  });

authCmd
  .command('callback <request_token>')
  .description('Complete auth by exchanging request_token for access_token')
  .action((token) => {
    const { callback } = require('./commands/auth');
    callback(token).catch(handleError);
  });

authCmd
  .command('status')
  .description('Check whether the stored token is valid')
  .action(() => {
    const { status } = require('./commands/auth');
    status().catch(handleError);
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
  .action(function () {
    const { initPortfolio } = require('./commands/portfolio');
    const amount = parseFloat(this.opts().amount);
    if (isNaN(amount) || amount <= 0) {
      console.error('--amount must be a positive number');
      process.exit(1);
    }
    requireAuth(() => initPortfolio(amount, !!this.opts().execute)).catch(handleError);
  });

portfolioCmd
  .command('status')
  .description('Current holdings with P&L and allocation scores')
  .action(() => {
    const { showStatus } = require('./commands/portfolio');
    requireAuth(showStatus).catch(handleError);
  });

portfolioCmd
  .command('rankings')
  .description('Full Nifty 50 ranking table')
  .action(() => {
    const { showRankings } = require('./commands/portfolio');
    requireAuth(showRankings).catch(handleError);
  });

portfolioCmd
  .command('transactions [symbol]')
  .description('Transaction history (optionally filter by symbol)')
  .action((symbol) => {
    const { showTransactions } = require('./commands/portfolio');
    requireAuth(() => showTransactions(symbol)).catch(handleError);
  });

portfolioCmd
  .command('sync')
  .description('Import holdings from your Zerodha account')
  .action(() => {
    const { syncFromZerodha } = require('./commands/portfolio');
    requireAuth(syncFromZerodha).catch(handleError);
  });

portfolioCmd
  .command('add <symbol> <quantity> <avg_price> <date>')
  .description('Manually add a holding (date: YYYY-MM-DD)')
  .action((symbol, quantity, avgPrice, date) => {
    const { addHolding } = require('./commands/portfolio');
    requireAuth(() => addHolding(symbol, quantity, avgPrice, date)).catch(handleError);
  });

portfolioCmd
  .command('set-date <symbol> <date>')
  .description('Update first_buy_date for a holding (date: YYYY-MM-DD)')
  .action((symbol, date) => {
    const { setDate } = require('./commands/portfolio');
    requireAuth(() => setDate(symbol, date)).catch(handleError);
  });

portfolioCmd
  .command('snapshots')
  .description('View past rebalance snapshots')
  .action(() => {
    const { showSnapshots } = require('./commands/portfolio');
    requireAuth(showSnapshots).catch(handleError);
  });

portfolioCmd
  .command('details')
  .description('Portfolio summary, holdings table, and key insights')
  .action(() => {
    const { showDetails } = require('./commands/portfolio');
    requireAuth(showDetails).catch(handleError);
  });

// ─── rebalance ────────────────────────────────────────────────────────────────

const rebalanceCmd = program
  .command('rebalance')
  .description('Monthly rebalance operations');

rebalanceCmd
  .command('preview')
  .description('Show what the rebalance would do — no orders placed')
  .requiredOption('-a, --amount <number>', 'Monthly investment amount in INR')
  .action(function () {
    const { runRebalance } = require('./services/rebalance');
    const amount = parseFloat(this.opts().amount);
    if (isNaN(amount) || amount <= 0) {
      console.error('--amount must be a positive number');
      process.exit(1);
    }
    requireAuth(() => runRebalance(amount, true)).catch(handleError);
  });

rebalanceCmd
  .command('run')
  .description('Execute monthly rebalance and place real orders on Zerodha')
  .requiredOption('-a, --amount <number>', 'Monthly investment amount in INR')
  .action(function () {
    const { runRebalance } = require('./services/rebalance');
    const amount = parseFloat(this.opts().amount);
    if (isNaN(amount) || amount <= 0) {
      console.error('--amount must be a positive number');
      process.exit(1);
    }
    requireAuth(() => runRebalance(amount, false)).catch(handleError);
  });

// ─── setup ────────────────────────────────────────────────────────────────────

const setupCmd = program
  .command('setup')
  .description('One-time setup utilities');

setupCmd
  .command('db')
  .description('Create database tables (run once after creating the MySQL database)')
  .action(() => {
    const { setupDatabase } = require('./commands/setup');
    setupDatabase().catch(handleError);
  });

// ─── Run ─────────────────────────────────────────────────────────────────────

program
  .name('portfolio-manager')
  .description('Nifty 50 Capital Efficiency Portfolio Manager')
  .version('1.0.0');

program.parseAsync(process.argv).catch(handleError);
