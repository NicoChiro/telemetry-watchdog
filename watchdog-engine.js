/* Telemetry Watchdog engine. The same steps as the notebook, written for the browser. */
var WatchdogEngine = (function () {
  'use strict';
  var Z_THRESHOLD = 3.5, MIN_DAYS = 5, ALPHA = 0.05, STEP_Z = 6, STEP_PCT = 15;
  var REGIONS = [{name: 'Los Angeles', lat: 34.05, lon: -118.25}, {name: 'New York', lat: 40.71, lon: -74.0}];
  var VARIABLES = [
    {key: 'PM2.5', test: /PM ?2[._]?5|PM25/i, unit: 'µg/m³', range: [0, 1000], grid: [0.625, 0.5],
     scale: function (m) { return m < 1e-3 ? 1e9 : 1; }, measures: 'ground level, model estimate'},
    {key: 'NO2', test: /NO2/i, unit: '10¹⁵ molecules/cm²', range: [-5, 200], grid: [0.25, 0.25],
     scale: function (m) { return m > 1e12 ? 1e-15 : 1; }, measures: 'whole air column, not ground level'},
    {key: 'AOD', test: /AOD|aerosol optical/i, unit: 'unitless', range: [-0.05, 5], grid: [1, 1],
     scale: function () { return 1; }, measures: 'whole air column, not ground level'}
  ];
  var WEIGHTS = {'source and footprint': 15, completeness: 20, continuity: 15, plausibility: 15, 'anomaly load': 15, 'trend stability': 20};

  function ok(x) { return x === x && x !== null; }
  function sign(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
  function median(a) {
    var v = []; for (var i = 0; i < a.length; i++) { if (ok(a[i])) { v.push(a[i]); } }
    if (!v.length) { return NaN; }
    v.sort(function (p, q) { return p - q; });
    var h = v.length >> 1; return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
  }
  function mean(a) { var s = 0, n = 0; for (var i = 0; i < a.length; i++) { if (ok(a[i])) { s += a[i]; n++; } } return n ? s / n : NaN; }
  function clip100(x) { return Math.min(100, Math.max(0, x)); }
  function round(x, d) { var f = Math.pow(10, d); return Math.round(x * f) / f; }
  function pTwoSided(z) {
    var x = Math.abs(z) / Math.SQRT2;
    if (x > 3) {
      var q = 1 / (2 * x * x);
      return Math.exp(-x * x) / (x * Math.sqrt(Math.PI)) * (1 - q + 3 * q * q - 15 * q * q * q + 105 * q * q * q * q);
    }
    var t = 1 / (1 + 0.3275911 * x);
    return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  }
  /* statistic over the window [i + lo, i + hi], like a pandas rolling window */
  function rolling(a, lo, hi, minPeriods, fn) {
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) {
      var w = [];
      for (var j = Math.max(0, i + lo); j <= Math.min(a.length - 1, i + hi); j++) { if (ok(a[j])) { w.push(a[j]); } }
      out[i] = w.length >= minPeriods ? fn(w) : NaN;
    }
    return out;
  }

  /* ---------------- STL, after Cleveland et al. 1990, same defaults as statsmodels ---------------- */
  function est(y, n, len, ideg, xs, nleft, nright, w, userw, rw) {
    var range = n - 1, h = Math.max(xs - nleft, nright - xs), j, a = 0, r;
    if (len > n) { h += Math.floor((len - n) / 2); }
    var h9 = 0.999 * h, h1 = 0.001 * h;
    for (j = nleft; j <= nright; j++) {
      w[j] = 0; r = Math.abs(j - xs);
      if (r <= h9) {
        if (r <= h1) { w[j] = 1; } else { var q = r / h; q = 1 - q * q * q; w[j] = q * q * q; }
        if (userw) { w[j] *= rw[j]; }
        a += w[j];
      }
    }
    if (a <= 0) { return NaN; }
    for (j = nleft; j <= nright; j++) { w[j] /= a; }
    if (h > 0 && ideg > 0) {
      a = 0; for (j = nleft; j <= nright; j++) { a += w[j] * j; }
      var b = xs - a, c = 0;
      for (j = nleft; j <= nright; j++) { c += w[j] * (j - a) * (j - a); }
      if (Math.sqrt(c) > 0.001 * range) { b /= c; for (j = nleft; j <= nright; j++) { w[j] *= (b * (j - a) + 1); } }
    }
    var ys = 0; for (j = nleft; j <= nright; j++) { ys += w[j] * y[j]; }
    return ys;
  }
  /* loess over a whole series, indices are 1 based inside like the original code */
  function ess(y, n, len, ideg, userw, rw, ys, w) {
    var i, v;
    if (n < 2) { ys[1] = y[1]; return; }
    if (len >= n) {
      for (i = 1; i <= n; i++) { v = est(y, n, len, ideg, i, 1, n, w, userw, rw); ys[i] = ok(v) ? v : y[i]; }
      return;
    }
    var nsh = (len + 1) >> 1, nleft = 1, nright = len;
    for (i = 1; i <= n; i++) {
      if (i > nsh && nright !== n) { nleft++; nright++; }
      v = est(y, n, len, ideg, i, nleft, nright, w, userw, rw); ys[i] = ok(v) ? v : y[i];
    }
  }
  function movingAverage(x, n, len) {  /* 1 based in, 1 based out of length n - len + 1 */
    var out = new Float64Array(n - len + 2), v = 0, i;
    for (i = 1; i <= len; i++) { v += x[i]; }
    out[1] = v / len;
    for (i = len + 1; i <= n; i++) { v += x[i] - x[i - len]; out[i - len + 1] = v / len; }
    return out;
  }
  function stl(values, period, seasonalWindow) {
    var n = values.length, np = period, ns = seasonalWindow, i, j, m;
    var nt = Math.ceil(1.5 * np / (1 - 1.5 / ns)); if (nt % 2 === 0) { nt++; }
    var nl = np + 1; if (nl % 2 === 0) { nl++; }
    var y = new Float64Array(n + 1); for (i = 0; i < n; i++) { y[i + 1] = values[i]; }
    var trend = new Float64Array(n + 1), season = new Float64Array(n + 1), rw = new Float64Array(n + 1).fill(1);
    var w1 = new Float64Array(n + 2 * np + 2), w2 = new Float64Array(n + 2 * np + 2), w3 = new Float64Array(n + 2 * np + 2);
    var wts = new Float64Array(n + 2 * np + 2), userw = false;
    var kmax = Math.floor((n - 1) / np) + 1;
    var sub = new Float64Array(kmax + 3), subw = new Float64Array(kmax + 3), subs = new Float64Array(kmax + 3), subwork = new Float64Array(kmax + 3);
    function oneStep() {
      for (var it = 0; it < 2; it++) {
        for (i = 1; i <= n; i++) { w1[i] = y[i] - trend[i]; }
        /* seasonal smoothing of every cycle subseries, extended by one period on both sides */
        for (j = 1; j <= np; j++) {
          var k = Math.floor((n - j) / np) + 1;
          for (i = 1; i <= k; i++) { sub[i] = w1[(i - 1) * np + j]; if (userw) { subw[i] = rw[(i - 1) * np + j]; } }
          var shifted = new Float64Array(k + 1);
          ess(sub, k, ns, 1, userw, subw, shifted, subwork);
          for (i = 1; i <= k; i++) { subs[i + 1] = shifted[i]; }
          var v = est(sub, k, ns, 1, 0, 1, Math.min(ns, k), subwork, userw, subw); subs[1] = ok(v) ? v : subs[2];
          v = est(sub, k, ns, 1, k + 1, Math.max(1, k - ns + 1), k, subwork, userw, subw); subs[k + 2] = ok(v) ? v : subs[k + 1];
          for (m = 1; m <= k + 2; m++) { w2[(m - 1) * np + j] = subs[m]; }
        }
        /* low pass filter of the extended seasonal series */
        var a = movingAverage(w2, n + 2 * np, np), b = movingAverage(a, n + np + 1, np), c = movingAverage(b, n + 2, 3);
        ess(c, n, nl, 1, false, w3, w1, wts);
        for (i = 1; i <= n; i++) { season[i] = w2[np + i] - w1[i]; }
        for (i = 1; i <= n; i++) { w1[i] = y[i] - season[i]; }
        ess(w1, n, nt, 1, userw, rw, trend, wts);
      }
    }
    var outer = 15, round_ = 0;
    while (true) {
      oneStep(); round_++;
      if (round_ > outer) { break; }
      var r = new Array(n);
      for (i = 1; i <= n; i++) { r[i - 1] = Math.abs(y[i] - trend[i] - season[i]); }
      var cmad = 6 * median(r), c9 = 0.999 * cmad, c1 = 0.001 * cmad;
      for (i = 1; i <= n; i++) {
        var d = r[i - 1];
        if (d <= c1) { rw[i] = 1; } else if (d <= c9) { var q = d / cmad; q = 1 - q * q; rw[i] = q * q; } else { rw[i] = 0; }
      }
      userw = true;
    }
    var out = new Array(n); for (i = 0; i < n; i++) { out[i] = trend[i + 1] + season[i + 1]; }
    return out;
  }

  /* ---------------- reading a Giovanni file ---------------- */
  function splitCsv(line) {
    var out = [], cur = '', quoted = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { quoted = !quoted; } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; } else { cur += ch; }
    }
    out.push(cur); return out;
  }
  function numbersIn(text) { var m = (text || '').match(/-?\d+(?:\.\d+)?/g); return m && m.length >= 4 ? m.slice(0, 4).map(Number) : null; }
  function parse(text, fileName) {
    var lines = text.split(/\r?\n/), meta = {file: fileName, title: '', variable_id: '', user_start: '', user_end: '', user_bbox: null, data_bbox: null, fill_value: null, reproduce_url: ''};
    var head = -1, simulated = false;
    for (var i = 0; i < Math.min(lines.length, 60); i++) {
      var cells = splitCsv(lines[i]), key = (cells[0] || '').trim().toLowerCase(), val = (cells[1] || '').trim();
      if (/simulat|synthetic/i.test(lines[i])) { simulated = true; }
      if (key === 'time') { head = i; meta.variable_id = val.replace(/^mean_/, ''); break; }
      if (key.indexOf('title') === 0) { meta.title = val; }
      else if (key.indexOf('user start') === 0) { meta.user_start = val; }
      else if (key.indexOf('user end') === 0) { meta.user_end = val; }
      else if (key.indexOf('user bounding') === 0) { meta.user_bbox = numbersIn(val); }
      else if (key.indexOf('data bounding') === 0) { meta.data_bbox = numbersIn(val); }
      else if (key.indexOf('url') === 0) { meta.reproduce_url = val; }
      else if (key.indexOf('fill value') === 0) { var f = parseFloat(val); if (ok(f)) { meta.fill_value = f; } }
    }
    if (simulated) { throw new Error('it looks like simulated data'); }
    if (head < 0 || !meta.variable_id || meta.reproduce_url.indexOf('giovanni.gsfc.nasa.gov') < 0) {
      throw new Error('it has no NASA Giovanni header, so its origin cannot be verified');
    }
    var rows = [];
    for (var j = head + 1; j < lines.length; j++) {
      var parts = lines[j].split(',');
      var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec((parts[0] || '').trim());
      if (!m) { continue; }
      rows.push({y: +m[1], m: +m[2], d: m[3] ? +m[3] : 1, v: parseFloat(parts[1])});
    }
    if (rows.length < 24) { throw new Error('it has fewer than 24 rows with a date'); }
    return {meta: meta, rows: rows};
  }
  /* display name of an unknown variable, taken from the Title line of the file header */
  function titleName(meta) {
    var t = (meta.title || '').replace(/^"|"$/g, '').replace(/^Time Series,\s*Area-Averaged of\s*/i, '');
    t = t.replace(/\s+(hourly|daily|8-daily|16-daily|monthly|yearly)\b.*$/i, '').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s+/g, ' ').trim();
    return t || meta.variable_id || 'Unnamed variable';
  }
  function describe(meta, fileName, typical) {
    var stem = fileName.replace(/\.csv$/i, ''), cut = stem.lastIndexOf('_');
    var probe = meta.title + ' ' + meta.variable_id + ' ' + stem, known = null;
    VARIABLES.forEach(function (k) { if (!known && k.test.test(probe)) { known = k; } });
    var info = known ? {variable: known.key, unit: known.unit, range: known.range, grid: known.grid, scale: known.scale(typical), measures: known.measures}
                     : {variable: titleName(meta), unit: 'native units', range: [-Infinity, Infinity], grid: null, scale: 1, measures: ''};
    if (!known) { throw new Error('its variable is not AOD, NO2 or PM2.5'); }
    /* the region comes from the box in the file header, the file name is only a label */
    info.region = null;
    if (meta.user_bbox) {
      var lon = (meta.user_bbox[0] + meta.user_bbox[2]) / 2, lat = (meta.user_bbox[1] + meta.user_bbox[3]) / 2, best = null;
      REGIONS.forEach(function (r) {
        var dist = Math.max(Math.abs(r.lat - lat), Math.abs(r.lon - lon));
        if (dist <= 3 && (!best || dist < best.dist)) { best = {name: r.name, dist: dist}; }
      });
      if (best) { info.region = best.name; }
    }
    if (!info.region && !meta.user_bbox) {
      var raw = cut > 0 ? stem.slice(cut + 1).replace(/-/g, ' ') : 'unknown';
      info.region = ({LA: 'Los Angeles', NY: 'New York'})[raw.toUpperCase()] || raw;
      info.region_from_name = true;
    }
    if (!REGIONS.some(function (r) { return r.name === info.region; })) {
      throw new Error(meta.user_bbox ? 'its box in the file header lies in neither Los Angeles nor New York' : 'its header names no box and its file name names neither Los Angeles nor New York');
    }
    return info;
  }

  /* ---------------- trend statistics ---------------- */
  function seasonalKendall(values, firstKey) {
    var y0 = Math.floor(firstKey / 12), y1 = Math.floor((firstKey + values.length - 1) / 12), n = y1 - y0 + 1, mat = [], g, h, i, j;
    for (i = 0; i < n; i++) { mat.push(new Array(12).fill(NaN)); }
    for (i = 0; i < values.length; i++) { var key = firstKey + i; mat[Math.floor(key / 12) - y0][key % 12] = ok(values[i]) ? values[i] : NaN; }
    var S = 0, varPlain = 0, slopes = [], nValid = new Array(12).fill(0), pairSigns = [], rankSums = [];
    for (g = 0; g < 12; g++) {
      var signs = [], rs = new Array(n).fill(0), cnt = 0, tieCount = {};
      for (i = 0; i < n; i++) { if (ok(mat[i][g])) { cnt++; tieCount[mat[i][g]] = (tieCount[mat[i][g]] || 0) + 1; } }
      nValid[g] = cnt;
      for (i = 0; i < n; i++) {
        for (j = i + 1; j < n; j++) {
          var a = mat[i][g], b = mat[j][g], both = ok(a) && ok(b), s = both ? sign(b - a) : 0;
          signs.push(s); S += s; rs[i] -= s; rs[j] += s;
          if (both) { slopes.push((b - a) / (j - i)); }
        }
      }
      var ties = 0; Object.keys(tieCount).forEach(function (k) { var t = tieCount[k]; ties += t * (t - 1) * (2 * t + 5); });
      varPlain += (cnt * (cnt - 1) * (2 * cnt + 5) - ties) / 18;
      pairSigns.push(signs); rankSums.push(rs);
    }
    var cov = 0;
    for (g = 0; g < 12; g++) {
      for (h = g + 1; h < 12; h++) {
        var k = 0, rr = 0;
        for (i = 0; i < pairSigns[g].length; i++) { k += pairSigns[g][i] * pairSigns[h][i]; }
        for (i = 0; i < n; i++) { rr += ((nValid[g] + 1 + rankSums[g][i]) / 2) * ((nValid[h] + 1 + rankSums[h][i]) / 2); }
        cov += 2 * (k + 4 * rr - n * (nValid[g] + 1) * (nValid[h] + 1)) / 3;
      }
    }
    var variance = varPlain + cov; if (!(variance > 0)) { variance = varPlain; }
    var z = (S === 0 || variance <= 0) ? 0 : (S - sign(S)) / Math.sqrt(variance);
    slopes.sort(function (p, q) { return p - q; });
    var c = 1.959964 * Math.sqrt(variance), N = slopes.length;
    var lo = Math.min(N - 1, Math.max(0, Math.floor((N - c) / 2) - 1)), hi = Math.min(N - 1, Math.max(0, Math.ceil((N + c) / 2)));
    return {slope: median(slopes), slope_low: slopes[lo], slope_high: slopes[hi], z: z, p_value: pTwoSided(z)};
  }
  function describeTrend(values, firstKey) {
    var out = seasonalKendall(values, firstKey), t = values.map(function (_, i) { return i / 12; });
    var start = median(values.map(function (v, i) { return ok(v) ? v - out.slope * t[i] : NaN; }));
    if (!(start > 0)) { start = median(values); }
    var first = median(values.slice(0, 36)), last = median(values.slice(-36));
    out.level_start = start; out.span_years = t[t.length - 1];
    out.observed_change_pct = first > 0 ? 100 * (last / first - 1) : NaN;
    return out;
  }
  function pettitt(x) {
    var keep = [], v = [], i;
    for (i = 0; i < x.length; i++) { if (ok(x[i])) { keep.push(i); v.push(x[i]); } }
    var n = v.length; if (n < 36) { return null; }
    var order = v.map(function (val, idx) { return idx; }).sort(function (a, b) { return v[a] - v[b]; }), ranks = new Array(n);
    for (i = 0; i < n;) {
      var j = i; while (j + 1 < n && v[order[j + 1]] === v[order[i]]) { j++; }
      for (var q = i; q <= j; q++) { ranks[order[q]] = (i + j) / 2 + 1; }
      i = j + 1;
    }
    var u = [], cum = 0, k = 0, best = -1;
    for (i = 0; i < n; i++) { cum += ranks[i]; u.push(2 * cum - (i + 1) * (n + 1)); }
    for (i = 0; i < n - 1; i++) { if (Math.abs(u[i]) > best) { best = Math.abs(u[i]); k = i; } }
    return {position: keep[k], p_value: Math.min(1, 2 * Math.exp(-6 * u[k] * u[k] / (n * n * n + n * n)))};
  }
  function largestStep(values, firstKey) {
    var byMonth = []; for (var m = 0; m < 12; m++) { byMonth.push([]); }
    values.forEach(function (v, i) { if (ok(v)) { byMonth[(firstKey + i) % 12].push(v); } });
    var clim = byMonth.map(median);
    var anomaly = values.map(function (v, i) { return ok(v) ? v - clim[(firstKey + i) % 12] : NaN; });
    var before = rolling(anomaly, -11, 0, 8, median), after = rolling(anomaly, 1, 12, 8, median);
    var centre = rolling(anomaly, -6, 6, 7, median);
    var wiggle = anomaly.map(function (v, i) { return ok(v) && ok(centre[i]) ? v - centre[i] : NaN; });
    var wm = median(wiggle), sigma = 1.4826 * median(wiggle.map(function (v) { return ok(v) ? Math.abs(v - wm) : NaN; }));
    if (!(sigma > 0)) { return null; }
    var bestZ = -1, at = -1, step = 0;
    for (var i = 0; i < values.length; i++) {
      if (!ok(before[i]) || !ok(after[i])) { continue; }
      var s = after[i] - before[i], z = s / (sigma * 1.2533 * Math.sqrt(2 / 12));
      if (Math.abs(z) > bestZ) { bestZ = Math.abs(z); at = i; step = s; }
    }
    if (at < 0) { return null; }
    var level = median(values), key = firstKey + at + 1;
    return {month: Math.floor(key / 12) + '-' + ('0' + (key % 12 + 1)).slice(-2), z: step / (sigma * 1.2533 * Math.sqrt(2 / 12)), step_pct: level ? 100 * step / level : NaN};
  }

  /* ---------------- the whole pipeline for one file ---------------- */
  function dayNumber(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 86400000); }
  function analyze(fileName, text) {
    var parsed = parse(text, fileName), meta = parsed.meta, rows = parsed.rows, i;
    var gaps = [], sorted = rows.slice().sort(function (a, b) { return dayNumber(a.y, a.m, a.d) - dayNumber(b.y, b.m, b.d); });
    for (i = 1; i < sorted.length; i++) { gaps.push(dayNumber(sorted[i].y, sorted[i].m, sorted[i].d) - dayNumber(sorted[i - 1].y, sorted[i - 1].m, sorted[i - 1].d)); }
    var monthly = median(gaps) >= 25, audit = {rows_in_file: rows.length, duplicate_dates: 0, fill_values: 0, unreadable_values: 0};
    function stepOf(r) { return monthly ? r.y * 12 + r.m - 1 : dayNumber(r.y, r.m, r.d); }
    var first = stepOf(sorted[0]), last = stepOf(sorted[sorted.length - 1]), nSteps = last - first + 1;
    var series = new Array(nSteps).fill(NaN), seen = new Array(nSteps).fill(false), fill = meta.fill_value;
    sorted.forEach(function (r) {
      var k = stepOf(r) - first;
      if (seen[k]) { audit.duplicate_dates++; return; }
      seen[k] = true;
      if (!ok(r.v)) { audit.unreadable_values++; return; }
      if (r.v <= -9000 || Math.abs(r.v) >= 1e29 || (fill !== null && Math.abs(r.v - fill) <= 1e-6 * Math.abs(fill))) { audit.fill_values++; return; }
      series[k] = r.v;
    });
    audit.missing_rows = seen.filter(function (s) { return !s; }).length;
    var info = describe(meta, fileName, median(series.map(function (v) { return ok(v) ? Math.abs(v) : NaN; })));
    var tol = isFinite(info.range[1] - info.range[0]) ? 1e-4 * (info.range[1] - info.range[0]) : 0;
    audit.implausible_values = 0;
    series = series.map(function (v) {
      if (!ok(v)) { return NaN; }
      v *= info.scale;
      if (v < info.range[0] - tol || v > info.range[1] + tol) { audit.implausible_values++; return NaN; }
      return v;
    });
    var valid = series.filter(ok).length;
    if (valid < 24) { throw new Error('fewer than 24 valid values remain after cleaning'); }
    audit.cadence = monthly ? 'monthly' : 'daily'; audit.expected_steps = nSteps; audit.valid_values = valid;
    audit.coverage_pct = round(100 * valid / nSteps, 1);
    var run = 0, longest = 0; series.forEach(function (v) { if (ok(v)) { run = 0; } else { run++; if (run > longest) { longest = run; } } });
    audit.longest_gap = longest;

    /* month index of every step, days per month */
    function monthKeyOfStep(k) { if (monthly) { return first + k; } var d = new Date((first + k) * 86400000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    var mk0 = monthKeyOfStep(0), nMonths = monthKeyOfStep(nSteps - 1) - mk0 + 1, stepMonth = new Array(nSteps);
    var daysValid = new Array(nMonths).fill(0);
    for (i = 0; i < nSteps; i++) { stepMonth[i] = monthKeyOfStep(i) - mk0; if (ok(series[i])) { daysValid[stepMonth[i]]++; } }
    var usable = daysValid.filter(function (c) { return c >= (monthly ? 1 : MIN_DAYS); }).length;
    audit.usable_months_pct = round(100 * usable / nMonths, 1);
    function dateOfStep(k) { var mkey = monthKeyOfStep(k); if (monthly) { return Date.UTC(Math.floor(mkey / 12), mkey % 12, 1); } return (first + k) * 86400000; }
    var hs = Date.parse(meta.user_start), he = Date.parse(meta.user_end);
    audit.period_matches_header = ok(hs) && ok(he) && Math.abs(dateOfStep(0) - hs) <= 31 * 86400000 && Math.abs(he - dateOfStep(nSteps - 1)) <= 31 * 86400000;
    audit.footprint_ok = true; audit.footprint_note = 'not stated in the header'; audit.grid_cells = NaN;
    if (!meta.user_bbox || !meta.data_bbox) { audit.footprint_ok = false; } else {
      var u = meta.user_bbox, d = meta.data_bbox;
      if (info.grid) { audit.grid_cells = (Math.round((d[2] - d[0]) / info.grid[0]) + 1) * (Math.round((d[3] - d[1]) / info.grid[1]) + 1); }
      var clon = (d[0] + d[2]) / 2, clat = (d[1] + d[3]) / 2, inside = u[0] <= clon && clon <= u[2] && u[1] <= clat && clat <= u[3];
      var sizeText = ok(audit.grid_cells) ? 'average of ' + audit.grid_cells + (audit.grid_cells === 1 ? ' grid cell' : ' grid cells') : 'area average';
      if (inside) { audit.footprint_note = sizeText + ' inside the requested box'; } else {
        audit.footprint_ok = false;
        audit.footprint_note = sizeText + ' whose centre (' + Math.abs(clat).toFixed(2) + '°' + (clat >= 0 ? 'N' : 'S') + ' ' + Math.abs(clon).toFixed(2) + '°' + (clon < 0 ? 'W' : 'E') + ') lies outside the requested box';
      }
    }

    /* flagging on an asinh scale against the seasonal level */
    var period = monthly ? 12 : 365, scale = median(series);
    if (!(scale > 0)) { scale = median(series.map(function (v) { return ok(v) ? Math.abs(v - scale) : NaN; })) || 1; }
    var t = series.map(function (v) { return ok(v) ? Math.asinh(v / scale) : NaN; }), filled = t.slice(), prev = -1;
    for (i = 0; i < nSteps; i++) {
      if (!ok(t[i])) { continue; }
      if (prev < 0) { for (var a0 = 0; a0 < i; a0++) { filled[a0] = t[i]; } }
      else { for (var b0 = prev + 1; b0 < i; b0++) { filled[b0] = t[prev] + (t[i] - t[prev]) * (b0 - prev) / (i - prev); } }
      prev = i;
    }
    for (i = prev + 1; i < nSteps; i++) { filled[i] = t[prev]; }
    var baseline = stl(filled, period, 35);
    var resid = t.map(function (v, k) { return ok(v) ? v - baseline[k] : NaN; });
    var centre = median(resid), mad = median(resid.map(function (v) { return ok(v) ? Math.abs(v - centre) : NaN; }));
    var lo = monthly ? -6 : -15, hi = monthly ? 5 : 14;
    var rollMed = rolling(resid, lo, hi, 8, median);
    var dev = resid.map(function (v, k) { return ok(v) && ok(rollMed[k]) ? Math.abs(v - rollMed[k]) : NaN; });
    var rollMad = rolling(dev, lo, hi, 8, median);
    var flag = new Array(nSteps).fill(false), flagged = 0, high = 0, low = 0;
    for (i = 0; i < nSteps; i++) {
      if (!ok(resid[i])) { continue; }
      var z1 = mad > 0 ? Math.abs(round(0.6745 * (resid[i] - centre) / mad, 2)) : 0;
      var z2 = ok(rollMad[i]) ? Math.abs(round(0.6745 * (resid[i] - rollMed[i]) / Math.max(rollMad[i], 0.5 * mad), 2)) : 0;
      if (z1 > Z_THRESHOLD || z2 > Z_THRESHOLD) {
        flag[i] = true; flagged++;
        if (series[i] >= scale * Math.sinh(baseline[i])) { high++; } else { low++; }
      }
    }
    audit.flagged = flagged; audit.flagged_pct = round(100 * flagged / valid, 2); audit.flagged_high = high; audit.flagged_low = low;

    /* monthly means with and without flagged values */
    function monthlyMeans(dropFlagged) {
      var sum = new Array(nMonths).fill(0), cnt = new Array(nMonths).fill(0);
      for (var k = 0; k < nSteps; k++) { if (ok(series[k]) && !(dropFlagged && flag[k])) { sum[stepMonth[k]] += series[k]; cnt[stepMonth[k]]++; } }
      return sum.map(function (s, m) { return cnt[m] >= (monthly ? 1 : MIN_DAYS) ? s / cnt[m] : NaN; });
    }
    var all = monthlyMeans(false), clean = monthlyMeans(true);
    var stats = {all: describeTrend(all, mk0), clean: describeTrend(clean, mk0), recent: null};
    var years = Math.floor((mk0 + nMonths - 1) / 12) - Math.floor(mk0 / 12) + 1;
    if (years >= 15) { stats.recent = describeTrend(all.slice(-120), mk0 + nMonths - Math.min(120, nMonths)); }
    var coverageShift = null;
    if (!monthly) {
      var byM = []; for (i = 0; i < 12; i++) { byM.push([]); }
      daysValid.forEach(function (c, m) { byM[(mk0 + m) % 12].push(c); });
      var med = byM.map(median), pt = pettitt(daysValid.map(function (c, m) { return c - med[(mk0 + m) % 12]; }));
      if (pt) {
        var cut = pt.position, before = mean(daysValid.slice(0, cut + 1)), after = mean(daysValid.slice(cut + 1)), key = mk0 + cut;
        coverageShift = {month: Math.floor(key / 12) + '-' + ('0' + (key % 12 + 1)).slice(-2), p_value: pt.p_value, days_before: before, days_after: after,
                         notable: pt.p_value < 0.01 && Math.abs(after - before) / Math.max(before, 1e-9) > 0.10};
      }
    }
    return {
      file: fileName, variable: info.variable, region: info.region, region_from_name: !!info.region_from_name, unit: info.unit, measures: info.measures, source: 'uploaded',
      first_month: mk0, all: all, clean: clean, daily: monthly ? null : {first_day: first, values: series.map(function (v) { return ok(v) ? v : null; })}, stats: stats, audit: audit, step: largestStep(clean, mk0), coverage_shift: coverageShift,
      meta: {variable_id: meta.variable_id, user_bbox: meta.user_bbox, reproduce_url: meta.reproduce_url, has_fill: meta.fill_value !== null, is_giovanni: true}
    };
  }

  /* ---------------- verdicts for all datasets together ---------------- */
  function judge(datasets) {
    var tests = [];
    datasets.forEach(function (d) { ['all', 'clean', 'recent'].forEach(function (k) { if (d.stats[k]) { tests.push(d.stats[k]); } }); });
    var order = tests.map(function (_, i) { return i; }).sort(function (a, b) { return tests[a].p_value - tests[b].p_value; }), n = tests.length, running = 1;
    for (var r = n - 1; r >= 0; r--) { running = Math.min(running, tests[order[r]].p_value * n / (r + 1)); tests[order[r]].p_adjusted = Math.min(1, running); }
    tests.forEach(function (s) {
      s.significant = s.p_adjusted < ALPHA;
      s.direction = !s.significant ? 'no significant trend' : (s.slope > 0 ? 'increasing' : 'decreasing');
    });
    datasets.forEach(function (d) {
      var a = d.stats.all, c = d.stats.clean, rec = d.stats.recent, au = d.audit, notes = [];
      var half = Math.max((a.slope_high - a.slope_low) / 2, 1e-12), shift = round(Math.abs(a.slope - c.slope) / half, 2);
      var same = a.direction === c.direction, state;
      if (!rec) { state = 'record too short'; }
      else if (!a.significant) { state = 'no long term trend to compare with'; }
      else if (sign(rec.slope) !== sign(a.slope) && rec.significant) { state = 'reversed'; }
      else if (sign(rec.slope) === sign(a.slope) && Math.abs(rec.slope) >= 0.5 * Math.abs(a.slope)) { state = 'continues'; }
      else { state = 'flattened'; }
      var toPct = 100 / a.level_start;
      d.verdict = {
        robust: same && shift < 0.5, shift: shift, recent: state,
        change: ok(a.observed_change_pct) ? a.observed_change_pct : a.slope * a.span_years * toPct,
        along_line: a.slope * a.span_years * toPct,
        per_decade: 10 * a.slope, per_decade_low: 10 * a.slope_low, per_decade_high: 10 * a.slope_high
      };
      d.verdict.label = !a.significant ? 'no clear trend' : (d.verdict.robust ? 'significant' : 'borderline');
      d.verdict.move = !a.significant ? 'flat' : (a.slope < 0 ? 'down' : 'up');
      var source = 100;
      if (!d.meta.is_giovanni) { source -= 60; notes.push('origin not verified'); }
      if (!d.meta.has_fill) { source -= 10; notes.push('no fill value stated'); }
      if (!au.period_matches_header) { source -= 10; notes.push('period differs from the header'); }
      if (!au.footprint_ok) { source -= 40; notes.push(au.footprint_note); }
      var continuity = au.usable_months_pct;
      if (d.coverage_shift && d.coverage_shift.notable) {
        continuity -= 20;
        notes.push('valid days per month went from ' + d.coverage_shift.days_before.toFixed(0) + ' to ' + d.coverage_shift.days_after.toFixed(0) + ' around ' + d.coverage_shift.month);
      }
      var bad = au.implausible_values + au.duplicate_dates + au.unreadable_values;
      var plaus = 100 - 2000 * bad / Math.max(au.valid_values + bad, 1);
      if (d.step && Math.abs(d.step.z) > STEP_Z && Math.abs(d.step.step_pct) > STEP_PCT) { plaus -= 20; notes.push('abrupt step of ' + d.step.step_pct.toFixed(0) + ' % around ' + d.step.month); }
      var stability = 100 - 100 * shift;
      if (!same) { stability = Math.min(stability, 40); notes.push('verdict changes when flagged values are removed'); }
      if (state === 'reversed') { stability -= 25; notes.push('the last ten years run against the long term trend'); }
      else if (state === 'flattened') { notes.push('the trend has flattened during the last ten years'); }
      var scores = {'source and footprint': clip100(source), completeness: clip100(au.coverage_pct / 0.8), continuity: clip100(continuity),
                    plausibility: clip100(plaus), 'anomaly load': clip100(100 - (au.flagged_pct - 2) * 10), 'trend stability': clip100(stability)};
      var total = 0; Object.keys(WEIGHTS).forEach(function (k) { total += scores[k] * WEIGHTS[k]; }); total /= 100;
      d.trust = {scores: scores, total: total, grade: total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : 'D', notes: notes};
    });
    return datasets;
  }

  /* ---------- event cross-check, the same steps as event_crosscheck.py ---------- */
  var XC = {limit: 3.5, minDays: 5,
            SUPPORTED: 'in both sources, supported by a second source',
            ONLY_AOD_ISOLATED: 'single isolated day only in AOD, check for a retrieval problem',
            ONLY_AOD_RUN: 'only in AOD, not confirmed by the monthly model value',
            ONLY_PM: 'only in PM2.5 (model), not seen by the satellite',
            PM_NO_AOD: 'PM2.5 unusual, no AOD data that month'};
  function robustByMonth(values, monthOf) {
    var groups = [], i; for (i = 0; i < 12; i++) { groups.push([]); }
    values.forEach(function (v, k) { if (ok(v)) { groups[monthOf(k)].push(v); } });
    var centre = groups.map(median), spread = groups.map(function (g, m) { return median(g.map(function (v) { return Math.abs(v - centre[m]); })) * 1.4826; });
    return values.map(function (v, k) { var m = monthOf(k); return ok(v) && spread[m] > 0 ? (v - centre[m]) / spread[m] : NaN; });
  }
  function crossCheck(aod, pm, top) {
    var first = aod.daily.first_day, vals = aod.daily.values.map(function (v) { return ok(v) ? v : NaN; }), n = vals.length, k;
    var dates = vals.map(function (_, i) { return new Date((first + i) * 86400000); });
    var keyOf = dates.map(function (d) { return d.getUTCFullYear() * 12 + d.getUTCMonth(); });
    var zDay = robustByMonth(vals, function (i) { return dates[i].getUTCMonth(); });
    var months = {};
    for (k = 0; k < n; k++) {
      if (!ok(vals[k])) { continue; }
      var m = months[keyOf[k]] || (months[keyOf[k]] = {count: 0, sum: 0, max: -Infinity, peak: -1, peakZ: NaN, high: 0});
      m.count++; m.sum += vals[k];
      if (vals[k] > m.max) { m.max = vals[k]; m.peak = k; }
      if (ok(zDay[k])) { if (!ok(m.peakZ) || zDay[k] > m.peakZ) { m.peakZ = zDay[k]; } if (zDay[k] > XC.limit) { m.high++; } }
    }
    var keys = Object.keys(months).map(Number).sort(function (a, b) { return a - b; });
    var withMean = keys.filter(function (key) { return months[key].count >= XC.minDays; });
    var zMonth = robustByMonth(withMean.map(function (key) { return months[key].sum / months[key].count; }), function (i) { return withMean[i] % 12; });
    withMean.forEach(function (key, i) { months[key].mean = months[key].sum / months[key].count; months[key].zMonth = zMonth[i]; });
    function isolated(i) {
      var high = 0, valid = 0;
      for (var j = i - 1; j <= i + 1; j++) { if (j >= 0 && j < n && ok(vals[j])) { valid++; if (zDay[j] > XC.limit) { high++; } } }
      return high <= 1 && valid >= 2;
    }
    var pmVals = pm.all.map(function (v) { return ok(v) ? v : NaN; });
    var zPm = robustByMonth(pmVals, function (i) { return (pm.first_month + i) % 12; }), rows = [];
    function best(a, b) { return ok(a) && ok(b) ? Math.max(a, b) : (ok(a) ? a : b); }
    pmVals.forEach(function (v, i) {
      if (!ok(v)) { return; }
      var key = pm.first_month + i, m = months[key], zA = m ? best(m.zMonth, m.peakZ) : NaN;
      var aHigh = zA > XC.limit, pHigh = zPm[i] > XC.limit, iso = m ? isolated(m.peak) : false, verdict = '';
      if (aHigh && pHigh) { verdict = XC.SUPPORTED; } else if (aHigh && iso) { verdict = XC.ONLY_AOD_ISOLATED; } else if (aHigh) { verdict = XC.ONLY_AOD_RUN; } else if (pHigh) { verdict = m ? XC.ONLY_PM : XC.PM_NO_AOD; }
      if (!verdict) { return; }
      rows.push({month_key: key, month: Math.floor(key / 12) + '-' + ('0' + (key % 12 + 1)).slice(-2),
                 aod_month_mean: m && ok(m.mean) ? m.mean : null, aod_peak_day: m ? dates[m.peak].toISOString().slice(0, 10) : null,
                 aod_peak_value: m ? m.max : null, aod_valid_days: m ? m.count : 0, aod_unusual_days: m ? m.high : 0, peak_isolated: iso,
                 z_aod: zA, pm25: v, z_pm25: zPm[i], verdict: verdict, strength: best(zA, zPm[i])});
    });
    rows.sort(function (a, b) { return b.strength - a.strength; });
    rows = rows.slice(0, top || 10);
    function count(text) { return rows.filter(function (r) { return r.verdict === text; }).length; }
    return {rows: rows, summary: count(XC.SUPPORTED) + ' supported by both sources, ' + count(XC.ONLY_AOD_ISOLATED) + ' isolated day only in AOD, ' +
            count(XC.ONLY_AOD_RUN) + ' only in AOD and not confirmed, ' + count(XC.ONLY_PM) + ' only in PM2.5'};
  }

  return {analyze: analyze, judge: judge, stl: stl, weights: WEIGHTS, regions: REGIONS, crossCheck: crossCheck, crossText: XC};
})();
if (typeof module !== 'undefined') { module.exports = WatchdogEngine; }
