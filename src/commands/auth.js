const { getKite } = require('../config/kite');
const { pool } = require('../config/database');
const { prompt } = require('../helpers');

async function login() {
  const url = getKite().getLoginURL();
  console.log('\nOpen this URL in your browser to authenticate with Zerodha:');
  console.log(url);
  const requestToken = await prompt('\nPaste the "request_token" value from that URL: ');
  if (!requestToken) throw new Error('request_token is required');

  await callback(requestToken);
}

async function callback(requestToken) {
  const secret = process.env.KITE_API_SECRET;
  if (!secret) throw new Error('KITE_API_SECRET not set in .env');

  const kite = getKite();
  const session = await kite.generateSession(requestToken, secret);
  kite.setAccessToken(session.access_token);

  await pool.execute(
    'INSERT INTO config (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?, updated_at = NOW()',
    ['access_token', session.access_token, session.access_token]
  );

  console.log('\nAuthentication successful!');
  console.log(`  User   : ${session.user_name} (${session.user_id})`);
  console.log(`  Email  : ${session.email}`);
  console.log('  Token stored in database.\n');
}

async function loadAccessToken() {
  try {
    const [rows] = await pool.execute(
      'SELECT `value` FROM config WHERE `key` = ?',
      ['access_token']
    );
    if (rows.length && rows[0].value) {
      getKite().setAccessToken(rows[0].value);
      return true;
    }
  } catch {
    // DB not set up yet or connection failed
  }
  return false;
}

async function status() {
  const loaded = await loadAccessToken();
  if (!loaded) {
    console.log('Not authenticated. Run: node src/index.js auth login');
    return;
  }

  try {
    const profile = await getKite().getProfile();
    console.log('\nAuthenticated:');
    console.log(`  User  : ${profile.user_name} (${profile.user_id})`);
    console.log(`  Email : ${profile.email}`);
    console.log(`  Broker: ${profile.broker}`);
  } catch (err) {
    if (err.message && err.message.includes('token')) {
      console.log('Token expired. Re-authenticate: node src/index.js auth login');
    } else {
      throw err;
    }
  }
}

module.exports = { login, callback, loadAccessToken, status };
