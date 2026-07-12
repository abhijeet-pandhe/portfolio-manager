const { KiteConnect } = require('kiteconnect');

let kite;

function getKite() {
  if (!kite) {
    if (!process.env.KITE_API_KEY) {
      throw new Error('KITE_API_KEY not set in .env');
    }
    kite = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  }
  return kite;
}

async function assertValidSession() {
  try {
    await getKite().getProfile();
  } catch (err) {
    throw new Error(
      `Zerodha session check failed (${err.message})\nRe-authenticate: node src/index.js auth login`
    );
  }
}

module.exports = { getKite, assertValidSession };
