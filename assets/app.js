import { norm, rescale, rank, vs, decideAlert, stats, goodnessPct, trendTip, r2 } from './calc.js';

const REPO = 'moulisankar999/myr-gbp-transfer-watch';
const qs = new URLSearchParams(location.search);
const DATA = qs.get('data') === 'local' ? './data/' : `https://raw.githubusercontent.com/${REPO}/data/data/`;
const REFRESH_S = 60;
const BASE = { gbp: 5559.74, myr: 30000, rate: 0.1853, label: 'Your WU transfer, 14 Nov' }; // from Mouli's screenshot
const BASE_RATE = BASE.gbp / BASE.myr;
const EVENTS = [
  ['2026-12-17', 'Bank of England rate decision'], ['2027-01-21', 'Bank Negara (BNM) OPR decision'],
  ['2027-02-04', 'Bank of England rate decision'], ['2027-03-04', 'Bank Negara (BNM) OPR decision'],
  ['2027-03-18', 'Bank of England rate decision'], ['2027-04-29', 'Bank of England rate decision'], ['2027-05-06', 'Bank Negara (BNM) OPR decision'],
];
const META = {
  wise: { name: 'Wise', lic: true, licTxt: 'BNM licensed', speed: 'Seconds', instant: true, url: 'https://wise.com/my/send-money/send-money-to-united-kingdom', limit: 'FPX pay-in up to RM30,000 per transfer' },
  westernunion: { name: 'Western Union', lic: null, licTxt: 'Licence not verified', speed: 'Minutes–1 day', instant: true, url: 'https://www.westernunion.com/my/en/send-money/app/start', limit: 'Direct to Bank' },
  instarem: { name: 'Instarem', lic: true, licTxt: 'BNM licensed (NIUM)', speed: 'Minutes–24h', instant: true, url: 'https://www.instarem.com/en-my/', limit: 'RM50,000 per transfer; FPX up to RM30,000' },
  eremit: { name: 'Merchantrade eRemit', lic: true, licTxt: 'BNM licensed', speed: 'Minutes–2 days', instant: false, url: 'https://www.eremit.com.my/', limit: '' },
  moneymatch: { name: 'MoneyMatch', lic: true, licTxt: 'BNM licensed', speed: '1–2 business days', instant: false, url: 'https://transfer.moneymatch.co/', limit: 'RM30,000 per transfer' },
  worldremit: { name: 'WorldRemit', lic: null, licTxt: 'Licence not verified', speed: '2 working days', instant: false, url: 'https://www.worldremit.com/en-my/united-kingdom', limit: 'Max RM14,500 per transfer' },
  cimb: { name: 'CIMB SpeedSend', lic: true, licTxt: 'Licensed bank', speed: 'Instant', instant: true, url: 'https://www.cimb.com.my/en/personal/day-to-day-banking/remittance/speedsend.html', manual: true, defFee: 10.8, mnote: 'Rate only inside CIMB OCTO / Clicks (live 8:30am–6pm MYT, business days). Fee RM10 + 8% SST = RM10.80. RM50k/day.' },
  bigpay: { name: 'BigPay', lic: true, licTxt: 'BNM licensed', speed: 'Check app', instant: null, url: 'https://www.bigpayme.com/', manual: true, defFee: 6, mnote: 'No public quote (website under maintenance). UK fee listed as RM6; rate only in the BigPay app.' },
  sunway: { name: 'Sunway Money', lic: true, licTxt: 'BNM licensed', speed: 'Immediate–3 days', instant: null, url: 'https://www.sunwaymoney.com/', manual: true, mnote: 'No public quote found; rate and fee only in the Sunway Money app.' },
};
const LIVE_ORDER = ['wise', 'westernunion', 'instarem', 'moneymatch', 'eremit', 'worldremit'];

// ------------------------------------------------------------------ state
const ls = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const hashTopic = new URLSearchParams(location.hash.slice(1)).get('t');
if (hashTopic && /^[A-Za-z0-9_-]{12,64}$/.test(hashTopic)) { ls.set('tw-topic', hashTopic); history.replaceState(null, '', location.pathname + location.search); }
const S = {
  amount: ls.get('tw-amount', 30000), instantOnly: ls.get('tw-instant', false), range: ls.get('tw-range', 90),
  targetGbp: ls.get('tw-target', BASE.gbp), manual: ls.get('tw-manual', {}), alertState: ls.get('tw-alert', {}),
  notify: ls.get('tw-notify', false), sound: ls.get('tw-sound', true), topic: ls.get('tw-topic', null),
  data: null, hist: null, live: {}, liveMid: null, liveBanks: null, lastLive: null, busy: false,
};

// ------------------------------------------------------------------ formatting
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (d) => new Intl.NumberFormat('en-MY', { minimumFractionDigits: d, maximumFractionDigits: d });
const gbp = (x, d = 2) => x == null ? '—' : '£' + nf(d).format(x);
const myr = (x, d = 2) => x == null ? '—' : 'RM' + nf(d).format(x);
const num = (x, d) => x == null ? '—' : nf(d).format(x);
const sgn = (x, f) => (x > 0 ? '+' : x < 0 ? '−' : '±') + f(Math.abs(x));
const TZ = 'Asia/Kuala_Lumpur';
const tFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
const myt = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : `${tFmt.format(d)} MYT${dayDiff(d) ? ', ' + dFmt.format(d) : ''}`; };
const dayDiff = (d) => dFmt.format(d) !== dFmt.format(new Date());
const age = (iso) => { const m = (Date.now() - Date.parse(iso)) / 60000; if (!isFinite(m)) return ''; return m < 1.5 ? 'just now' : m < 90 ? `${Math.round(m)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }

// ------------------------------------------------------------------ live fetchers (CORS-enabled public quote endpoints)
const tfetch = (url, opt = {}, ms = 12000) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opt, signal: c.signal, cache: 'no-store' }).finally(() => clearTimeout(t)); };
const L = {
  async wise(a) {
    const d = await (await tfetch(`https://api.wise.com/v4/comparisons/?sourceCurrency=MYR&targetCurrency=GBP&sendAmount=${a}`)).json();
    const banks = [];
    for (const p of d.providers || []) {
      const q = p.quotes?.[0]; if (!q) continue;
      if (p.alias === 'wise') { S.liveMid = { myr_gbp: q.rate, gbp_myr: 1 / q.rate, source: 'Wise mid-market (live)', at: new Date().toISOString() }; }
      else if (p.type === 'bank') banks.push({ ...norm('bank-' + p.alias, a, q.rate, q.fee, 'deducted'), name: p.name, markup_pct: q.markup, at: q.dateCollected });
    }
    S.liveBanks = banks.sort((x, y) => y.all_in_gbp - x.all_in_gbp);
    const w = d.providers.find((p) => p.alias === 'wise').quotes[0];
    return norm('wise', a, w.rate, w.fee, 'deducted', { fee_pct: w.fee / a, src_label: 'Wise public quote API' });
  },
  async westernunion(a) {
    const body = { header_request: { version: '0.5', request_type: 'PRICECATALOG' }, sender: { client: 'WUCOM', channel: 'WWEB', funds_in: '*', curr_iso3: 'MYR', cty_iso2_ext: 'MY', send_amount: String(a) }, receiver: { curr_iso3: 'GBP', cty_iso2_ext: 'GB', cty_iso2: 'GB' } };
    const d = await (await tfetch('https://www.westernunion.com/wuconnect/prices/catalog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const s = (d.services_groups || []).find((x) => x.service === '500'); if (!s) throw new Error('no Direct to Bank');
    const p = s.pay_groups.find((x) => x.fund_in === 'FP') || s.pay_groups[0];
    const waived = S.data?.target?.assume_wu_app_fee_waived ?? true;
    return norm('westernunion', a, p.fx_rate, waived ? 0 : p.gross_fee, 'added', { web_fee_myr: p.gross_fee, fee_waived_assumed: waived, src_label: 'Western Union public price catalog' });
  },
  async moneymatch(a) {
    const [r, f] = await Promise.all([tfetch('https://transfer.moneymatch.co/utility/rate/MYR/GBP').then((x) => x.text()), tfetch('https://transfer.moneymatch.co/fees?from=MYR&to=GBP').then((x) => x.text())]);
    if (!isFinite(+r) || !+r) throw new Error('bad rate');
    return norm('moneymatch', a, +r, +f, 'added', { cap_myr: 30000, src_label: 'MoneyMatch public rate + fee' });
  },
  async eremit(a) {
    const d = await (await tfetch('https://www.eremit.com.my/api/list/exchangerate')).json();
    const row = d.find((x) => x.CurrencyCode === 'GBP' && x.PayoutMode === 'Bank Account'); if (!row) throw new Error('no GBP');
    return norm('eremit', a, +row.ExchangeRate, 5, 'added', { fee_assumed: true, src_label: 'eRemit public rate list' });
  },
  async worldremit(a) {
    const cap = 14495, qa = Math.min(a, cap);
    const q = 'mutation($amount: BigDecimal!) { createCalculation(calculationInput: {amount: $amount, send: {country: "MY", currency: "MYR"}, type: SEND, receive: {country: "GB", currency: "GBP"}, payOutMethodCode: "BNK", correspondentId: ""}) { calculation { informativeSummary { fee { value { amount } } } exchangeRate { value } } errors { __typename } } }';
    const d = await (await tfetch('https://api.worldremit.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WR-PLATFORM': 'Web' }, body: JSON.stringify({ query: q, variables: { amount: qa } }) })).json();
    const k = d.data?.createCalculation?.calculation; if (!k) throw new Error('no calc');
    return norm('worldremit', a, k.exchangeRate.value, k.informativeSummary.fee.value.amount, 'added', { cap_myr: cap, src_label: 'WorldRemit public calculator' });
  },
};

async function fetchLive() {
  const a = S.amount;
  const res = await Promise.allSettled(Object.entries(L).map(([id, fn]) => fn(a).then((q) => ({ ...q, at: new Date().toISOString(), src: 'live' }))));
  const live = {};
  Object.keys(L).forEach((id, i) => { if (res[i].status === 'fulfilled') live[id] = res[i].value; });
  S.live = live; S.liveAmount = a; S.lastLive = new Date().toISOString();
}
async function fetchData() {
  const bust = `?t=${Math.floor(Date.now() / 60000)}`;
  const [l, h] = await Promise.allSettled([tfetch(DATA + 'latest.json' + bust).then((r) => r.ok ? r.json() : Promise.reject(r.status)), tfetch(DATA + 'history.json' + bust).then((r) => r.ok ? r.json() : Promise.reject(r.status))]);
  if (l.status === 'fulfilled') S.data = l.value;
  if (h.status === 'fulfilled') S.hist = h.value;
  if (!S.hist?.daily?.length) { // fallback: ECB via Frankfurter
    try {
      const start = new Date(Date.now() - 370 * 864e5).toISOString().slice(0, 10);
      const d = await (await tfetch(`https://api.frankfurter.dev/v1/${start}..?base=GBP&symbols=MYR`)).json();
      S.hist = { ...(S.hist || {}), daily: Object.entries(d.rates).map(([k, v]) => [k, v.MYR]), daily_source: 'ECB reference rate via Frankfurter' };
    } catch {}
  }
}

// ------------------------------------------------------------------ assemble quotes
function quotes() {
  const a = S.amount, out = [];
  const scraped = Object.fromEntries((S.data?.quotes || []).map((q) => [q.id, q]));
  for (const id of [...LIVE_ORDER]) {
    const lv = S.liveAmount === a ? S.live[id] : null;
    if (lv) { out.push(lv); continue; }
    const sc = scraped[id];
    if (sc?.ok) out.push({ ...rescale({ ...sc, base_amount: S.data.amount_myr }, a), src: sc.stale ? 'stale' : 'scraped', at: sc.fetched_at || sc.at, src_label: sc.source, fee_note: sc.fee_note });
    else out.push({ id, ok: false, error: sc?.error || 'not available yet', src: 'err' });
  }
  for (const [id, m] of Object.entries(S.manual)) {
    if (!META[id] || !m?.rate) continue;
    out.push({ ...norm(id, a, m.rate, m.fee || 0, 'added'), src: 'manual', at: m.at, src_label: 'Typed in by you' });
  }
  return out;
}

// ------------------------------------------------------------------ render
function midNow() { return S.liveMid || (S.data?.mid ? { ...S.data.mid, source: (S.data.mid.source || 'mid') + ' (scraped)' } : null); }
function prevClose() {
  const rows = S.hist?.daily; if (!rows?.length) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const r = [...rows].reverse().find((x) => x[0] < today); return r ? r[1] : null;
}
function arrow(ch, goodWhenDown) {
  if (ch == null || Math.abs(ch) < 1e-9) return `<span class="chg flat">▬ 0.00%</span>`;
  const up = ch > 0, good = goodWhenDown ? !up : up;
  return `<span class="chg ${good ? 'up' : 'down'}">${up ? '▲' : '▼'} ${sgn(ch, (x) => x.toFixed(2))}%</span>`;
}
function spark() {
  const pts = (S.hist?.intraday || []).filter((p) => p[1]).slice(-300);
  if (pts.length < 3) return '';
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys) || 1;
  const P = pts.map((p) => `${((p[0] - x0) / (x1 - x0 || 1)) * 300},${44 - ((p[1] - y0) / (y1 - y0 || 1)) * 40}`).join(' ');
  return `<svg class="spark" viewBox="0 0 300 46" preserveAspectRatio="none" aria-label="Mid-market rate, last 3 days"><polyline points="${P}" fill="none" stroke="var(--acc)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><div class="mid-alt small">Last 3 days (GBP→MYR, lower = better for you)</div>`;
}

function render() {
  const a = S.amount, qs_ = quotes(), R = rank(qs_, { instantOnly: S.instantOnly, meta: META }), best = R.best;
  const mid = midNow(), pc = prevClose();
  const chg = mid && pc ? ((mid.gbp_myr - pc) / pc) * 100 : null;
  const target = (S.targetGbp / BASE.myr) * a, baseGbp = BASE_RATE * a;
  const beat = best && best.all_in_gbp > target;

  // hero
  const bestM = best ? META[best.id] : null;
  const vB = best ? vs(best.all_in_gbp, baseGbp) : null, vT = best ? vs(best.all_in_gbp, target) : null;
  const midVal = mid ? best && (best.all_in_gbp / (a * mid.myr_gbp) - 1) * 100 : null;
  $('#hero').innerHTML = `
    <div class="hcard">
      <div class="k">Mid-market · live</div>
      <div class="big num">1 GBP = RM${mid ? num(mid.gbp_myr, 4) : '—'} ${arrow(chg, true)}</div>
      <div class="mid-alt">RM1 = £${mid ? num(mid.myr_gbp, 6) : '—'} ${arrow(chg == null ? null : -chg, false)} · vs yesterday's close${pc ? ` (RM${num(pc, 4)})` : ''}</div>
      <div class="mid-alt small">RM${num(a, 0)} at mid-market = <b>${mid ? gbp(a * mid.myr_gbp) : '—'}</b> · ${esc(mid?.source || '')}, ${mid ? myt(mid.at) : ''}</div>
      ${spark()}
    </div>
    <div class="hcard best ${beat ? 'beat' : ''}">
      <div class="k">${beat ? '🎯 Beats your target — good moment to send' : 'Best deal right now'} · RM${num(a, 0)}</div>
      ${best ? `<div class="best-line"><div class="big num">${gbp(best.all_in_gbp)}</div><div class="best-name">${esc(bestM.name)}</div></div>
      <div class="mid-alt">Rate ${num(best.rate, 4)} · fee ${myr(best.fee_myr)}${best.fee_mode === 'added' && best.fee_myr ? ' on top' : ''} · ${esc(bestM.speed)} · ${srcBadge(best)}</div>
      <div class="delta">
        <span class="tag ${vT.gbp > 0 ? 'good' : 'bad'}">vs target ${sgn(vT.gbp, (x) => gbp(x))}</span>
        <span class="tag ${vB.gbp >= 0 ? 'good' : 'bad'}">vs your WU 14 Nov ${sgn(vB.gbp, (x) => gbp(x))} (${sgn(vB.pct, (x) => x.toFixed(2))}%)</span>
        ${midVal != null ? `<span class="tag">${midVal >= 0 ? 'above' : 'below'} mid-market by ${Math.abs(midVal).toFixed(2)}%</span>` : ''}
      </div>
      <div class="row" style="margin-top:12px"><a class="go" href="${bestM.url}" target="_blank" rel="noopener">Open ${esc(bestM.name)} ↗</a><span class="mid-alt small">Confirm the final amount in the app before paying.</span></div>`
      : '<p class="skeleton">Waiting for quotes…</p>'}
    </div>`;

  // ranking
  const head = `<div class="thead"><span>#</span><span>Provider</span><span>Rate</span><span>Fee</span><span>You pay</span><span>They get</span><span>All-in*</span><span>vs best · vs WU</span><span></span></div>`;
  $('#rank').innerHTML = head + (R.eligible.map((q, i) => row(q, i + 1, best, baseGbp)).join('') || '<p class="skeleton">No quotes yet.</p>')
    + `<p class="hint">*All-in = pounds per RM${num(a, 0)} you actually spend, after the fee (fee-on-top providers are scaled down). Your WU 14 Nov benchmark: £5,559.74 for RM30,000 at 0.1853, fee RM0.</p>`;
  $('#inel').innerHTML = R.ineligible.length || qs_.some((q) => !q.ok) ? `<div class="subh">Can't take RM${num(a, 0)} in one go${S.instantOnly ? ' or not instant' : ''} / unavailable</div>`
    + R.ineligible.map((q) => row(q, '–', best, baseGbp, true)).join('') + qs_.filter((q) => !q.ok).map((q) => `<div class="prow dim"><span class="pos">–</span><div class="pname"><b>${esc(META[q.id]?.name || q.id)} <span class="b err">no quote</span></b><div class="pmeta">${esc(q.error)}</div></div></div>`).join('') : '';
  // manual providers
  const man = Object.entries(META).filter(([, m]) => m.manual);
  $('#manual').innerHTML = `<div class="subh">Check in the app (no public live quote) — type a quote to rank it</div>` + man.map(([id, m]) => {
    const v = S.manual[id];
    return `<div class="mrow"><div class="pname"><b>${esc(m.name)} <span class="b ${m.lic ? 'lic' : 'unv'}">${esc(m.licTxt)}</span></b><div class="pmeta">${esc(m.mnote)}${v ? `<br>Your quote: rate ${v.rate}, fee RM${v.fee} · ${myt(v.at)} (${age(v.at)})` : ''}</div></div>
      <form data-id="${id}"><input name="rate" inputmode="decimal" placeholder="Rate 0.1850" value="${v?.rate ?? ''}" aria-label="${esc(m.name)} rate (GBP per RM1)"><input name="fee" inputmode="decimal" placeholder="Fee RM" value="${v?.fee ?? m.defFee ?? ''}" aria-label="${esc(m.name)} fee in RM"><button class="btn primary">Rank it</button>${v ? `<button type="button" class="btn" data-clear="${id}">Clear</button>` : ''}</form>
      <a class="open" href="${m.url}" target="_blank" rel="noopener">Open ↗</a></div>`;
  }).join('');
  // banks
  const banks = (S.liveAmount === a && S.liveBanks) || (S.data?.banks || []).map((b) => rescale({ ...b, base_amount: S.data.amount_myr }, a));
  $('#banks').innerHTML = banks.length ? `<table class="btable"><tr><th>Bank (SWIFT)</th><th>Rate</th><th>Fee</th><th>They get</th><th>vs best app</th></tr>${banks.map((b) => `<tr><td>${esc(b.name)}</td><td>${num(b.rate, 4)}</td><td>${myr(b.fee_myr)}</td><td><b>${gbp(b.receive_gbp)}</b></td><td class="down">${best ? sgn(b.all_in_gbp - best.all_in_gbp, (x) => gbp(x)) : ''}</td></tr>`).join('')}</table><p class="hint">Source: Wise comparison API (bank rates collected ${banks[0]?.at ? myt(banks[0].at) : 'recently'}). Banks may also deduct correspondent charges.</p>` : '<p class="hint">Not available.</p>';
  $('#legend').innerHTML = `<span class="b live">Live</span><span class="b scr">Scraped</span><span class="b man">Manual</span><span class="b stale">Stale</span>`;
  $('#limitHint').className = 'hint' + (a > 30000 ? ' warn' : '');
  $('#limitHint').innerHTML = a > 30000 ? `Above your RM30,000 daily limit — most apps (FPX) cap a single transfer at RM30,000.` : `RM30,000 is your daily outward-transfer limit. Ranked by <b>pounds received after all fees</b>.`;

  renderTrend(mid);
  renderAlerts(best, target);
  renderSources();
  maybeAlert(best, target);
  document.title = best ? `${gbp(best.all_in_gbp)} · ${META[best.id].name} — Transfer Watch` : 'MYR → GBP Transfer Watch';
}

function srcBadge(q) {
  if (q.src === 'live') return `<span class="b live" title="${esc(q.src_label || '')}">Live ${tFmt.format(new Date(q.at))}</span>`;
  if (q.src === 'manual') return `<span class="b man">Manual · ${age(q.at)}</span>`;
  if (q.src === 'stale') return `<span class="b stale" title="Last good value; latest fetch failed">Stale · ${age(q.at)}</span>`;
  return `<span class="b scr" title="${esc(q.src_label || '')}">Scraped · ${age(q.at)}</span>`;
}
function row(q, pos, best, baseGbp, dim = false) {
  const m = META[q.id] || { name: q.id }, vb = best ? vs(q.all_in_gbp, best.all_in_gbp) : null, vw = vs(q.all_in_gbp, baseGbp);
  const speedB = m.instant ? `<span class="b fast">${esc(m.speed)}</span>` : m.instant === false ? `<span class="b slow">${esc(m.speed)}</span>` : `<span class="b unv">${esc(m.speed)}</span>`;
  const notes = [];
  if (q.over_cap) notes.push(`Max ${myr(q.cap_myr, 0)} per transfer — needs ${Math.ceil(S.amount / q.cap_myr)} transfers.`);
  if (q.id === 'westernunion' && q.fee_waived_assumed) notes.push(`Fee shown as RM0 like your WU app on 14 Nov; the WU website charges ${myr(q.web_fee_myr, 0)} for FPX (then all-in ${gbp((q.receive_gbp * S.amount) / (S.amount + (q.web_fee_myr || 0)))}).`);
  if (q.id === 'eremit') notes.push('Rate is live; RM5 fee is from moneytransfers.com (11 Nov 2026) — confirm in the eRemit app.');
  if (q.id === 'instarem' && q.src !== 'live') notes.push('Instarem blocks browser requests, so this comes from the 10-minute checker (fee 0.5%).');
  return `<div class="prow ${pos === 1 ? 'top' : ''} ${dim ? 'dim' : ''}">
    <span class="pos">${pos}</span>
    <div class="pname"><b>${esc(m.name)} ${srcBadge(q)}</b><div class="pmeta">${speedB} <span class="b ${m.lic ? 'lic' : 'unv'}">${esc(m.licTxt || '')}</span>${m.limit ? ' · ' + esc(m.limit) : ''}</div></div>
    <div class="pstats">
      <div class="pv">${num(q.rate, 4)}<small>rate</small></div>
      <div class="pv">${myr(q.fee_myr)}<small>${q.fee_mode === 'added' ? 'fee on top' : 'fee deducted'}</small></div>
      <div class="pv pay">${myr(q.pay_myr)}<small>you pay</small></div>
      <div class="pv">${gbp(q.all_in_gbp)}<small>all-in</small></div>
      <div class="pv">${vb && pos !== 1 ? `<span class="down">${sgn(vb.gbp, (x) => gbp(x))} vs best</span>` : pos === 1 ? '<span class="up">★ Best</span>' : ''}<small class="${vw.gbp >= 0 ? 'up' : 'down'}">${sgn(vw.gbp, (x) => gbp(x))} (${sgn(vw.pct, (x) => x.toFixed(2))}%) vs WU</small></div>
      <a class="open" href="${m.url}" target="_blank" rel="noopener">Open ↗</a>
    </div>
    <div class="pv get">${gbp(q.receive_gbp)}<small>they get</small></div>
    ${notes.length ? `<div class="note ${q.over_cap ? 'w' : ''}">${notes.map(esc).join(' ')}</div>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ trend
function renderTrend(mid) {
  const rows = S.hist?.daily || [];
  const el = $('#trend');
  if (!rows.length || !mid) { el.innerHTML = '<div class="kicker">Trend</div><h2>Send now or wait?</h2><p class="skeleton">Loading history…</p>'; return; }
  const cur = mid.gbp_myr, T = trendTip(rows, cur), st = stats(rows, S.range), g = goodnessPct(rows, S.range, cur);
  const per1 = S.amount * mid.myr_gbp * 0.01;
  const up = EVENTS.filter((e) => e[0] >= new Date().toISOString().slice(0, 10)).slice(0, 3);
  el.innerHTML = `<div class="sec-h"><div><div class="kicker">World trend · GBP vs MYR</div><h2>Send now or wait?</h2></div>
    <div class="seg" role="radiogroup" aria-label="Range">${[30, 90, 365].map((d) => `<button role="radio" aria-checked="${S.range === d}" data-range="${d}">${d === 365 ? '1Y' : d + 'D'}</button>`).join('')}</div></div>
    <div class="verdict ${T.tone}"><h3>${esc(T.verdict)}</h3><p>${esc(T.why)}</p></div>
    ${chart(rows, S.range, cur, st)}
    <div class="stats">
      <div class="st"><span>Now (1 GBP)</span><b>RM${num(cur, 4)}</b></div>
      <div class="st"><span>${S.range === 365 ? '1Y' : S.range + 'D'} average</span><b>RM${num(st.avg, 4)}</b></div>
      <div class="st"><span>Best for you (low)</span><b class="up">RM${num(st.low, 4)}</b></div>
      <div class="st"><span>Worst (high)</span><b class="down">RM${num(st.high, 4)}</b></div>
    </div>
    <div class="meter" aria-label="Where today sits in the range"><i style="left:calc(${g.toFixed(1)}% - 2px)"></i></div>
    <div class="meter-l"><span>Worse than usual</span><span>Today beats ${g.toFixed(0)}% of the last ${S.range === 365 ? 'year' : S.range + ' days'}</span><span>Better</span></div>
    <p class="small muted" style="margin:10px 0 0">Every 1% move in the pound = about <b>${gbp(per1)}</b> on RM${num(S.amount, 0)}. Last week's momentum: ${T.mom > 0 ? 'pound rising' : T.mom < 0 ? 'pound falling' : 'flat'} (${sgn(T.mom, (x) => x.toFixed(2))}%, 5-day vs 20-day average). Today vs 30-day average: ${T.vsAvg > 0 ? 'pound dearer' : 'pound cheaper'} by ${Math.abs(T.vsAvg).toFixed(2)}%.</p>
    <ul class="events">${up.map((e) => `<li><span>${esc(e[1])}</span><b>${new Date(e[0] + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</b></li>`).join('')}</ul>
    <p class="small muted" style="margin:8px 0 0">Rate decisions can move the pound sharply on the day. History: ${esc(S.hist.daily_source || '')}. Not financial advice — nobody can predict currency moves reliably.</p>`;
}
function chart(rows, days, cur, st) {
  const last = rows[rows.length - 1][0];
  const cutoff = new Date(Date.parse(last) - days * 864e5).toISOString().slice(0, 10);
  const w = rows.filter((r) => r[0] > cutoff); if (w.length < 2) return '';
  const W = 600, H = 190, pl = 44, pr = 8, pt = 10, pb = 22;
  const ys = w.map((r) => r[1]).concat([cur]); let y0 = Math.min(...ys), y1 = Math.max(...ys); const pad = (y1 - y0) * 0.08 || 0.01; y0 -= pad; y1 += pad;
  const X = (i) => pl + (i / (w.length - 1)) * (W - pl - pr), Y = (v) => pt + (1 - (v - y0) / (y1 - y0)) * (H - pt - pb);
  const line = w.map((r, i) => `${X(i).toFixed(1)},${Y(r[1]).toFixed(1)}`).join(' ');
  const area = `${X(0)},${H - pb} ${line} ${X(w.length - 1)},${H - pb}`;
  const ticks = [0, 0.5, 1].map((f) => y0 + (y1 - y0) * f);
  const lbl = [0, Math.floor(w.length / 2), w.length - 1].map((i) => `<text x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === w.length - 1 ? 'end' : 'middle'}">${new Date(w[i][0] + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="GBP to MYR, last ${days} days">
    <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--acc)" stop-opacity=".35"/><stop offset="1" stop-color="var(--acc)" stop-opacity="0"/></linearGradient></defs>
    <g class="grid">${ticks.map((v) => `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${pl - 4}" y="${Y(v) + 3}" text-anchor="end">${v.toFixed(3)}</text>`).join('')}</g>
    <polygon points="${area}" fill="url(#ga)"/><polyline points="${line}" fill="none" stroke="var(--acc)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <line x1="${pl}" x2="${W - pr}" y1="${Y(st.avg)}" y2="${Y(st.avg)}" stroke="var(--muted)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
    <text x="${W - pr}" y="${Y(st.avg) - 4}" text-anchor="end">avg</text>
    <circle cx="${X(w.length - 1)}" cy="${Y(cur)}" r="4" fill="var(--acc2)"/>${lbl}</svg>`;
}

// ------------------------------------------------------------------ alerts
function renderAlerts(best, target) {
  const cfgT = S.data?.target, al = S.data?.alert || {};
  const topicUrl = S.topic ? `https://ntfy.sh/${S.topic}` : null;
  $('#alerts').innerHTML = `<div class="kicker">Alerts</div><h2>Never miss a better rate</h2>
    <div class="field"><span class="small"><b>Alert me when RM30,000 gets more than</b></span><span class="amt-box"><b>£</b><input id="target" inputmode="decimal" value="${num(S.targetGbp, 2)}" aria-label="Target pounds for RM30,000"></span>
      <button class="btn" id="tgtReset" title="Your WU transfer on 14 Nov">Reset to £5,559.74</button></div>
    <p class="small muted" style="margin:0">= rate ${num(S.targetGbp / 30000, 5)} after fees. Now: ${best ? `<b class="${best.all_in_gbp > target ? 'up' : 'down'}">${gbp(best.all_in_gbp)}</b> via ${esc(META[best.id].name)} for RM${num(S.amount, 0)} (target ${gbp(target)})` : '—'}.</p>
    <div class="field" style="margin-top:12px">
      <button class="btn ${S.notify ? '' : 'primary'}" id="notifBtn">${S.notify ? '✓ Alerts on this device' : 'Turn on alerts on this device'}</button>
      <label class="toggle small"><input type="checkbox" id="soundChk" ${S.sound ? 'checked' : ''}><span></span> Sound</label>
      <button class="btn" id="testBtn">Test</button>
    </div>
    <p class="small muted" style="margin:0">While this page is open (it re-checks every minute) you get a pop-up and a chime on a new high above target, then at most every 3 hours.</p>
    <h3 style="margin:16px 0 4px;font-size:15px">📱 Phone push alerts — even when this page is closed</h3>
    ${topicUrl ? `<div class="qr"><div class="code" id="qr"></div><div style="flex:1;min-width:200px">
      <ol class="steps"><li>Install <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">ntfy</a> (free, no account).</li>
      <li>Tap <b>+</b>, enter the topic below, tap <b>Subscribe</b> — or scan this code / open <a href="${topicUrl}" target="_blank" rel="noopener">your alert link</a>.</li>
      <li>Allow notifications. Done.</li></ol>
      <p class="small" style="margin:6px 0 0">Topic: <code>${esc(S.topic)}</code> <button class="btn" id="copyTopic">Copy</button></p></div></div>`
      : `<p class="small muted">Open the private alert link you were sent once on this device to show the phone setup here (the topic is kept off the public page).</p>`}
    <p class="small muted" style="margin:10px 0 0">The checker runs every 10 min (7am–midnight MYT) and pushes when the best ${cfgT?.instant_only ? 'instant ' : ''}quote beats <b>${gbp(cfgT?.target_gbp ?? 5559.74)}</b> for RM30,000 — again only on a £${cfgT?.min_improvement_gbp ?? 5}+ new high or every ${cfgT?.repeat_after_hours ?? 3} h while it stays above. Quiet ${String(cfgT?.quiet_hours_myt?.[0] ?? 0).padStart(2, '0')}:00–${String(cfgT?.quiet_hours_myt?.[1] ?? 7).padStart(2, '0')}:00 MYT.
      Change the push target by editing <a href="https://github.com/${REPO}/edit/main/config.json" target="_blank" rel="noopener">config.json</a> (<code>target_gbp</code>) and committing.</p>
    <p class="small muted" style="margin:6px 0 0">Last check: ${al.last_check ? `${myt(al.last_check.checked_at)} — ${esc(al.last_check.decision)}` : '—'}${al.last_sent_at ? ` · Last push: ${myt(al.last_sent_at)} (${gbp(al.last_value)})` : ' · No push sent yet'}.</p>`;
  if (topicUrl && window.qrcode) { const q = qrcode(0, 'M'); q.addData(topicUrl); q.make(); $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
}
function beep() {
  try { const C = new (window.AudioContext || window.webkitAudioContext)(); [880, 1175, 1568].forEach((f, i) => { const o = C.createOscillator(), g = C.createGain(); o.frequency.value = f; o.connect(g); g.connect(C.destination); const t = C.currentTime + i * 0.16; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15); o.start(t); o.stop(t + 0.16); }); } catch {}
}
async function notify(title, body) {
  if (S.sound) beep();
  toast(title);
  if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) reg.showNotification(title, { body, icon: 'assets/icon-192.png', tag: 'tw-rate', renotify: true }); else new Notification(title, { body, icon: 'assets/icon-192.png' }); } catch {}
}
function maybeAlert(best, target) {
  if (!best || !S.lastLive) return;
  const d = decideAlert(best.all_in_gbp, target, S.alertState);
  S.alertState = d.state; ls.set('tw-alert', d.state);
  if (d.send) notify(`Better rate: ${gbp(best.all_in_gbp)} via ${META[best.id].name}`, `RM${num(S.amount, 0)} → ${gbp(best.receive_gbp)} at ${num(best.rate, 4)}, fee ${myr(best.fee_myr)}. ${gbp(best.all_in_gbp - target)} above your target (${d.reason}).`);
}

// ------------------------------------------------------------------ sources
function renderSources() {
  const d = S.data;
  $('#sources').innerHTML = `<div class="sec-h"><div><div class="kicker">Transparency</div><h2>Where the numbers come from</h2></div></div>
  <div class="panel src"><table>
    <tr><td><b>Wise</b></td><td>Public quote API (api.wise.com comparisons) — live in your browser; also gives the mid-market rate and the bank comparison.</td></tr>
    <tr><td><b>Western Union</b></td><td>Public price catalog behind westernunion.com/my (Direct to Bank, FPX pay-in) — live. Matches your 14 Nov app quote (0.1853 → £5,559.74).</td></tr>
    <tr><td><b>Instarem</b></td><td>Public calculator API — fetched by the 10-minute checker (blocks browsers).</td></tr>
    <tr><td><b>MoneyMatch</b></td><td>Public rate + fee endpoints on transfer.moneymatch.co — live.</td></tr>
    <tr><td><b>Merchantrade eRemit</b></td><td>Public rate list on eremit.com.my — live rate; RM5 fee from moneytransfers.com (11 Nov 2026), not live.</td></tr>
    <tr><td><b>WorldRemit</b></td><td>Public calculator — live; max RM14,500 per transfer, 2 working days.</td></tr>
    <tr><td><b>CIMB SpeedSend, BigPay, Sunway Money</b></td><td>No public quote — type the app's rate in to rank it (saved on this device only).</td></tr>
    <tr><td><b>Not included</b></td><td>Remitly and Revolut (don't send from Malaysia), Maybank/HSBC/Public Bank/Hong Leong (SWIFT, shown under bank comparison).</td></tr>
    <tr><td><b>Licences</b></td><td>Checked against Bank Negara's list of licensees with digital remittance channels (May 2026): Wise, NIUM (Instarem), MoneyMatch, Merchantrade, BigPay, Sunway Money. Western Union and WorldRemit aren't on that list; their Malaysian licence holder wasn't verified.</td></tr>
    <tr><td><b>Checker</b></td><td>${d ? `Last run ${myt(d.generated_at)} (${age(d.generated_at)}). ` : ''}GitHub Actions, every 10 min 7am–midnight MYT. This page re-checks live quotes every ${REFRESH_S}s${S.lastLive ? ` (last ${myt(S.lastLive)})` : ''}.</td></tr>
  </table></div>`;
}

// ------------------------------------------------------------------ wiring
function setAmount(v, refetch = true) {
  v = Math.max(100, Math.min(200000, Math.round(+String(v).replace(/[^0-9.]/g, '') || 30000)));
  S.amount = v; ls.set('tw-amount', v);
  $('#amount').value = nf(0).format(v);
  document.querySelectorAll('#amtChips button').forEach((b) => b.classList.toggle('on', +b.dataset.a === v));
  render(); if (refetch) refresh();
}
let cd = REFRESH_S, timer;
async function refresh() {
  if (S.busy) return; S.busy = true; $('#refreshBtn').classList.add('busy');
  try { await Promise.all([fetchLive(), fetchData()]); } catch (e) { console.warn(e); }
  S.busy = false; $('#refreshBtn').classList.remove('busy'); cd = REFRESH_S; render();
}
function tick() {
  $('#clock').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()) + ' MYT';
  cd--; $('#countdown').textContent = cd + 's'; if (cd <= 0) refresh();
}
function bindOnce() {
  $('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('tw-theme', t); } catch {} };
  $('#refreshBtn').onclick = () => refresh();
  $('#bellBtn').onclick = () => document.getElementById('alerts').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#amount').addEventListener('change', (e) => setAmount(e.target.value));
  $('#amount').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#amtChips').onclick = (e) => { const b = e.target.closest('button'); if (b) setAmount(b.dataset.a); };
  $('#instantOnly').checked = S.instantOnly;
  $('#instantOnly').onchange = (e) => { S.instantOnly = e.target.checked; ls.set('tw-instant', S.instantOnly); render(); };
  document.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-range]'); if (r) { S.range = +r.dataset.range; ls.set('tw-range', S.range); render(); }
    const c = e.target.closest('[data-clear]'); if (c) { delete S.manual[c.dataset.clear]; ls.set('tw-manual', S.manual); render(); }
    if (e.target.id === 'tgtReset') { S.targetGbp = BASE.gbp; ls.set('tw-target', S.targetGbp); S.alertState = {}; ls.set('tw-alert', {}); render(); toast('Target reset to £5,559.74'); }
    if (e.target.id === 'testBtn') { const p = S.sound; S.sound = true; await notify('Test alert — Transfer Watch', 'This is how a better-rate alert looks and sounds.'); S.sound = p; }
    if (e.target.id === 'copyTopic') { try { await navigator.clipboard.writeText(S.topic); toast('Topic copied'); } catch { toast(S.topic); } }
    if (e.target.id === 'notifBtn') {
      if (!('Notification' in window)) { toast('This browser has no notifications — use the ntfy app below.'); return; }
      if (S.notify) { S.notify = false; ls.set('tw-notify', false); render(); return; }
      const p = await Notification.requestPermission(); S.notify = p === 'granted'; ls.set('tw-notify', S.notify);
      toast(S.notify ? 'Alerts on for this device' : 'Notifications blocked — allow them in browser settings'); render();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'target') { const v = +String(e.target.value).replace(/[^0-9.]/g, ''); if (v > 1000) { S.targetGbp = v; ls.set('tw-target', v); S.alertState = {}; ls.set('tw-alert', {}); render(); toast(`Target set: £${nf(2).format(v)} for RM30,000`); } }
    if (e.target.id === 'soundChk') { S.sound = e.target.checked; ls.set('tw-sound', S.sound); }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-id]'); if (!f) return; e.preventDefault();
    const rate = +f.rate.value.replace(/[^0-9.]/g, ''), fee = +f.fee.value.replace(/[^0-9.]/g, '') || 0;
    if (!(rate > 0.1 && rate < 0.3)) { toast('Enter the rate as GBP per RM1, e.g. 0.1850'); return; }
    S.manual[f.dataset.id] = { rate, fee, at: new Date().toISOString() }; ls.set('tw-manual', S.manual); render(); toast(`${META[f.dataset.id].name} ranked with your quote`);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && cd < REFRESH_S - 15) refresh(); });
}
bindOnce(); setAmount(S.amount, false); refresh(); timer = setInterval(tick, 1000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
