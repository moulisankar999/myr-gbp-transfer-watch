// Pure maths shared by the dashboard and the tests. Mirrors scraper/scrape.py (norm, best_quote, decide_alert).
export const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

/** Normalise a quote. feeMode 'deducted': you pay `amount`, fee comes out of it. 'added': fee charged on top. */
export function norm(id, amount, rate, fee, feeMode, extra = {}) {
  rate = +rate; fee = +(fee || 0);
  const pay = feeMode === 'deducted' ? amount : amount + fee;
  const receive = feeMode === 'deducted' ? (amount - fee) * rate : amount * rate;
  const allIn = (receive * amount) / pay; // GBP per RM<amount> actually spent, fees included
  const cap = extra.cap_myr ?? null;
  return { ...extra, id, ok: true, rate, fee_myr: r2(fee), fee_mode: feeMode, pay_myr: r2(pay), receive_gbp: r2(receive),
    all_in_gbp: r2(allIn), effective_rate: allIn / amount, over_cap: !!(cap && amount > cap), cap_myr: cap };
}

/** Rescale a scraped quote to another amount using its fee model (fixed fee or % fee). */
export function rescale(q, amount) {
  if (!q || !q.ok) return q;
  const fee = q.fee_pct != null ? amount * q.fee_pct : q.fee_myr;
  return { ...norm(q.id, amount, q.rate, fee, q.fee_mode, { ...q, cap_myr: q.cap_myr }), rescaled: amount !== q.base_amount };
}

export function rank(quotes, { instantOnly = false, meta = {} } = {}) {
  const ok = quotes.filter((q) => q && q.ok);
  const elig = ok.filter((q) => !q.over_cap && (!instantOnly || meta[q.id]?.instant));
  const inel = ok.filter((q) => !elig.includes(q));
  elig.sort((a, b) => b.all_in_gbp - a.all_in_gbp);
  inel.sort((a, b) => b.all_in_gbp - a.all_in_gbp);
  const best = elig[0] || null;
  return { eligible: elig, ineligible: inel, best };
}

export function vs(value, ref) {
  if (value == null || ref == null) return null;
  return { gbp: r2(value - ref), pct: ((value - ref) / ref) * 100 };
}

/** Browser alert: fire on first crossing above target, on a new high >= minImp, or a reminder after repeatH hours. */
export function decideAlert(bestVal, target, state = {}, nowMs = Date.now(), { minImp = 5, repeatH = 3 } = {}) {
  const st = { ...state };
  if (bestVal == null) return { send: false, reason: 'no quote', state: st };
  if (bestVal <= target) return { send: false, reason: 'below target', state: { ...st, above: false, lastValue: null } };
  let reason;
  if (!st.above || st.lastValue == null) reason = 'crossed above your target';
  else if (bestVal >= st.lastValue + minImp) reason = 'new high';
  else if (nowMs - (st.lastTs || 0) >= repeatH * 3600e3) reason = 'still above target';
  else return { send: false, reason: 'already alerted', state: st };
  return { send: true, reason, state: { above: true, lastValue: bestVal, lastTs: nowMs } };
}

// ---------------------------------------------------------------- trend maths (rates are GBP->MYR; lower = better for sending MYR)
export function stats(rows, days) {
  // rows: [[YYYY-MM-DD, gbp_myr], ...] ascending
  if (!rows?.length) return null;
  const last = rows[rows.length - 1][0];
  const cutoff = new Date(Date.parse(last) - days * 864e5).toISOString().slice(0, 10);
  const w = rows.filter((r) => r[0] > cutoff).map((r) => r[1]);
  if (!w.length) return null;
  const avg = w.reduce((a, b) => a + b, 0) / w.length;
  return { n: w.length, avg, high: Math.max(...w), low: Math.min(...w) };
}

/** Share of the window's days on which GBP cost MORE MYR than now (high = good time to send). */
export function goodnessPct(rows, days, current) {
  const last = rows[rows.length - 1][0];
  const cutoff = new Date(Date.parse(last) - days * 864e5).toISOString().slice(0, 10);
  const w = rows.filter((r) => r[0] > cutoff).map((r) => r[1]);
  if (!w.length) return null;
  return (w.filter((v) => v > current).length / w.length) * 100;
}

export const sma = (vals, n) => (vals.length >= n ? vals.slice(-n).reduce((a, b) => a + b, 0) / n : null);

/** Plain-English send/wait tip for someone converting MYR into GBP. */
export function trendTip(rows, current) {
  if (!rows?.length || !current) return null;
  const vals = rows.map((r) => r[1]);
  const s30 = stats(rows, 30), s90 = stats(rows, 90);
  const g90 = goodnessPct(rows, 90, current), g30 = goodnessPct(rows, 30, current);
  const m5 = sma(vals, 5), m20 = sma(vals, 20);
  const mom = m5 && m20 ? ((m5 - m20) / m20) * 100 : 0; // + = GBP getting dearer (bad for you)
  const vsAvg = ((current - s30.avg) / s30.avg) * 100;   // + = GBP dearer than usual
  const momTxt = mom > 0.15 ? 'the pound has been getting dearer over the last week' : mom < -0.15 ? 'the pound has been getting cheaper over the last week' : 'the rate has been flat over the last week';
  let verdict, tone, why;
  if (g90 >= 70) {
    verdict = 'Good time to send'; tone = 'good';
    why = `Your ringgit buys more pounds now than on ${g90.toFixed(0)}% of days in the last 90. ${cap(momTxt)}.`;
  } else if (g90 <= 30 && mom < -0.15) {
    verdict = 'Consider waiting a few days'; tone = 'wait';
    why = `The pound is dearer than on most of the last 90 days, but it has started to ease (${momTxt}), so a better rate may come soon.`;
  } else if (g90 <= 30) {
    verdict = 'Rate is weak — send only what you need'; tone = 'wait';
    why = `The pound costs more than on ${(100 - g90).toFixed(0)}% of the last 90 days and ${momTxt}. If the money isn't urgent, splitting it over a few days limits the risk.`;
  } else {
    verdict = 'Fair rate — fine to send'; tone = 'neutral';
    why = `Today's rate is in the middle of its 90-day range (better than ${g90.toFixed(0)}% of days) and ${momTxt}. Waiting is a coin-flip; sending your daily RM30,000 regularly averages out the swings.`;
  }
  return { verdict, tone, why, s30, s90, g30, g90, mom, vsAvg };
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
