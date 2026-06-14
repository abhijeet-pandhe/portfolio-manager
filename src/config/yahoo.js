const YahooFinance = require('yahoo-finance2').default;

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

// NSE symbols on Yahoo Finance use the .NS suffix
function toYFSymbol(nseSymbol) {
  return `${nseSymbol}.NS`;
}

module.exports = { yf, toYFSymbol };
