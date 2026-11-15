# Telemetry Watchdog

**Trend Detectives: Ethical Hackers in Space** · NASA Space Apps Challenge 2026 · *Be An Earth System Trend Detective!*

Check NASA data before trusting the trend. Telemetry Watchdog is a trust checker and trend detector for NASA open data. Before it reports a trend, it audits the data the way a security analyst audits logs: it flags impossible values, sudden spikes and missing dates, records a SHA-256 fingerprint of every input file, and then tests whether the trend still holds **without** the flagged records.

## 📊 Live report

**[Open the dashboard → nicochiro.github.io/telemetry-watchdog](https://nicochiro.github.io/telemetry-watchdog/)**

The report is a single self-contained file (`index.html`). You can also download it and open it in any browser, no internet needed.

### Open the report on your computer

1. Click **Code → Download ZIP** on this page and unzip it.
2. In that folder, run:

   ```
   python Telemetry_WatchDog.py
   ```

   It opens `dashboard.html` or `index.html` in your default browser. To open a different report: `python Telemetry_WatchDog.py my_report.html`

Needs Python 3.8 or newer. No extra packages. For safety, the script only opens existing `.html`/`.htm` files, uses a `file://` URL and never runs shell commands.

## Results, 2005–2025 (Los Angeles and New York City)

| Variable | Region | Trust score | Trend per decade | Significant? | With vs. without flags |
|---|---|---|---|---|---|
| NO₂ (OMI) | Los Angeles | 99.47% | −40.60% | Yes (p < 0.001) | Robust |
| NO₂ (OMI) | New York City | 99.53% | −41.86% | Yes (p < 0.001) | Robust |
| AOD (MODIS) | Los Angeles | 99.42% | −8.56% | Yes (p < 0.001) | Robust |
| AOD (MODIS) | New York City | 91.03% | −15.04% | Yes (p < 0.001) | Robust |
| PM2.5 (MERRA-2) | Los Angeles | 96.55% | +3.92% | Yes (p = 0.001) | Robust |
| PM2.5 (MERRA-2) | New York City | 100.00% | −2.79% | Yes (p = 0.031) | Robust |

“Robust” means the conclusion is the same with and without the flagged records.

## How it works

1. **Read** each NASA Giovanni CSV, including the fill value (“no data”) from the file header.
2. **Check integrity:** missing dates, duplicate or out-of-order dates, values outside the valid range, extreme values (more than 8 robust standard deviations from the usual level for that calendar month) and isolated one-day spikes.
3. **Fingerprint** every file with SHA-256, so any later change to the data is detected.
4. **Score trust:** the percentage of measured values with no flag, plus coverage (share of days or months with a measurement).
5. **Detect trends** with the seasonal Mann-Kendall test and Sen's slope on monthly means, run twice: with all data and without flagged records.

A flag is a prompt for review, not proof of error. Real wildfire smoke can be flagged as extreme.

## Data

Area-averaged time series downloaded from [NASA Giovanni](https://giovanni.gsfc.nasa.gov/), January 2005 to September 2026:

| File | Variable | Source |
|---|---|---|
| `NO2_LA.csv`, `NO2_NY.csv` | NO₂ tropospheric column (daily) | OMI |
| `AOD_LA.csv`, `AOD_NY.csv` | Aerosol optical depth at 0.55 µm (daily) | MODIS |
| `PM2.5_LA.csv`, `PM2.5_NY.csv` | Surface PM2.5 (monthly) | MERRA-2 |
| `AIRS_LA.csv`, `AIRS_NY.csv` | Surface relative humidity (daily) | AIRS |
| `PBLH_LA.csv`, `PBLH_NY.csv` | Planetary boundary layer height (monthly) | MERRA-2 |

## Team

Trend Detectives: Ethical Hackers in Space, NASA Space Apps Challenge 2026, Los Angeles.
