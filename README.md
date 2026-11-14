# MYR → GBP Transfer Watch

Live dashboard ranking how many pounds RM30,000 buys today at Wise, Western Union, Instarem, MoneyMatch, Merchantrade eRemit and WorldRemit (plus manual entry for CIMB SpeedSend, BigPay, Sunway Money), after fees. Alerts when the best quote beats a target.

- **Live page:** https://moulisankar999.github.io/myr-gbp-transfer-watch/
- **Browser:** fetches public quote endpoints directly every 60 s (Wise, WU, MoneyMatch, eRemit, WorldRemit).
- **Checker:** `.github/workflows/scrape.yml` runs `scraper/scrape.py` every 10 min (self-chaining 7am–midnight MYT), writes `data/*.json` to the `data` branch, and pushes ntfy alerts using the `NTFY_TOPIC` repo secret.
- **Alert target:** edit `config.json` (`target_gbp`, `min_improvement_gbp`, `repeat_after_hours`, `quiet_hours_myt`).
- Not financial advice. Quotes are indicative; confirm in the provider's app before sending.
