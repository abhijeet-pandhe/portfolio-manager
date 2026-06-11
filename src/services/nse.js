const axios = require('axios');

// NSE archives CSV is stable and requires no session or special headers.
// Format: Company Name,Industry,Symbol,Series,ISIN Code
const CSV_URL = 'https://archives.nseindia.com/content/indices/ind_nifty50list.csv';

async function getNifty50Symbols() {
  const res = await axios.get(CSV_URL, { timeout: 15000 });

  const lines = res.data.trim().split('\n');
  // Skip header row, symbol is column index 2
  const symbols = lines
    .slice(1)
    .map(line => line.split(',')[2]?.trim())
    .filter(s => s && s.length > 0);

  if (symbols.length < 40) {
    throw new Error(`Only parsed ${symbols.length} symbols from CSV — unexpected format`);
  }

  return symbols;
}

module.exports = { getNifty50Symbols };
