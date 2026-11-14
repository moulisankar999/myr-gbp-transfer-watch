#!/usr/bin/env python3
"""Fetch live MYR->GBP quotes for RM<amount> from Malaysian transfer providers, the mid-market
rate and its history, write JSON for the dashboard, and push an ntfy alert when the best quote
beats the target in config.json. Never invents numbers: a provider that fails keeps its last
good quote (marked stale with its own timestamp) or shows an error."""
import argparse, json, os, sys, time, datetime as dt
import requests

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
S = requests.Session(); S.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*"})
T = 25
MYT = dt.timezone(dt.timedelta(hours=8))
WU_FEE_WAIVED = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def now_iso(): return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
from decimal import Decimal, ROUND_HALF_UP
def r2(x): return None if x is None else float(Decimal(repr(float(x))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

def norm(pid, amount, rate, fee, fee_mode, source, at=None, cap=None, **extra):
    """fee_mode 'deducted': you pay `amount`, fee comes out of it. 'added': fee is charged on top."""
    rate = float(rate); fee = float(fee or 0)
    if fee_mode == "deducted":
        pay = amount; receive = (amount - fee) * rate
    else:
        pay = amount + fee; receive = amount * rate
    all_in = receive * amount / pay  # GBP you get per RM<amount> actually spent, fees included
    q = {"id": pid, "ok": True, "rate": round(rate, 7), "fee_myr": r2(fee), "fee_mode": fee_mode,
         "pay_myr": r2(pay), "receive_gbp": r2(receive), "all_in_gbp": r2(all_in),
         "effective_rate": round(all_in / amount, 7), "source": source, "at": at or now_iso(),
         "fetched_at": now_iso(), "cap_myr": cap, "over_cap": bool(cap and amount > cap)}
    q.update(extra); return q

# ---------------------------------------------------------------- providers
def wise_comparison(amount):
    r = S.get("https://api.wise.com/v4/comparisons/", params={"sourceCurrency": "MYR", "targetCurrency": "GBP", "sendAmount": amount}, timeout=T)
    r.raise_for_status(); d = r.json(); out = {}; banks = []
    for p in d.get("providers", []):
        for qq in p.get("quotes", [])[:1]:
            if p.get("alias") == "wise":
                out["wise"] = norm("wise", amount, qq["rate"], qq["fee"], "deducted", "Wise public quote API", qq.get("dateCollected"),
                                   fee_pct=round(qq["fee"] / amount, 5))
                out["_mid"] = {"myr_gbp": qq["rate"], "source": "Wise (mid-market, 0% markup)", "at": qq.get("dateCollected")}
            elif p.get("type") == "bank":
                b = norm("bank-" + p["alias"], amount, qq["rate"], qq["fee"], "deducted", "Wise comparison (bank telegraphic transfer)", qq.get("dateCollected"))
                b.update({"name": p["name"], "markup_pct": qq.get("markup"), "speed": "1-3 business days (SWIFT)"})
                banks.append(b)
    banks.sort(key=lambda b: -b["all_in_gbp"]); out["_banks"] = banks
    return out

def western_union(amount):
    body = {"header_request": {"version": "0.5", "request_type": "PRICECATALOG"},
            "sender": {"client": "WUCOM", "channel": "WWEB", "funds_in": "*", "curr_iso3": "MYR", "cty_iso2_ext": "MY", "send_amount": str(amount)},
            "receiver": {"curr_iso3": "GBP", "cty_iso2_ext": "GB", "cty_iso2": "GB"}}
    r = S.post("https://www.westernunion.com/wuconnect/prices/catalog", json=body, timeout=T,
               headers={"Origin": "https://www.westernunion.com", "Referer": "https://www.westernunion.com/my/en/home.html"})
    r.raise_for_status(); d = r.json()
    for s in d.get("services_groups", []):
        if s.get("service") == "500":  # Direct to Bank
            pg = {p["fund_in"]: p for p in s["pay_groups"]}
            p = pg.get("FP") or min(s["pay_groups"], key=lambda x: x["gross_fee"])
            fee = 0 if WU_FEE_WAIVED else p["gross_fee"]
            return norm("westernunion", amount, p["fx_rate"], fee, "added", "Western Union public price catalog (web, FPX bank pay-in)",
                        web_fee_myr=r2(p["gross_fee"]), fee_waived_assumed=WU_FEE_WAIVED,
                        fee_note=f"WU website charges RM{p['gross_fee']:,.0f} for FPX pay-in; your WU app transfer on 14 Nov showed RM0, so the app fee is treated as waived (config: assume_wu_app_fee_waived)." if WU_FEE_WAIVED else "Web quote fee for FPX pay-in.",
                        receive_if_fee_waived=r2(p["receive_amount"]))
    raise RuntimeError("WU: no Direct to Bank service in catalog")

def instarem(amount):
    r = S.get("https://www.instarem.com/api/v1/public/transaction/computed-value", timeout=T,
              params={"source_currency": "MYR", "destination_currency": "GBP", "instarem_bank_account_id": "", "country_code": "MY", "source_amount": amount})
    r.raise_for_status(); d = r.json()["data"]; tc = d.get("transaction_config", {})
    q = norm("instarem", amount, d["fx_rate"], d["transaction_fee_amount"], "deducted", "Instarem public calculator API",
             tc.get("fx_rate_last_updated"), cap=tc.get("max_limit"), fee_pct=round(float(d["transaction_fee_percent"]) / 100, 5))
    q["receive_gbp_provider"] = d.get("destination_amount"); return q

def moneymatch(amount):
    rate = float(S.get("https://transfer.moneymatch.co/utility/rate/MYR/GBP", timeout=T).text.strip())
    fee = float(S.get("https://transfer.moneymatch.co/fees", params={"from": "MYR", "to": "GBP"}, timeout=T).text.strip())
    return norm("moneymatch", amount, rate, fee, "added", "MoneyMatch public rate + fee endpoints", cap=30000)

def eremit(amount):
    r = S.get("https://www.eremit.com.my/api/list/exchangerate", timeout=T); r.raise_for_status()
    row = next(x for x in r.json() if x.get("CurrencyCode") == "GBP" and x.get("PayoutMode") == "Bank Account")
    at = None
    try:
        at = dt.datetime.strptime(" ".join(row["UpdatedDate"].split()), "%b %d %Y %I:%M:%S:%f%p").replace(tzinfo=MYT).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception: pass
    return norm("eremit", amount, row["ExchangeRate"], 5, "added", "eRemit public rate list", at,
                fee_note="Fee RM5 is from moneytransfers.com (11 Nov 2026), not from eRemit's API; confirm in the app.", fee_assumed=True)

WR_Q = ('mutation($amount: BigDecimal!) { createCalculation(calculationInput: {amount: $amount, send: {country: "MY", currency: "MYR"}, type: SEND, '
        'receive: {country: "GB", currency: "GBP"}, payOutMethodCode: "BNK", correspondentId: ""}) { calculation { informativeSummary { fee { value { amount } } } '
        'receive { amount } exchangeRate { value } } errors { __typename ... on GenericCalculationError { message } ... on ValidationCalculationError { message } } } }')
def worldremit(amount):
    cap = 14495  # WorldRemit's max is RM14,500 including its RM5 fee
    def calc(a):
        r = S.post("https://api.worldremit.com/graphql", json={"query": WR_Q, "variables": {"amount": a}}, timeout=T,
                   headers={"X-WR-PLATFORM": "Web", "Origin": "https://www.worldremit.com"})
        r.raise_for_status(); return r.json()["data"]["createCalculation"]
    c = calc(min(amount, cap))
    if not c.get("calculation"): raise RuntimeError("WorldRemit: " + "; ".join(e.get("message", "") for e in c.get("errors") or []))
    k = c["calculation"]
    return norm("worldremit", amount, k["exchangeRate"]["value"], k["informativeSummary"]["fee"]["value"]["amount"], "added",
                "WorldRemit public calculator", cap=cap, quoted_for_myr=min(amount, cap))

def wise_mid():
    r = S.get("https://wise.com/rates/live", params={"source": "GBP", "target": "MYR"}, timeout=T); r.raise_for_status(); d = r.json()
    return {"gbp_myr": d["value"], "myr_gbp": 1 / d["value"], "source": "Wise live mid-market", "at": dt.datetime.fromtimestamp(d["time"] / 1000, dt.timezone.utc).isoformat().replace("+00:00", "Z")}

def daily_history():
    try:
        r = S.get("https://query1.finance.yahoo.com/v8/finance/chart/GBPMYR=X", params={"range": "1y", "interval": "1d"}, timeout=T); r.raise_for_status()
        res = r.json()["chart"]["result"][0]; ts = res["timestamp"]; cl = res["indicators"]["quote"][0]["close"]
        rows = [[dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d"), round(c, 5)] for t, c in zip(ts, cl) if c]
        ded = {}; [ded.__setitem__(d, c) for d, c in rows]
        return {"source": "Yahoo Finance GBPMYR=X daily close", "rows": sorted(ded.items())}
    except Exception as e:
        print("yahoo history failed:", e, file=sys.stderr)
    start = (dt.date.today() - dt.timedelta(days=370)).isoformat()
    r = S.get(f"https://api.frankfurter.dev/v1/{start}..", params={"base": "GBP", "symbols": "MYR"}, timeout=T); r.raise_for_status()
    return {"source": "ECB reference rate via Frankfurter", "rows": sorted((d, v["MYR"]) for d, v in r.json()["rates"].items())}

# ---------------------------------------------------------------- alerts
def best_quote(quotes, instant_only=False, meta=None):
    meta = meta or {}
    elig = [q for q in quotes if q.get("ok") and not q.get("over_cap") and not q.get("stale")
            and (not instant_only or meta.get(q["id"], {}).get("instant"))]
    return max(elig, key=lambda q: q["all_in_gbp"]) if elig else None

def decide_alert(best, cfg, state, now_ts, hour_myt):
    """Return (send: bool, reason, new_state). Alert when the best all-in GBP beats the target, but only
    on a new high (>= min_improvement above the last alert) or after repeat_after_hours, and not in quiet hours."""
    st = dict(state or {})
    if not best: return False, "no eligible quote", st
    val = best["all_in_gbp"]; target = float(cfg["target_gbp"])
    if val <= target:
        st.update({"above": False, "last_value": None}); return False, f"best £{val:,.2f} not above target £{target:,.2f}", st
    q0, q1 = (cfg.get("quiet_hours_myt") or [0, 0])
    if q0 != q1 and (q0 <= hour_myt < q1): return False, "quiet hours", st
    last_v = st.get("last_value"); last_t = st.get("last_sent_ts") or 0
    rep = float(cfg.get("repeat_after_hours", 3)) * 3600; imp = float(cfg.get("min_improvement_gbp", 5))
    if not st.get("above") or last_v is None: reason = "crossed above target"
    elif val >= last_v + imp: reason = f"new high (+£{val - last_v:,.2f} since last alert)"
    elif now_ts - last_t >= rep: reason = "still above target (reminder)"
    else: return False, "already alerted recently", st
    st.update({"above": True, "last_value": val, "last_sent_ts": now_ts, "last_provider": best["id"], "last_reason": reason,
               "last_sent_at": dt.datetime.fromtimestamp(now_ts, dt.timezone.utc).isoformat().replace("+00:00", "Z")})
    return True, reason, st

def send_ntfy(topic, best, cfg, meta, reason, mid):
    name = meta.get(best["id"], {}).get("name", best["id"]); amt = cfg["amount_myr"]; tgt = float(cfg["target_gbp"])
    gain = best["all_in_gbp"] - tgt
    msg = (f"{name}: RM{amt:,.0f} → £{best['receive_gbp']:,.2f} (rate {best['rate']:.4f}, fee RM{best['fee_myr']:,.2f}).\n"
           f"All-in £{best['all_in_gbp']:,.2f} = £{gain:,.2f} better than your target £{tgt:,.2f}.\n"
           f"Mid-market 1 GBP = RM{mid:.4f}. {reason}. Check the live quote in the app before sending.")
    body = {"topic": topic, "title": f"Better rate: £{best['all_in_gbp']:,.2f} via {name}", "message": msg, "priority": 4,
            "tags": ["moneybag", "gb"], "click": cfg.get("dashboard_url"),
            "actions": [{"action": "view", "label": "Open dashboard", "url": cfg.get("dashboard_url")},
                        {"action": "view", "label": f"Open {name}", "url": meta.get(best["id"], {}).get("url", cfg.get("dashboard_url"))}]}
    r = requests.post("https://ntfy.sh/", json=body, timeout=T); r.raise_for_status()

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--prev", default="prev"); ap.add_argument("--out", default="out/data")
    ap.add_argument("--no-alert", action="store_true"); a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    cfg = json.load(open(os.path.join(ROOT, "config.json"))); meta = json.load(open(os.path.join(ROOT, "scraper/providers.json")))
    amount = float(cfg.get("amount_myr", 30000))
    global WU_FEE_WAIVED; WU_FEE_WAIVED = bool(cfg.get("assume_wu_app_fee_waived", True))
    def load(n, d):
        try: return json.load(open(os.path.join(a.prev, n)))
        except Exception: return d
    prev = load("latest.json", {}); hist = load("history.json", {}); state = load("alert-state.json", {})
    prev_q = {q["id"]: q for q in prev.get("quotes", [])}

    quotes, banks, mid, errors = [], prev.get("banks", []), None, {}
    try:
        w = wise_comparison(int(amount)); quotes.append(w["wise"]); banks = w["_banks"] or banks; mid = w["_mid"]
    except Exception as e: errors["wise"] = str(e)[:200]
    for pid, fn in [("westernunion", western_union), ("instarem", instarem), ("moneymatch", moneymatch), ("eremit", eremit), ("worldremit", worldremit)]:
        try: quotes.append(fn(amount))
        except Exception as e: errors[pid] = str(e)[:200]
    have = {q["id"] for q in quotes}
    for pid, msg in errors.items():  # keep last good value, clearly marked stale
        if pid in have: continue
        old = prev_q.get(pid)
        if old and old.get("ok"): old = dict(old, stale=True, error=msg); quotes.append(old)
        else: quotes.append({"id": pid, "ok": False, "error": msg, "fetched_at": now_iso()})
    try:
        m = wise_mid(); mid = {**(mid or {}), **m}
    except Exception as e: errors["mid"] = str(e)[:200]
    if mid and "gbp_myr" not in mid and mid.get("myr_gbp"): mid["gbp_myr"] = 1 / mid["myr_gbp"]
    if not mid: mid = prev.get("mid")

    # history: daily closes refreshed hourly; intraday mid + best all-in every run (last 3 days)
    now = time.time()
    if not hist.get("daily") or now - hist.get("daily_fetched_ts", 0) > 3600:
        try: h = daily_history(); hist["daily"] = h["rows"]; hist["daily_source"] = h["source"]; hist["daily_fetched_ts"] = now
        except Exception as e: errors["history"] = str(e)[:200]
    best = best_quote(quotes, cfg.get("instant_only"), meta)
    intr = [p for p in hist.get("intraday", []) if now - p[0] < 3 * 86400]
    if mid: intr.append([int(now), round(mid["gbp_myr"], 5), best["all_in_gbp"] if best else None, best["id"] if best else None])
    hist["intraday"] = intr

    hour_myt = dt.datetime.now(MYT).hour
    send, reason, new_state = decide_alert(best, cfg, state, now, hour_myt)
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    alert_log = {"checked_at": now_iso(), "decision": reason, "sent": False}
    if send and topic and not a.no_alert:
        try: send_ntfy(topic, best, cfg, meta, reason, mid["gbp_myr"]); alert_log["sent"] = True; print("ALERT SENT:", reason)
        except Exception as e: alert_log["error"] = str(e)[:200]; new_state = state; print("alert failed:", e)
    elif send: alert_log["decision"] = reason + " (no topic configured; not sent)"; new_state = state
    new_state["last_check"] = alert_log

    latest = {"generated_at": now_iso(), "amount_myr": amount, "mid": mid, "quotes": quotes, "banks": banks,
              "best_id": best["id"] if best else None, "errors": errors,
              "target": {k: cfg.get(k) for k in ("target_gbp", "target_note", "alert_metric", "assume_wu_app_fee_waived", "instant_only", "min_improvement_gbp", "repeat_after_hours", "quiet_hours_myt")},
              "alert": {k: new_state.get(k) for k in ("above", "last_value", "last_sent_at", "last_provider", "last_reason", "last_check")}}
    for n, d in [("latest.json", latest), ("history.json", hist), ("alert-state.json", new_state)]:
        json.dump(d, open(os.path.join(a.out, n), "w"), separators=(",", ":"))
    for q in sorted([q for q in quotes if q.get("ok")], key=lambda q: -q["all_in_gbp"]):
        print(f"  {q['id']:13s} rate {q['rate']:.6f} fee {q['fee_myr']:8.2f} get £{q['receive_gbp']:9,.2f} all-in £{q['all_in_gbp']:9,.2f}{' STALE' if q.get('stale') else ''}{' OVER CAP' if q.get('over_cap') else ''}")
    if errors: print("errors:", errors)
    print("alert:", alert_log)
    sig = lambda d: json.dumps([(q.get("id"), q.get("rate"), q.get("fee_myr"), q.get("ok")) for q in d.get("quotes", [])] + [(d.get("mid") or {}).get("gbp_myr")])
    print("CHANGED" if sig(latest) != sig(prev) or alert_log["sent"] or now - _ts(prev.get("generated_at")) > 1800 else "UNCHANGED")
    if not quotes or all(not q.get("ok") for q in quotes): sys.exit(1)

def _ts(s):
    try: return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception: return 0

if __name__ == "__main__": main()
