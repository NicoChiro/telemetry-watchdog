
# -*- coding: utf-8 -*-
"""
telemetry_watchdog_python_clean.py  -  Telemetry Watchdog
Trend Detectives: Ethical Hackers in Space - NASA Space Apps Challenge 2026

Reads NASA Giovanni CSV files, calculates trust, coverage, anomalous values,
seasonal trend significance and change per decade, and writes an offline HTML report.
The report can be opened in the default web browser without running shell commands.

Usage:
    python telemetry_watchdog_python_clean.py                  (CSV files in the current folder)
    python telemetry_watchdog_python_clean.py --data data      (CSV files in the folder "data")
    python telemetry_watchdog_python_clean.py --open-only      (opens an existing report)

The dashboard opens in the default browser automatically (unless --no-open).

Install once:  pip install numpy pandas scipy plotly
"""

import argparse
import hashlib
import html
import json
import logging
import sys
import webbrowser
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from scipy.stats import norm

# ---------------------------------------------------------------------------
# Settings for each variable. Adding a variable needs no new code.
# ---------------------------------------------------------------------------
VARIABLES = {
    "NO2": {
        "name": "Nitrogen dioxide (NO\u2082), tropospheric column",
        "product": "OMI OMNO2d v004, 30% cloud screened, daily",
        "unit": "molecules/cm\u00b2",
        "scale": 1.0,
        "valid_min": 0.0,          # a negative amount of gas is impossible
        "valid_max": 1.0e17,
        "daily": True,
        "definition": "A gas made when fuel burns at high temperature, mainly in car "
                      "engines and power plants. A main ingredient of city smog.",
    },
    "AOD": {
        "name": "Aerosol optical depth (AOD) at 0.55 micron",
        "product": "MODIS-Aqua MYD08_D3 v6.1, Dark Target and Deep Blue combined, daily",
        "unit": "unitless",
        "scale": 1.0,
        "valid_min": 0.0,          # values from -0.05 to 0 are flagged as low confidence
        "valid_max": 5.0,
        "daily": True,
        "definition": "How much tiny particles in the air (smoke, dust, haze) block "
                      "sunlight. Higher means hazier air.",
    },
    "PM2.5": {
        "name": "Fine particulate matter (PM2.5) at the surface",
        "product": "MERRA-2 M2TMNXAER v5.12.4 (model), monthly",
        "unit": "\u00b5g/m\u00b3",
        "scale": 1.0e9,            # file unit is kg/m3; 1 kg/m3 = 10^9 micrograms/m3
        "valid_min": 0.0,
        "valid_max": 1000.0,
        "daily": False,
        "definition": "Particles smaller than 2.5 micrometers that can enter the lungs. "
                      "Independent model cross-check for AOD.",
    },
}

REGIONS = {
    "LA": ("Los Angeles", "-118.7, 33.6, -117.6, 34.4"),
    "NY": ("New York City", "-74.3, 40.5, -73.7, 41.0"),
}

TREND_START, TREND_END = 2005, 2025   # 2026 is incomplete, so it is left out
OUTLIER_Z = 8.0          # robust z-score above this is an extreme value
SPIKE_Z = 6.0            # one-day jump up AND down larger than this is a spike
MIN_DAYS_PER_MONTH = 3   # a monthly mean needs at least this many valid days
MAX_TABLE_ROWS = 40      # flagged records shown per dataset

log = logging.getLogger("watchdog")


# ---------------------------------------------------------------------------
# Module 1: safe file reader
# ---------------------------------------------------------------------------
def read_giovanni_csv(path):
    """Return (header dict, DataFrame with columns time, value). Raises ValueError."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    header, start = {}, None
    for i, line in enumerate(lines[:30]):
        if line.lower().startswith("time,"):
            start = i
            break
        if ":," in line:
            key, val = line.split(":,", 1)
            header[key.strip()] = val.strip().strip('"')
    if start is None:
        raise ValueError("no 'time,' header line found; not a Giovanni time series")

    fill = None
    for key, val in header.items():
        if key.startswith("Fill Value"):
            try:
                fill = float(val)
            except ValueError:
                raise ValueError(f"fill value is not a number: {val!r}")

    rows, errors = [], []
    for n, line in enumerate(lines[start + 1:], start=start + 2):
        if not line.strip():
            continue
        parts = line.split(",")
        if len(parts) != 2:
            errors.append(f"line {n}: expected 2 columns, found {len(parts)}")
            continue
        t = pd.to_datetime(parts[0].strip(), errors="coerce")
        v = pd.to_numeric(parts[1].strip(), errors="coerce")
        if pd.isna(t) or pd.isna(v):
            errors.append(f"line {n}: date or number cannot be read")
            continue
        rows.append((t, float(v), n))
    if not rows:
        raise ValueError("no readable data rows")
    df = pd.DataFrame(rows, columns=["time", "value", "line"])
    return header, fill, df, errors


# ---------------------------------------------------------------------------
# Module 2: integrity checker (SHA-256)
# ---------------------------------------------------------------------------
def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def check_fingerprint(path, digest, store):
    """Compare with the stored reference. The first run records the reference."""
    ref = store.get(path.name)
    if ref is None:
        store[path.name] = digest
        return "recorded", "First run: fingerprint recorded as the reference."
    if ref == digest:
        return "match", "Fingerprint matches the reference: the file has not changed."
    return "mismatch", "WARNING: fingerprint does not match the reference. The file changed after it was recorded."


# ---------------------------------------------------------------------------
# Module 3: data-quality engine
# ---------------------------------------------------------------------------
def robust_z(values, months):
    """How unusual each value is compared with the same calendar month in other years."""
    z = pd.Series(0.0, index=values.index)
    for m in range(1, 13):
        sel = months == m
        x = values[sel]
        if len(x) < 5:
            continue
        med = x.median()
        mad = (x - med).abs().median() * 1.4826
        if mad > 0:
            z[sel] = (x - med) / mad
    return z


def trust_score(unflagged_measurements, total_measurements):
    """Trust (%) = 100 * unflagged valid readings / all valid readings."""
    if total_measurements <= 0:
        return float("nan")
    return 100.0 * unflagged_measurements / total_measurements


def coverage_score(unique_measured_periods, expected_periods):
    """Coverage (%) = 100 * dates/months measured / expected dates/months."""
    if expected_periods <= 0:
        return float("nan")
    return 100.0 * unique_measured_periods / expected_periods


def is_significant(p_value, alpha=0.05):
    """A trend is statistically significant when p < alpha."""
    return bool(np.isfinite(p_value) and p_value < alpha)


def quality_check(df, fill, cfg):
    df = df.copy()
    df["reasons"] = [[] for _ in range(len(df))]

    def flag(mask, text):
        for i in df.index[mask]:
            df.at[i, "reasons"].append(text)

    is_fill = np.isclose(df["value"], fill, rtol=1e-6, atol=0) if fill is not None else np.zeros(len(df), bool)
    df["is_fill"] = is_fill
    df["value"] = df["value"] * cfg["scale"]
    valid = ~df["is_fill"]

    dup = df["time"].duplicated(keep="first")
    flag(dup, "Duplicate date")
    order = df["time"].diff().dt.days < 0
    flag(order, "Date out of order")

    low = valid & (df["value"] < cfg["valid_min"])
    flag(low, f"Below the valid minimum ({cfg['valid_min']:g}): physically impossible or retrieval noise")
    high = valid & (df["value"] > cfg["valid_max"])
    flag(high, f"Above the valid maximum ({cfg['valid_max']:g})")

    v = df.loc[valid, "value"]
    z = robust_z(v, df.loc[valid, "time"].dt.month)
    extreme = pd.Series(False, index=df.index)
    extreme[z.index] = z.abs() > OUTLIER_Z
    for i in df.index[extreme]:
        df.at[i, "reasons"].append(f"Extreme value: {z[i]:.0f} robust standard deviations from the usual level for this month. Could be a real event; review it")

    if cfg["daily"]:
        # Isolated one-day spike: a big jump up from the day before and back down the day after.
        s = df.loc[valid, ["time", "value"]].sort_values("time")
        d_prev = s["value"].diff()
        d_next = s["value"].diff(-1)
        gap_ok = (s["time"].diff().dt.days <= 2) & (s["time"].diff(-1).dt.days >= -2)
        spread = d_prev.abs().median() * 1.4826
        if spread > 0:
            spike = gap_ok & (d_prev / spread > SPIKE_Z) & (d_next / spread > SPIKE_Z)
            for i in spike[spike].index:
                df.at[i, "reasons"].append("Sudden jump: an isolated one-day spike, far above the days before and after")

    # Missing dates: rows that do not exist at all (different from fill values)
    freq = "D" if cfg["daily"] else "MS"
    full = pd.date_range(df["time"].min(), df["time"].max(), freq=freq)
    missing = full.difference(df["time"])
    gaps = []
    if len(missing):
        step = pd.Timedelta(days=1) if cfg["daily"] else None
        run = [missing[0]]
        for d in missing[1:]:
            contiguous = (d - run[-1] == step) if step else (d.to_period("M") - run[-1].to_period("M")).n == 1
            if contiguous:
                run.append(d)
            else:
                gaps.append((run[0], run[-1], len(run)))
                run = [d]
        gaps.append((run[0], run[-1], len(run)))

    df["flagged"] = df["reasons"].apply(len) > 0
    measured = int(valid.sum())
    clean = int((valid & ~df["flagged"]).sum())
    stats = {
        "rows": len(df),
        "fill": int(df["is_fill"].sum()),
        "measured": measured,
        "flagged": int((valid & df["flagged"]).sum()) + int((df["is_fill"] & df["flagged"]).sum()),
        "missing_dates": len(missing),
        "gaps": gaps,
        "coverage": coverage_score(df.loc[valid, "time"].nunique(), len(full)),
        "trust": trust_score(clean, measured),
    }
    return df, stats


# ---------------------------------------------------------------------------
# Module 4: trend analyzer
# ---------------------------------------------------------------------------
def monthly_series(df, cfg, drop_flagged):
    keep = ~df["is_fill"]
    if drop_flagged:
        keep &= ~df["flagged"]
    d = (df.loc[keep, ["time", "value"]]
           .groupby("time")["value"].mean().sort_index())
    if cfg["daily"]:
        g = d.resample("MS")
        m = g.mean().where(g.count() >= MIN_DAYS_PER_MONTH)
    else:
        m = d.resample("MS").mean()
    idx = pd.date_range(f"{TREND_START}-01-01", f"{TREND_END}-12-01", freq="MS")
    return m.reindex(idx)


def trend(monthly):
    """Seasonal Mann-Kendall test with tie correction, and seasonal Sen slope.

    Each January is compared only to other Januaries, etc. Sen's slopes
    are in value units per year. No external pymannkendall package needed.
    """
    x = monthly.to_numpy(dtype=float)
    if np.isfinite(x).sum() < 36:
        return None
    s_total = 0.0
    variance = 0.0
    slopes = []
    for month in range(12):
        season = x[month::12]
        years = np.arange(len(season))
        good = np.isfinite(season)
        vals = season[good]
        yrs = years[good]
        n = len(vals)
        if n < 2:
            continue
        diffs = vals[None, :] - vals[:, None]
        upper = np.triu_indices(n, k=1)
        changes = diffs[upper]
        s_total += np.sign(changes).sum()
        slopes.extend((changes / (yrs[None, :] - yrs[:, None])[upper]).tolist())
        _, ties = np.unique(vals, return_counts=True)
        tie_term = np.sum(ties * (ties - 1) * (2 * ties + 5))
        variance += (n * (n - 1) * (2 * n + 5) - tie_term) / 18.0
    if not slopes or variance <= 0:
        return None
    z = ((s_total - 1) / np.sqrt(variance) if s_total > 0 else
         (s_total + 1) / np.sqrt(variance) if s_total < 0 else 0.0)
    p = float(2 * norm.sf(abs(z)))
    slope = float(np.median(slopes))
    significant = is_significant(p)
    direction = ("Increasing" if s_total > 0 else "Decreasing") if significant else "No clear trend"
    mean = float(np.nanmean(x))
    per_decade = slope * 10
    return {
        "direction": direction,
        "p": p,
        "significant": significant,
        "per_decade": per_decade,
        "pct_decade": 100 * per_decade / mean if mean else float("nan"),
        "months": int(np.isfinite(x).sum()),
    }


def same_conclusion(a, b):
    if a is None or b is None:
        return None
    return a["significant"] == b["significant"] and (not a["significant"] or a["direction"] == b["direction"])


# ---------------------------------------------------------------------------
# Module 5: report generator
# ---------------------------------------------------------------------------
def fmt(x, unit=""):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "\u2013"
    ax = abs(x)
    s = f"{x:.2e}" if (ax >= 1e5 or (0 < ax < 1e-3)) else f"{x:.3g}"
    return f"{s} {unit}".strip()


def fmt_p(p):
    return "&lt; 0.001" if p < 0.001 else f"{p:.3f}"


def e(text):
    return html.escape(str(text))


def make_chart(df, mon_a, cfg, title, first):
    fig = go.Figure()
    v = df[~df["is_fill"]]
    ok, bad = v[~v["flagged"]], v[v["flagged"]]
    if cfg["daily"]:
        fig.add_trace(go.Scattergl(x=ok["time"], y=ok["value"], mode="markers", name="Daily value",
                                   marker=dict(size=3, color="rgba(70,110,170,0.35)")))
    fig.add_trace(go.Scatter(x=mon_a.index, y=mon_a.values, mode="lines", name="Monthly mean (all data)",
                             line=dict(color="#1f3b73", width=1.6), connectgaps=False))
    fig.add_trace(go.Scatter(x=bad["time"], y=bad["value"], mode="markers", name="Flagged record",
                             marker=dict(size=8, color="#d62728", symbol="x"),
                             text=["<br>".join(r) for r in bad["reasons"]],
                             hovertemplate="%{x|%Y-%m-%d}: %{y}<br>%{text}<extra></extra>"))
    fig.update_layout(title=title, height=380, margin=dict(l=60, r=20, t=50, b=40),
                      yaxis_title=cfg["unit"], template="plotly_white",
                      legend=dict(orientation="h", y=-0.15))
    return fig.to_html(full_html=False, include_plotlyjs="inline" if first else False)


def trend_cell(t, unit):
    if t is None:
        return "<td colspan='3'>Not enough data</td>"
    sig = "<b>Yes</b> (p &lt; 0.05)" if t["significant"] else "No (p \u2265 0.05)"
    return (f"<td>{e(t['direction'])}: {e(fmt(t['per_decade'], unit))} per decade "
            f"({t['pct_decade']:+.2f}%)</td><td>{fmt_p(t['p'])}</td><td>{sig}</td>")


def build_report(results, out_path, data_dir):
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    summary_rows, sections, first_chart = [], [], True
    for r in results:
        if "error" in r:
            summary_rows.append(f"<tr><td>{e(r['var'])}</td><td>{e(r['city'])}</td>"
                                f"<td colspan='7' class='bad'>File rejected: {e(r['error'])}</td></tr>")
            continue
        cfg, st, a, b = r["cfg"], r["stats"], r["trend_a"], r["trend_b"]
        same = same_conclusion(a, b)
        robust = ("\u2013" if same is None else
                  "<span class='good'>Robust: same conclusion</span>" if same else
                  "<span class='bad'>Data quality changes the answer</span>")
        summary_rows.append(
            f"<tr><td>{e(r['var'])}</td><td>{e(r['city'])}</td><td>{st['trust']:.2f}%</td>"
            f"<td>{st['coverage']:.0f}%</td>{trend_cell(a, cfg['unit'])}<td>{robust}</td>"
            f"<td class='{ 'bad' if r['fp_status']=='mismatch' else '' }'>{e(r['fp_status'])}</td></tr>")

        chart = make_chart(r["df"], r["mon_a"], cfg, f"{cfg['name']}, {r['city']}", first_chart)
        first_chart = False

        flagged = r["df"][r["df"]["flagged"]].sort_values("time")
        trows = "".join(
            f"<tr><td>{e(row.time.strftime('%Y-%m-%d'))}</td><td>{e(row.line)}</td>"
            f"<td>{e(fmt(row.value))}</td><td>{e('; '.join(row.reasons))}</td></tr>"
            for row in flagged.head(MAX_TABLE_ROWS).itertuples())
        more = (f"<p class='note'>Showing the first {MAX_TABLE_ROWS} of {len(flagged)} flagged records.</p>"
                if len(flagged) > MAX_TABLE_ROWS else "")
        gaps = st["gaps"]
        gap_text = ("None." if not gaps else
                    f"{st['missing_dates']} dates have no row at all, in {len(gaps)} gaps: " +
                    ", ".join(f"{g0:%Y-%m-%d} to {g1:%Y-%m-%d} ({n})" if n > 1 else f"{g0:%Y-%m-%d}"
                              for g0, g1, n in gaps[:8]) + (" \u2026" if len(gaps) > 8 else ""))

        def tline(label, t):
            if t is None:
                return f"<tr><td>{label}</td><td colspan='3'>Not enough data</td></tr>"
            return f"<tr><td>{label}</td>{trend_cell(t, cfg['unit'])}</tr>"

        source_url = str(r.get("url", ""))
        reproduction_link = (
            f"<a href='{e(source_url)}' rel='noopener noreferrer'>reproduce this data</a>"
            if source_url.startswith(("https://", "http://"))
            else "reproduction URL unavailable"
        )

        sections.append(f"""
<section>
  <h2>{e(cfg['name'])} \u00b7 {e(r['city'])}</h2>
  <p class='def'>{e(cfg['definition'])}</p>
  <div class='cards'>
    <div class='card'><div class='big'>{st['trust']:.2f}%</div>Trust score<br><small>measured values with no flag</small></div>
    <div class='card'><div class='big'>{st['coverage']:.0f}%</div>Coverage<br><small>days or months with a measurement</small></div>
    <div class='card'><div class='big'>{len(flagged)}</div>Flagged records</div>
    <div class='card {'badcard' if r['fp_status']=='mismatch' else ''}'><div class='big'>{e(r['fp_status'])}</div>SHA-256 fingerprint</div>
  </div>
  {chart}
  <h3>Trend, {TREND_START}\u2013{TREND_END}, with and without flagged records</h3>
  <table><tr><th>Version</th><th>Direction and size</th><th>p-value</th><th>Significant?</th></tr>
  {tline('A. All data', a)}{tline('B. Without flagged records', b)}</table>
  <p>{robust}</p>
  <h3>Data quality</h3>
  <p>{st['rows']} rows read \u00b7 {st['fill']} fill values (\u201cno data\u201d) \u00b7 {st['measured']} measurements \u00b7 {len(r['parse_errors'])} unreadable lines.</p>
  <p><b>Missing dates:</b> {e(gap_text)}</p>
  <p><b>Fingerprint:</b> {e(r['fp_message'])}<br><code>{e(r['sha'])}</code></p>
  <table class='flags'><tr><th>Date</th><th>CSV line</th><th>Value</th><th>Reason</th></tr>{trows}</table>{more}
  <p class='note'>Source: {e(cfg['product'])}. File: {e(r['file'])}. Region box (W, S, E, N): {e(REGIONS[r['reg']][1])}.
  Fill value in file header: {e(r['fill'])}. Giovanni link: {reproduction_link}.</p>
</section>""")

    page = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Telemetry Watchdog report</title>
<style>
 body{{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f4f6fa;color:#1d2433}}
 header{{background:#14254a;color:#fff;padding:22px 32px}} header h1{{margin:0;font-size:26px}}
 header p{{margin:4px 0 0;opacity:.85}}
 main{{max-width:1100px;margin:auto;padding:16px 24px}}
 section{{background:#fff;border-radius:10px;padding:18px 24px;margin:18px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}}
 h2{{color:#14254a;margin-top:0}} h3{{color:#2a4a8a;margin-bottom:6px}}
 table{{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}}
 th{{background:#14254a;color:#fff;text-align:left;padding:6px 8px}}
 td{{border-bottom:1px solid #e3e7ef;padding:6px 8px;vertical-align:top}}
 .flags td{{font-size:13px}}
 .cards{{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}}
 .card{{background:#eef2fa;border-radius:8px;padding:10px 16px;min-width:150px;text-align:center}}
 .badcard{{background:#fde4e4}} .big{{font-size:24px;font-weight:700;color:#14254a}}
 .good{{color:#1a7f37;font-weight:600}} .bad{{color:#c62828;font-weight:600}}
 .def{{font-style:italic;color:#4a5568}} .note{{font-size:12px;color:#5a6478}}
 code{{font-size:12px;word-break:break-all}}
</style></head><body>
<header><h1>Telemetry Watchdog</h1>
<p>A trust checker and trend detector for NASA open data \u00b7 Trend Detectives: Ethical Hackers in Space \u00b7 NASA Space Apps Challenge 2026</p>
<p>Report created {e(now)} from the files in \u201c{e(data_dir)}\u201d.</p></header>
<main>
<section><h2>Summary: what is changing, where, how much, and is it significant?</h2>
<p>Trend period {TREND_START}\u2013{TREND_END} (2026 is incomplete and left out). Seasonal Mann-Kendall test and Sen's slope on monthly means.
\u201cRobust\u201d means the conclusion is the same with and without the flagged records.</p>
<table><tr><th>Variable</th><th>Region</th><th>Trust score</th><th>Coverage</th><th>Trend (all data)</th><th>p-value</th><th>Significant?</th><th>With vs. without flags</th><th>Fingerprint</th></tr>
{''.join(summary_rows)}</table></section>
{''.join(sections)}
<section><h2>Calculation formulas</h2>
<p><b>Trust score (%)</b> = 100 &times; (number of valid, unflagged measurements) / (number of valid measurements).</p>
<p><b>Coverage (%)</b> = 100 &times; (number of unique days or months with measurements) / (number of expected days or months in the dataset date span).</p>
<p><b>Modified Z-score</b> = (value &minus; seasonal median) / (1.4826 &times; seasonal MAD), where MAD = median(|value &minus; seasonal median|).</p>
<p><b>Trend change per decade</b> = 10 &times; seasonal Sen slope (measurement units per year).</p>
<p><b>Percent change per decade</b> = 100 &times; change per decade / mean measurement.</p>
<p><b>Seasonal Mann-Kendall p-value</b> = 2 &times; P(Z &ge; |observed Z|) for a standard normal Z; the test compares the same calendar months across years and adjusts for ties.</p>
<p><b>Significant</b> if p &lt; 0.05. <b>Same conclusion</b> if the all-data and unflagged-only tests agree on significance and, when significant, direction.</p>
<p><b>SHA-256</b> is a cryptographic hash of the CSV file, compared against a locally stored reference; it is not a data-quality score.</p>
</section>
<section><h2>Method and limits</h2>
<ul>
<li><b>Checks:</b> fill values read from each file header; rows missing from the file; duplicate and out-of-order dates; values outside the valid range;
extreme values (more than {OUTLIER_Z:g} robust standard deviations from the usual level for that calendar month); isolated one-day spikes; SHA-256 fingerprint.</li>
<li><b>Trust score:</b> the percentage of measured values with no flag. <b>Coverage:</b> the percentage of expected days or months that have a measurement (gaps can have multiple causes).</li>
<li><b>Seasons:</b> the seasonal Mann-Kendall test compares each month only with the same month in other years, so summer-versus-winter swings are not mistaken for a trend.
Monthly means from daily data need at least {MIN_DAYS_PER_MONTH} valid days.</li>
<li><b>Significance:</b> p &lt; 0.05. A p-value above 0.05 does not mean there is no trend; a longer series may be needed.</li>
<li><b>Limits:</b> a flag is a prompt for review, not proof of error (real wildfire smoke can be flagged as extreme). A hash shows a file has not changed since the
reference was recorded; it does not prove where the file came from. A significant trend shows a consistent change, not its cause.
Nearby months are correlated, which can make p-values slightly too small.</li>
</ul></section>
</main></body></html>"""
    out_path.write_text(page, encoding="utf-8")


# ---------------------------------------------------------------------------
# Browser launcher: standard library only; no shell commands.
# ---------------------------------------------------------------------------
def open_report(report):
    report = Path(report).expanduser()
    if not report.is_file() or report.suffix.lower() not in (".html", ".htm"):
        print(f"Error: not an existing HTML report: {report}", file=sys.stderr)
        return 1
    try:
        opened = webbrowser.open(report.resolve(strict=True).as_uri())
    except (OSError, RuntimeError, webbrowser.Error) as exc:
        print(f"Browser error: {exc}", file=sys.stderr)
        return 1
    if not opened:
        print("Browser could not be launched automatically.", file=sys.stderr)
        return 1
    print(f"Opening {report.resolve()} in your browser.")
    return 0


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Telemetry Watchdog report generator")
    ap.add_argument("--data", default=".", help="folder with the Giovanni CSV files")
    ap.add_argument("--out", default="dashboard.html", help="report file to write")
    ap.add_argument("--no-open", action="store_true", help="generate the report without opening the browser")
    ap.add_argument("--open-only", action="store_true", help="open an existing HTML report without recalculating")
    args = ap.parse_args()

    out = Path(args.out).expanduser()
    if out.suffix.lower() not in (".html", ".htm"):
        ap.error("--out must end in .html or .htm")

    if args.open_only:
        if not out.is_file():
            print(f"Error: report not found: {out} (current folder: {Path.cwd()})", file=sys.stderr)
            return 1
        return open_report(out)

    data_dir = Path(args.data).expanduser()
    if not data_dir.is_dir():
        print(f"Error: CSV folder not found: {data_dir}", file=sys.stderr)
        return 1
    logging.basicConfig(filename="watchdog.log", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    fp_path = data_dir / "fingerprints.json"
    try:
        store = json.loads(fp_path.read_text()) if fp_path.exists() else {}
    except (OSError, ValueError):
        log.warning("fingerprints.json unreadable; starting a new one")
        store = {}

    results = []
    for var, cfg in VARIABLES.items():
        for reg, (city, _) in REGIONS.items():
            r = {"var": var, "city": city, "reg": reg}
            matches = sorted(data_dir.glob(f"*{var}_{reg}.csv"))
            if not matches:
                r["error"] = f"file {var}_{reg}.csv not found in {data_dir}"
                log.warning(r["error"])
                results.append(r)
                continue
            path = matches[0]
            try:
                header, fill, df, parse_errors = read_giovanni_csv(path)
                sha = sha256_of(path)
                fp_status, fp_message = check_fingerprint(path, sha, store)
                df, stats = quality_check(df, fill, cfg)
                mon_a = monthly_series(df, cfg, drop_flagged=False)
                mon_b = monthly_series(df, cfg, drop_flagged=True)
                r.update(cfg=cfg, df=df, stats=stats, file=path.name, sha=sha, fill=fill,
                         fp_status=fp_status, fp_message=fp_message, parse_errors=parse_errors,
                         url=header.get("URL to Reproduce Results", ""),
                         mon_a=mon_a, trend_a=trend(mon_a), trend_b=trend(mon_b))
                log.info("%s: %d rows, trust %.1f%%, fingerprint %s", path.name,
                         stats["rows"], stats["trust"], fp_status)
                for msg in parse_errors:
                    log.warning("%s %s", path.name, msg)
            except Exception as exc:          # never crash on a bad file
                r["error"] = f"{path.name}: {exc}"
                log.error(r["error"])
            results.append(r)

    try:
        fp_path.write_text(json.dumps(store, indent=2))
    except OSError as exc:
        log.warning("could not save fingerprints: %s", exc)

    out.parent.mkdir(parents=True, exist_ok=True)
    build_report(results, out, data_dir)

    print(f"\nTelemetry Watchdog: report written to {out.resolve()}\n")
    for r in results:
        if "error" in r:
            print(f"  {r['var']:6} {r['city']:14} REJECTED: {r['error']}")
            continue
        a, b = r["trend_a"], r["trend_b"]
        same = same_conclusion(a, b)
        ta = "not enough data" if a is None else f"{a['direction']}, {fmt(a['per_decade'], r['cfg']['unit'])}/decade, p={'<0.001' if a['p'] < 0.001 else round(a['p'], 3)}"
        print(f"  {r['var']:6} {r['city']:14} trust {r['stats']['trust']:6.2f}%  {ta}  "
              f"{'robust' if same else 'CHANGES without flags' if same is not None else ''}  [{r['fp_status']}]")
    if not args.no_open:
        if open_report(out):
            print(f"Report saved; open it manually: {out.resolve()}")
    else:
        print(f"Open the report manually: {out.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
