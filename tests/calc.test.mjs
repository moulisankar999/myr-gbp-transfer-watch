import test from 'node:test'; import assert from 'node:assert/strict';
import { norm, rescale, rank, decideAlert, trendTip, goodnessPct } from '../assets/calc.js';
test('fee deducted vs added', () => {
  const w = norm('wise', 30000, 0.185175, 195.27, 'deducted');
  assert.equal(w.receive_gbp, 5519.09); assert.equal(w.pay_myr, 30000); assert.equal(w.all_in_gbp, 5519.09);
  const wu = norm('westernunion', 30000, 0.1853245, 150, 'added');
  assert.equal(wu.receive_gbp, 5559.74); assert.equal(wu.pay_myr, 30150); assert.equal(wu.all_in_gbp, 5532.07);
});
test('WU in-app benchmark (fee 0) equals the screenshot', () => assert.equal(norm('westernunion', 30000, 0.1853245, 0, 'added').receive_gbp, 5559.74));
test('cap marks ineligible and rank sorts by all-in', () => {
  const qs = [norm('a', 30000, 0.18, 5, 'added', { cap_myr: 14495 }), norm('b', 30000, 0.185, 150, 'deducted'), norm('c', 30000, 0.184, 8, 'added')];
  const r = rank(qs); assert.deepEqual(r.eligible.map((q) => q.id), ['b', 'c']); assert.equal(r.ineligible[0].id, 'a'); assert.equal(r.best.id, 'b');
});
test('rescale keeps percentage fee proportional', () => {
  const q = rescale({ ...norm('instarem', 30000, 0.185, 150, 'deducted', { fee_pct: 0.005 }), base_amount: 30000 }, 10000);
  assert.equal(q.fee_myr, 50); assert.equal(q.receive_gbp, 1840.75);
});
test('alert: cross, no repeat, new high, reminder, reset', () => {
  let s = {}, t = 0, d;
  d = decideAlert(5550, 5559.74, s, t); assert.equal(d.send, false); s = d.state;
  d = decideAlert(5565, 5559.74, s, t); assert.equal(d.send, true); s = d.state;
  d = decideAlert(5566, 5559.74, s, t + 60e3); assert.equal(d.send, false); s = d.state;
  d = decideAlert(5571, 5559.74, s, t + 120e3); assert.equal(d.send, true); assert.equal(d.reason, 'new high'); s = d.state;
  d = decideAlert(5571, 5559.74, s, t + 120e3 + 3 * 3600e3); assert.equal(d.send, true); s = d.state;
  d = decideAlert(5500, 5559.74, s, t); assert.equal(d.state.above, false);
});
test('trend tip', () => {
  const rows = Array.from({ length: 120 }, (_, i) => [new Date(Date.UTC(2026, 6, 1) + i * 864e5).toISOString().slice(0, 10), 5.5 - i * 0.001]);
  assert.equal(goodnessPct(rows, 90, 5.38), 100);
  assert.equal(trendTip(rows, 5.38).tone, 'good');
  assert.equal(trendTip(rows, 5.6).tone, 'wait');
});
