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
  const availableFunds = Math.round(equity.net);
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

async function assertMarketOpen() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const day = istNow.getUTCDay(); // 0=Sun, 6=Sat (istNow is already shifted to IST)
  const minutesSinceMidnight = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();

  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = minutesSinceMidnight >= 9 * 60 + 15 && minutesSinceMidnight <= 15 * 60 + 30;

  if (!isWeekday || !isMarketHours) {
    const hh = String(istNow.getUTCHours()).padStart(2, '0');
    const mm = String(istNow.getUTCMinutes()).padStart(2, '0');
    throw new Error(`Market is closed (IST time: ${hh}:${mm})`);
  }
}

async function marketValidation(amount) {
  // Verify the Kite session is actually live before touching real orders
  await assertValidSession();

  // Verify our egress IP is whitelisted before touching real orders
  await assertAllowedIp();

  // Verify the market is open before placing orders
  await assertMarketOpen();

  // ── Verify enough funds are available to execute the order ──
  await assertSufficientFunds(amount);
}

module.exports = { getKite, marketValidation };
