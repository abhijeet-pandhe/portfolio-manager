const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Calculates XIRR using Newton-Raphson iteration.
 * @param {Array<{amount: number, date: Date|string}>} cashflows
 *   Negative amount = cash out (buy), positive amount = cash in (sell / current value).
 * @returns {number} Annual rate of return, e.g. 0.15 for 15%. Returns 0 on failure.
 */
function xirr(cashflows, guess = 0.1) {
  if (!cashflows || cashflows.length < 2) return 0;

  const sorted = [...cashflows]
    .map(c => ({ v: c.amount, d: new Date(c.date).getTime() }))
    .sort((a, b) => a.d - b.d);

  const t0 = sorted[0].d;
  const cf = sorted.map(c => ({ v: c.v, t: (c.d - t0) / YEAR_MS }));

  const f = (r) =>
    cf.reduce((s, c) => s + c.v / Math.pow(1 + r, c.t), 0);

  const df = (r) =>
    cf.reduce((s, c) =>
      c.t === 0 ? s : s - (c.t * c.v) / Math.pow(1 + r, c.t + 1), 0);

  let r = guess;
  for (let i = 0; i < 500; i++) {
    const fr = f(r);
    const dfr = df(r);
    if (Math.abs(dfr) < 1e-12) break;
    const r1 = r - fr / dfr;
    if (Math.abs(r1 - r) < 1e-8) return r1;
    r = Math.max(-0.999, Math.min(100, r1));
  }
  return r;
}

module.exports = { xirr };
