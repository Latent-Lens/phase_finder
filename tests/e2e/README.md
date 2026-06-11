# End-to-end driver

`drive_flow.py` launches the real app in headless Chromium (Playwright), loads
FCS files, runs analysis, and exercises the plot + Dean–Jett–Fox modeling.
It's a smoke driver, not a unit-test suite — it needs a browser and real data.

## One-time setup

The dev box has no browser/node by default, so install Playwright + Chromium
into a venv outside the repo:

```bash
python3 -m venv /tmp/flowvenv
/tmp/flowvenv/bin/pip install playwright
/tmp/flowvenv/bin/python -m playwright install chromium
```

## Run

Serve the static app, then drive it:

```bash
python3 -m http.server 8731                     # from the repo root
/tmp/flowvenv/bin/python tests/e2e/drive_flow.py
```

Flags: `--files N` (how many FCS files to load), `--data DIR` (FCS directory,
defaults to the lab sample set), `--url`, `--screenshot PATH`, `--headed`.
Exits non-zero if any structural check fails.

Screenshots and other generated artifacts are written to `results/`
(timestamped, e.g. `results/flow_e2e_20260611-143000.png`). That directory is
tracked but its contents are git-ignored.

## What it checks

- D3 / Levenberg–Marquardt / ml-gsd libraries load
- Plot title `Histogram of Events: n Samples, m Events`, y-axis `Number of Events`
- One curve per checked sample
- Unchecking a row removes its curve and updates the title, **without** dropping
  its loaded data; re-checking restores the curve
- Color-by / log-axis / bins controls don't error
- DJF fit produces a readout whose G1/S/G2M fractions sum to ~100%

Sample FCS data lives outside the repo (see the `--data` default).
