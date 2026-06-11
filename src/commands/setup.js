const { migrate } = require('../db/migrations');

async function setupDatabase() {
  console.log('Initialising database schema...');
  await migrate();
  console.log('\nAll tables ready. Next steps:');
  console.log('  1. node src/index.js auth login');
  console.log('  2. node src/index.js auth callback <request_token>');
  console.log('  3. node src/index.js portfolio sync');
}

module.exports = { setupDatabase };
