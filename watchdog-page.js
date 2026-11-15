/* Telemetry Watchdog page. Everything on the page is drawn from one list of datasets. */
(function () {
  'use strict';
  var E = WatchdogEngine, datasets = [];
  var REGION_ORDER = E.regions.map(function (r) { return r.name; });
  var COLOUR = {context: '#c9c8c2', soft: '#52514e', blue: '#2a78d6', orange: '#eb6834', ink: '#0b0b0b', grid: '#e1e0d9', surface: '#fcfcfb'};
  function ok(x) { return x === x && x !== null && x !== undefined; }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined) { n.textContent = text; } return n; }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function pct(x, digits) { return ok(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(digits || 0) + ' %' : 'n/a'; }
  function sig(x) { return ok(x) ? (x >= 0 ? '+' : '−') + Number(Math.abs(x).toPrecision(3)) : 'n/a'; }
  function pText(p) { return p < 0.001 ? '< 0.001' : p.toFixed(3); }
  function num(x) { return ok(x) ? Number(x).toLocaleString('en-US') : 'n/a'; }
  function unitText(u) { return (u === 'unitless' || u === 'native units') ? '' : ' ' + u; }
  function nameOf(d) { return d.variable + ' ' + d.region; }
  function sortKey(d) { var r = REGION_ORDER.indexOf(d.region); return (r < 0 ? 9 : r); }
  function variables() { var seen = []; datasets.forEach(function (d) { if (seen.indexOf(d.variable) < 0) { seen.push(d.variable); } }); return seen; }
  function regions() {
    var seen = REGION_ORDER.filter(function (r) { return datasets.some(function (d) { return d.region === r; }); });
    datasets.forEach(function (d) { if (seen.indexOf(d.region) < 0) { seen.push(d.region); } });
    return seen;
  }
  function find(variable, region) { for (var i = 0; i < datasets.length; i++) { if (datasets[i].variable === variable && datasets[i].region === region) { return datasets[i]; } } return null; }
  function mark(state, text) {
    var wrap = el('span'), dot = el('span', state, {ok: '✓', warn: '!', note: '·'}[state]);
    wrap.appendChild(dot); wrap.appendChild(document.createTextNode(' ' + text)); return wrap;
  }
  var STATE_OF = {significant: 'ok', borderline: 'warn', 'no clear trend': 'note'};
  var ARROW = {down: '↓', up: '↑', flat: '→'};
  var MOVE = {down: 'falls', up: 'rises', flat: 'shows no clear trend'};
  var LATELY = {continues: 'keeps going', flattened: 'has flattened', reversed: 'has turned around'};

  /* ---------- the conclusion, rewritten after every change ---------- */
  function describeOne(d) { return pct(d.verdict.change) + ', ' + d.verdict.label; }
  function conclusionLine(variable) {
    var here = regions().map(function (r) { return find(variable, r); }).filter(Boolean), li = el('li'), b = el('b', null, variable);
    li.appendChild(b);
    var text;
    if (here.length === 1) {
      text = ' ' + MOVE[here[0].verdict.move] + ' over ' + here[0].region + ' (' + describeOne(here[0]) + '). No second region is loaded for a comparison.';
    } else {
      var a = here[0], c = here[1], va = a.verdict, vc = c.verdict;
      if (va.move !== vc.move) {
        text = ' differs in direction. It ' + MOVE[va.move] + ' over ' + a.region + ' (' + describeOne(a) + ') and ' + MOVE[vc.move] + ' over ' + c.region + ' (' + describeOne(c) + ').';
      } else if (va.move === 'flat') {
        text = ' shows no clear trend in either region (' + pct(va.change) + ' and ' + pct(vc.change) + ').';
      } else {
        var gap = Math.abs(va.change - vc.change), stronger = Math.abs(va.change) >= Math.abs(vc.change) ? a : c, weaker = stronger === a ? c : a;
        text = ' ' + MOVE[va.move] + ' in both regions';
        text += gap >= 10 ? ', more strongly over ' + stronger.region + ' (' + pct(stronger.verdict.change) + ' against ' + pct(weaker.verdict.change) + ').'
                          : ', at a similar pace (' + pct(va.change) + ' over ' + a.region + ' and ' + pct(vc.change) + ' over ' + c.region + ').';
        if (va.label !== vc.label) {
          var solid = va.label === 'significant' ? a : c, shaky = solid === a ? c : a;
          text += ' The result is solid over ' + solid.region + ' and borderline over ' + shaky.region + '.';
        }
      }
      if (va.recent !== vc.recent && LATELY[va.recent] && LATELY[vc.recent]) {
        text += ' In the last ten years it ' + LATELY[va.recent] + ' over ' + a.region + ' and ' + LATELY[vc.recent] + ' over ' + c.region + '.';
      }
    }
    li.appendChild(document.createTextNode(text)); return li;
  }
  function renderConclusion() {
    var box = document.getElementById('conclusion'); clear(box);
    variables().forEach(function (v) { box.appendChild(conclusionLine(v)); });
    var solid = datasets.filter(function (d) { return d.verdict.label === 'significant'; }).length;
    box.appendChild(el('li', null, solid + ' of ' + datasets.length + ' trends are statistically significant and stay the same when flagged values are removed.'));
  }

  /* ---------- the comparison, one row per variable ---------- */
  function renderCompare() {
    var box = document.getElementById('compare'); clear(box);
    var cols = regions();
    var head = el('div', 'cmp-row cmp-head'); head.appendChild(el('div', 'cmp-var', ''));
    cols.forEach(function (r) { head.appendChild(el('div', 'cmp-cell-head', r)); });
    head.style.gridTemplateColumns = '150px repeat(' + cols.length + ', minmax(0, 1fr))'; box.appendChild(head);
    variables().forEach(function (v) {
      var row = el('div', 'cmp-row'); row.style.gridTemplateColumns = head.style.gridTemplateColumns;
      var first = cols.map(function (r) { return find(v, r); }).filter(Boolean)[0];
      var label = el('div', 'cmp-var'); label.appendChild(el('b', null, v)); label.appendChild(el('span', 'soft', first ? first.measures : '')); row.appendChild(label);
      cols.forEach(function (r) {
        var d = find(v, r), cell = el('div', 'cmp-cell');
        if (!d) { cell.classList.add('empty'); cell.textContent = 'not loaded'; row.appendChild(cell); return; }
        cell.classList.add('is-' + STATE_OF[d.verdict.label]);
        var big = el('div', 'cmp-big', ARROW[d.verdict.move] + ' ' + pct(d.verdict.change));
        var line = el('div', 'cmp-line'); line.appendChild(mark(STATE_OF[d.verdict.label], d.verdict.label));
        var extra = [];
        if (d.verdict.recent === 'flattened' || d.verdict.recent === 'reversed') { extra.push(d.verdict.recent + ' lately'); }
        extra.push('trust ' + d.trust.grade + ' ' + d.trust.total.toFixed(0));
        if (d.source === 'uploaded') { extra.push('uploaded'); }
        cell.appendChild(big); cell.appendChild(line); cell.appendChild(el('div', 'soft cmp-small', extra.join(' · ')));
        row.appendChild(cell);
      });
      box.appendChild(row);
    });
  }

  /* ---------- menus, plots, table ---------- */
  function fillSelect(id, values, everything) {
    var select = document.getElementById(id), keep = select.value || 'all'; clear(select);
    var first = el('option', null, everything); first.value = 'all'; select.appendChild(first);
    values.forEach(function (v) { var o = el('option', null, v); o.value = v; select.appendChild(o); });
    select.value = values.indexOf(keep) >= 0 ? keep : 'all';
  }
  function chosen(d) {
    var v = document.getElementById('pick-variable').value, r = document.getElementById('pick-region').value;
    return (v === 'all' || d.variable === v) && (r === 'all' || d.region === r);
  }
  function headline(d) {
    var v = d.verdict, text = pct(v.change) + ' first 3 vs last 3 years';
    text += v.label === 'significant' ? ', significant' : v.label === 'borderline' ? ', borderline, driven by flagged values' : ', no significant trend';
    if (v.recent === 'flattened' || v.recent === 'reversed') { text += ', ' + v.recent + ' lately'; }
    return text;
  }
  function drawPlot(node, d) {
    var x = d.all.map(function (_, i) { var k = d.first_month + i; return Math.floor(k / 12) + '-' + ('0' + (k % 12 + 1)).slice(-2) + '-01'; });
    var smooth = d.all.map(function (_, i) {
      var part = d.all.slice(Math.max(0, i - 6), i + 6).filter(ok);
      return part.length >= 9 ? part.reduce(function (a, b) { return a + b; }, 0) / part.length : null;
    });
    function line(s) { return d.all.map(function (_, i) { return s.level_start + s.slope * i / 12; }); }
    var values = d.all.filter(ok), top = Math.max.apply(null, values), low = Math.min.apply(null, values);
    var sorted = values.slice().sort(function (a, b) { return a - b; }), mid = sorted[sorted.length >> 1];
    var spiky = top / mid > 8 && low > 0, yaxis = {gridcolor: COLOUR.grid, linecolor: COLOUR.grid, ticks: '', zeroline: false, title: {text: d.unit + (spiky ? ' (log scale)' : ''), font: {size: 12}}};
    if (spiky) {
      var ticks = [];
      for (var p = -6; p <= 6; p++) { [1, 2, 5].forEach(function (k) { var t = k * Math.pow(10, p); if (t >= low * 0.8 && t <= top * 1.2) { ticks.push(t); } }); }
      yaxis.type = 'log'; yaxis.tickmode = 'array'; yaxis.tickvals = ticks; yaxis.ticktext = ticks.map(String);
    }
    function clean(a) { return a.map(function (v) { return ok(v) ? v : null; }); }
    var traces = [], hits = cross[d.region] && (d.variable === 'AOD' || d.variable === 'PM2.5') ? cross[d.region].rows : [];
    function marks(text, symbol, label, style) {
      var rows = hits.filter(function (r) { return r.verdict === text && ok(d.all[r.month_key - d.first_month]); });
      if (!rows.length) { return; }
      traces.push({x: rows.map(function (r) { return r.month + '-01'; }), y: rows.map(function (r) { return d.all[r.month_key - d.first_month]; }), mode: 'markers', name: label,
                   marker: Object.assign({symbol: symbol, size: 12}, style), customdata: rows.map(function (r) { return 'AOD peak on ' + r.aod_peak_day + ' with ' + r.aod_peak_value.toFixed(3); }),
                   hovertemplate: '%{customdata}<extra>' + label + '</extra>'});
    }
    marks(E.crossText.SUPPORTED, 'diamond', 'Supported by a second source', {color: COLOUR.ink, line: {color: COLOUR.surface, width: 2}});
    if (d.variable === 'AOD') { marks(E.crossText.ONLY_AOD_ISOLATED, 'circle-open', 'Single isolated day only in AOD', {color: COLOUR.ink, line: {color: COLOUR.ink, width: 2.5}}); }
    Plotly.react(node, [
      {x: x, y: clean(d.all), mode: 'lines', name: 'Monthly mean', line: {color: COLOUR.context, width: 1}, connectgaps: false, hovertemplate: '%{y:.3g}<extra>Monthly mean</extra>'},
      {x: x, y: smooth, mode: 'lines', name: '12 month average', line: {color: COLOUR.soft, width: 1.5}, hovertemplate: '%{y:.3g}<extra>12 month average</extra>'},
      {x: x, y: line(d.stats.all), mode: 'lines', name: 'Trend from all valid data', line: {color: COLOUR.blue, width: 2.5}, hovertemplate: '%{y:.3g}<extra>Trend from all valid data</extra>'},
      {x: x, y: line(d.stats.clean), mode: 'lines', name: 'Trend with flagged values removed', line: {color: COLOUR.orange, width: 2.5, dash: 'dash'}, hovertemplate: '%{y:.3g}<extra>Trend with flagged values removed</extra>'}
    ].concat(traces), {
      height: 400, showlegend: false, hovermode: 'x unified', paper_bgcolor: COLOUR.surface, plot_bgcolor: COLOUR.surface,
      margin: {l: 64, r: 20, t: 74, b: 40}, font: {family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 13, color: COLOUR.soft},
      title: {text: '<b>' + nameOf(d).replace(/[<>&]/g, '') + '</b><br><span style="font-size:13px">' + headline(d) + '</span>', x: 0.5, xanchor: 'center', font: {size: 17, color: COLOUR.ink}},
      xaxis: {gridcolor: COLOUR.grid, linecolor: COLOUR.grid, ticks: ''}, yaxis: yaxis,
      hoverlabel: {bgcolor: '#ffffff', bordercolor: COLOUR.grid, font: {color: COLOUR.ink, size: 12}}
    }, {displayModeBar: false, responsive: true});
  }
  function renderPlots() {
    var grid = document.getElementById('grid'); clear(grid);
    var shown = datasets.filter(chosen);
    grid.classList.toggle('single', shown.length === 1);
    document.getElementById('nothing').style.display = shown.length ? 'none' : '';
    shown.forEach(function (d) { var cell = el('div', 'panel cell'), plot = el('div'); cell.appendChild(plot); grid.appendChild(cell); drawPlot(plot, d); });
  }
  function cellsRow(cells) {
    var tr = el('tr');
    cells.forEach(function (c) {
      var td = el('td', c.cls || 'r');
      if (c.node) { td.appendChild(c.node); } else if (c.bold) { td.appendChild(el('b', null, c.text)); } else { td.textContent = c.text; }
      tr.appendChild(td);
    });
    return tr;
  }
  function renderResults() {
    var body = document.querySelector('#results tbody'); clear(body);
    datasets.filter(chosen).forEach(function (d) {
      var v = d.verdict, verdict = el('span');
      verdict.appendChild(mark(STATE_OF[v.label], v.label === 'significant' ? 'yes' : v.label === 'borderline' ? 'borderline' : 'no'));
      var notes = [];
      if (v.label === 'borderline') { notes.push('driven by flagged values'); }
      if (d.audit.coverage_pct < 50) { notes.push('sparse data, only ' + d.audit.coverage_pct.toFixed(0) + ' % of the days have a value'); }
      if (d.source === 'uploaded') { notes.push('uploaded file ' + d.file); }
      if (notes.length) { verdict.appendChild(el('span', 'soft', ' ' + notes.join(' · '))); }
      body.appendChild(cellsRow([
        {text: d.variable, cls: 'l', bold: true}, {text: d.region, cls: 'l'}, {text: pct(v.change)}, {text: pct(v.along_line)},
        {text: sig(v.per_decade) + ' (' + sig(v.per_decade_low) + ' to ' + sig(v.per_decade_high) + ')' + unitText(d.unit)},
        {text: pText(d.stats.all.p_adjusted)}, {node: verdict, cls: 'wrap'}, {text: d.trust.grade + ' ' + d.trust.total.toFixed(0)}
      ]));
    });
  }

  /* ---------- evidence, trust, sources ---------- */
  function renderEvidence() {
    var body = document.querySelector('#evidence tbody'); clear(body);
    datasets.forEach(function (d) {
      var a = d.audit;
      body.appendChild(cellsRow([
        {text: nameOf(d), cls: 'l', bold: true}, {text: d.source === 'uploaded' ? 'uploaded' : 'repository', cls: 'l'}, {text: a.cadence, cls: 'l'},
        {text: num(a.rows_in_file)}, {text: num(a.fill_values)}, {text: num(a.missing_rows)},
        {text: num(a.implausible_values + a.duplicate_dates + a.unreadable_values)}, {text: num(a.valid_values)},
        {text: a.coverage_pct + ' %'}, {text: num(a.longest_gap)}, {text: a.usable_months_pct + ' %'},
        {text: num(a.flagged) + ' (' + a.flagged_pct + ' %)'}, {text: a.flagged_high + ' / ' + a.flagged_low}
      ]));
    });
  }
  function renderTrust() {
    var body = document.querySelector('#trust tbody'); clear(body);
    datasets.forEach(function (d) {
      var cells = [{text: nameOf(d), cls: 'l', bold: true}];
      Object.keys(E.weights).forEach(function (k) {
        var s = d.trust.scores[k], wrap = el('span'), meter = el('div', 'meter'), fillBar = el('span');
        fillBar.style.width = s.toFixed(0) + '%'; meter.appendChild(fillBar); wrap.appendChild(meter); wrap.appendChild(el('span', 'meter-num', s.toFixed(0)));
        cells.push({node: wrap});
      });
      var grade = el('span', 'grade grade-' + d.trust.grade, d.trust.grade + ' '); grade.appendChild(el('b', null, d.trust.total.toFixed(0)));
      cells.push({node: grade}); cells.push({text: d.trust.notes.length ? d.trust.notes.join(' | ') : 'no remarks', cls: 'wrap soft'});
      body.appendChild(cellsRow(cells));
    });
  }
  /* ---------- event cross-check, AOD days against the monthly PM2.5 value ---------- */
  var cross = {};
  function buildCross() {
    cross = {};
    REGION_ORDER.forEach(function (r) {
      var aod = find('AOD', r), pm = find('PM2.5', r);
      if (aod && pm && aod.daily && !pm.daily) { cross[r] = E.crossCheck(aod, pm, 10); }
    });
  }
  function renderCross() {
    var box = document.getElementById('cross'); clear(box);
    REGION_ORDER.forEach(function (r) {
      box.appendChild(el('h3', null, r));
      var c = cross[r];
      if (!c) { box.appendChild(el('p', 'sub', 'No comparison is possible for ' + r + ' because it needs a daily AOD file and a monthly PM2.5 file for this city.')); return; }
      box.appendChild(el('p', 'sub', c.rows.length ? c.summary : 'No unusual month was found.'));
      var cover = find('AOD', r).audit.coverage_pct;
      if (cover < 50) { var hint = el('p', 'sub'); hint.appendChild(mark('warn', 'Sparse data, only ' + Math.round(cover) + ' % of the days have an AOD value. An isolated day is weaker evidence here.')); box.appendChild(hint); }
      if (!c.rows.length) { return; }
      var wrap = el('div', 'scroll'), table = el('table'), head = el('tr'), body = el('tbody');
      [['Month', 'l'], ['Day of the AOD peak', 'l'], ['AOD value', 'r'], ['PM2.5 value in µg/m³', 'r'], ['Verdict', 'l']].forEach(function (h) { head.appendChild(el('th', h[1], h[0])); });
      var thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
      c.rows.forEach(function (x) {
        body.appendChild(cellsRow([{text: x.month, cls: 'l', bold: true}, {text: x.aod_peak_day || 'no AOD data', cls: 'l'},
                                   {text: ok(x.aod_peak_value) ? x.aod_peak_value.toFixed(3) : 'n/a'}, {text: x.pm25.toFixed(1)}, {text: x.verdict, cls: 'l'}]));
      });
      table.appendChild(body); wrap.appendChild(table); box.appendChild(wrap);
    });
  }
  function renderSources() {
    var body = document.querySelector('#sources tbody'); clear(body);
    datasets.forEach(function (d) {
      var url = d.meta.reproduce_url || '', link;
      if (url.indexOf('https://giovanni.gsfc.nasa.gov/') === 0) { link = el('a', null, 'open in Giovanni'); link.href = url; link.rel = 'noopener'; } else { link = el('span', null, 'not stated'); }
      body.appendChild(cellsRow([
        {text: nameOf(d), cls: 'l', bold: true}, {text: d.file, cls: 'l'}, {text: d.meta.variable_id, cls: 'wrap'}, {text: d.unit, cls: 'l'},
        {text: d.meta.user_bbox ? d.meta.user_bbox.join(', ') : 'not stated', cls: 'l'}, {text: d.audit.footprint_note, cls: 'wrap'}, {node: link, cls: 'l'}
      ]));
    });
  }
  function renderAll() {
    showEmpty();
    datasets.sort(function (a, b) { var va = variables().indexOf(a.variable), vb = variables().indexOf(b.variable); return va - vb || sortKey(a) - sortKey(b); });
    E.judge(datasets);
    buildCross(); renderConclusion(); renderCompare();
    fillSelect('pick-variable', variables(), 'All variables'); fillSelect('pick-region', regions(), 'All regions');
    renderPlots(); renderResults(); renderEvidence(); renderCross(); renderTrust(); renderSources();
  }

  /* ---------- bring your own NASA data ---------- */
  var note = document.getElementById('own-note');
  function say(text, cls) { var line = el('div', cls || null, text); note.appendChild(line); return line; }
  function showEmpty() {
    var empty = datasets.length === 0;
    document.querySelectorAll('section').forEach(function (s) { if (!s.querySelector('#drop')) { s.style.display = empty ? 'none' : ''; } });
  }
  /* ---------- where the numbers come from ----------
     The page holds no data. Every file is read as text, either from the repository
     (the CSV files next to this page) or from the visitor, and handed to the same engine. The engine runs in background
     workers so the page stays usable, and a finished result is kept in the browser until the
     file changes. The calculation itself is untouched. */
  var ENGINE_VERSION = 'engine-v9', DATA_FOLDER = '', FILE_LIST = 'files.json';
  function hashOf(text) { var h = 2166136261; for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + '-' + text.length; }
  function pack(d) { return JSON.stringify(d, function (k, v) { return typeof v === 'number' && v !== v ? '__nan__' : v; }); }
  function unpack(s) { return JSON.parse(s, function (k, v) { return v === '__nan__' ? NaN : v; }); }
  function remembered(key) { try { var s = window.localStorage.getItem(key); return s ? unpack(s) : null; } catch (err) { return null; } }
  function remember(key, d) { try { window.localStorage.setItem(key, pack(d)); } catch (err) { /* storage full or switched off, the page works without it */ } }
  function forgetAll() { try { Object.keys(window.localStorage).forEach(function (k) { if (k.indexOf('watchdog:') === 0) { window.localStorage.removeItem(k); } }); } catch (err) { /* nothing to forget */ } }

  var workers = [], idle = [], waiting = [], jobs = {}, nextJob = 1, canWork = typeof Worker !== 'undefined';
  function startWorkers() {
    if (workers.length || !canWork) { return; }
    var n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    try {
      for (var i = 0; i < n; i++) {
        var w = new Worker('watchdog-worker.js');
        w.onmessage = function (e) { var job = jobs[e.data.id]; delete jobs[e.data.id]; idle.push(this); pump(); if (job) { if (e.data.ok) { job.resolve(e.data.dataset); } else { job.reject(new Error(e.data.message)); } } };
        w.onerror = function () { canWork = false; Object.keys(jobs).forEach(function (id) { var job = jobs[id]; delete jobs[id]; runHere(job); }); };
        workers.push(w); idle.push(w);
      }
    } catch (err) { canWork = false; }
  }
  function runHere(job) { setTimeout(function () { try { job.resolve(E.analyze(job.name, job.text)); } catch (err) { job.reject(err); } }, 30); }
  function pump() { while (idle.length && waiting.length) { var job = waiting.shift(), w = idle.shift(); jobs[job.id] = job; w.postMessage({id: job.id, name: job.name, text: job.text}); } }
  /* one file in, one dataset out. Uses the remembered result when the very same text was analysed before. */
  function analyse(name, text, fresh) {
    var key = 'watchdog:' + ENGINE_VERSION + ':' + name + ':' + hashOf(text), kept = fresh ? null : remembered(key);
    if (kept) { return Promise.resolve({dataset: kept, kept: true}); }
    return new Promise(function (resolve, reject) {
      var job = {id: nextJob++, name: name, text: text, resolve: resolve, reject: reject};
      startWorkers();
      if (canWork) { waiting.push(job); pump(); } else { runHere(job); }
    }).then(function (d) { remember(key, d); return {dataset: d, kept: false}; });
  }
  function place(d, source) {
    var old = find(d.variable, d.region);
    d.source = source;
    if (old) { datasets.splice(datasets.indexOf(old), 1); }
    datasets.push(d); renderAll();
    return old;
  }
  var busyLine = null, open = 0, done = 0;
  function progress() {
    if (!busyLine) { busyLine = say('', 'busy'); }
    if (done >= open) { if (busyLine.parentNode) { note.removeChild(busyLine); } busyLine = null; open = 0; done = 0; return; }
    busyLine.textContent = 'Calculating, ' + done + ' of ' + open + ' files ready. Daily files take about 20 seconds each, the page stays usable.';
    note.appendChild(busyLine);
  }
  function handle(name, text, source, fresh) {
    open++; progress();
    return analyse(name, text, fresh).then(function (r) {
      var d = r.dataset, old = place(d, source);
      say(name + (old ? ' replaced the dataset ' : ' was read as ') + nameOf(d) + (r.kept ? ', result kept from an earlier visit. ' : '. ') +
        d.audit.flagged + ' values flagged, trust ' + d.trust.grade + ' ' + d.trust.total.toFixed(0) + '.');
    }).catch(function (err) { say(name + ' was not accepted because ' + err.message + '.'); })
      .then(function () { done++; progress(); });
  }
  window.watchdogAdd = function (name, text) { return handle(name, text, 'uploaded', true); };

  /* the files named in files.json, fetched from the repository */
  function loadRepository(fresh) {
    datasets.length = 0; clear(note); renderAll();
    if (fresh) { forgetAll(); }
    return fetch(FILE_LIST, {cache: 'no-cache'}).then(function (r) {
      if (!r.ok) { throw new Error('the list ' + FILE_LIST + ' could not be read (' + r.status + ')'); }
      return r.json();
    }).then(function (list) {
      var names = (list.files || list || []).filter(function (n) { return typeof n === 'string' && /^[\w.\- ]+\.csv$/i.test(n); });
      if (!names.length) { throw new Error(FILE_LIST + ' names no CSV file'); }
      say('Reading ' + names.length + ' CSV files from the repository.');
      return Promise.all(names.map(function (name) {
        return fetch(DATA_FOLDER + encodeURIComponent(name), {cache: 'no-cache'}).then(function (r) {
          if (!r.ok) { throw new Error('not found in the repository (' + r.status + ')'); }
          return r.text();
        }).then(function (text) { return handle(name, text, 'repository', fresh); },
                function (err) { say(name + ' was not read because ' + err.message + '.'); });
      }));
    }).catch(function (err) {
      say('The data could not be loaded because ' + err.message + '. ' +
        (location.protocol === 'file:' ? 'A page opened as a local file may not read other files. Open it through GitHub Pages or run Telemetry_WatchDog.py.' : ''));
    });
  }
  function takeFiles(list) {
    Array.prototype.forEach.call(list, function (file) {
      var reader = new FileReader();
      reader.onerror = function () { say(file.name + ' could not be read.'); };
      reader.onload = function () { handle(file.name, String(reader.result), 'uploaded', true); };
      reader.readAsText(file);
    });
  }
  var reloadButton = document.getElementById('reload-repo');
  if (reloadButton) { reloadButton.addEventListener('click', function () { loadRepository(true); }); }
  var input = document.getElementById('own-file'), drop = document.getElementById('drop');
  input.addEventListener('change', function () { takeFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach(function (name) { drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (name) { drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) { takeFiles(e.dataTransfer.files); } });
  ['pick-variable', 'pick-region'].forEach(function (id) { document.getElementById(id).addEventListener('change', function () { renderPlots(); renderResults(); }); });
  document.querySelectorAll('details').forEach(function (d) {
    d.addEventListener('toggle', function () { if (d.open) { d.querySelectorAll('.js-plotly-plot').forEach(function (p) { Plotly.Plots.resize(p); }); } });
  });
  renderAll();
  loadRepository(false);
})();
