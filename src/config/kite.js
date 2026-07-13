const axios = require('axios');
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

async function assertSufficientFunds(requiredAmount) {
  const equity = await getKite().getMargins('equity');
  const availableFunds = equity.net;
  if (availableFunds < requiredAmount) {
    throw new Error(
      `Insufficient funds in Kite account: available ₹${availableFunds}, required ₹${requiredAmount}`
    );
  }
}

async function assertAllowedIp() {
  const allowed = (process.env.KITE_ALLOWED_IPS || '').split(',');
  let publicIp;
  try {
    const response = await axios.get('https://ifconfig.me/ip', { timeout: 5000 });
    publicIp = String(response.data).trim();
  } catch (err) {
    throw new Error(`Could not determine public egress IP (${err.message}) — refusing to place orders.`);
  }
  if (!allowed.includes(publicIp)) {
    throw new Error(`Current public IP ${publicIp} is not whitelisted for Kite trading (allowed: ${allowed.join(', ')}).`);
  }
}

module.exports = { getKite, assertValidSession, assertSufficientFunds, assertAllowedIp };
