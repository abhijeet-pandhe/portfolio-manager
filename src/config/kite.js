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

module.exports = { getKite };
