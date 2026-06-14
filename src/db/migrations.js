const { getPool } = require('../config/database');
const { POOL_KEY } = require('../helpers');

const TABLES = [
  `CREATE TABLE IF NOT EXISTS config (
    \`key\` VARCHAR(100) NOT NULL PRIMARY KEY,
    \`value\` TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS holdings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL UNIQUE,
    quantity INT NOT NULL DEFAULT 0,
    average_price DECIMAL(10,2) NOT NULL,
    first_buy_date DATE NOT NULL,
    cash_pool DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    trade_date DATE NOT NULL,
    type ENUM('BUY','SELL') NOT NULL,
    quantity INT NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    order_id VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_symbol (symbol),
    INDEX idx_trade_date (trade_date)
  )`,

  `CREATE TABLE IF NOT EXISTS monthly_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rebalance_date DATE NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    rank_position INT,
    ranking_score DECIMAL(10,4),
    allocation_score DECIMAL(10,4),
    action VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_rebalance_date (rebalance_date),
    INDEX idx_symbol (symbol)
  )`,
];

async function migrate() {
  const pool = getPool();
  for (const sql of TABLES) {
    await pool.execute(sql);
  }
  await pool.execute(
    'INSERT IGNORE INTO config (`key`, `value`) VALUES (?, ?)',
    [POOL_KEY, '0.00']
  );
  console.log('Database migrations complete.');
}

module.exports = { migrate };
