/* CHARTS. Small SVG charts drawn by hand, one data colour (validated against
   the dark surface), thin marks, hairline grid, text in text colours, a hover
   tooltip on every mark, and a table view for every chart.

   window.RHCharts.columns(rows, opts)   weekly commits and similar counts
   window.RHCharts.line(points, opts)    star history and similar running totals
   window.RHCharts.bars(rows, opts)      ranked horizontal bars (contributors, languages)
   window.RHCharts.timeline(items, opts) releases along a time axis
   window.RHCharts.meter(value, max)     score meter with its status colour */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const DATA = 'var(--data)'; // set per day or night mode in styles.css
  const s = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; };
  const div = (cls, text) => { const d = document.createElement('div'); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
  const fmt = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
  const niceMax = (v) => { if (v <= 4) return 4; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; };
  const month = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

  /* Wrapper: the chart, a shared tooltip, and a "Table" toggle. */
  function frame(title, sub, rows, cols) {
    const wrap = div('chart');
    const head = div('chart-head');
    const titles = div('chart-titles');
    titles.append(div('chart-title', title));
    if (sub) titles.append(div('chart-sub', sub));
    const toggle = document.createElement('button');
    toggle.className = 'btn btn-sm chart-toggle';
    toggle.textContent = 'Table';
    head.append(titles, toggle);
    const body = div('chart-body');
    const tip = div('chart-tip'); tip.hidden = true;
    const table = document.createElement('table');
    table.className = 'chart-table'; table.hidden = true;
    const tr = document.createElement('tr');
    for (const c of cols) { const th = document.createElement('th'); th.textContent = c; tr.append(th); }
    table.append(tr);
    for (const r of rows) { const row = document.createElement('tr'); for (const v of r) { const td = document.createElement('td'); td.textContent = v; row.append(td); } table.append(row); }
    toggle.onclick = () => { const showTable = table.hidden; table.hidden = !showTable; body.hidden = showTable; toggle.textContent = showTable ? 'Chart' : 'Table'; };
    wrap.append(head, body, table);
    body.append(tip);
    const show = (evt, text) => {
      tip.textContent = text; tip.hidden = false;
      const r = body.getBoundingClientRect();
      const x = Math.min(Math.max(evt.clientX - r.left + 12, 0), r.width - 180);
      tip.style.left = `${x}px`; tip.style.top = `${Math.max(evt.clientY - r.top - 36, 0)}px`;
    };
    const hide = () => { tip.hidden = true; };
    return { wrap, body, show, hide };
  }

  function axisY(svg, max, x0, x1, y0, y1) {
    const ticks = [0, max / 2, max];
    for (const t of ticks) {
      const y = y1 - ((y1 - y0) * t) / max;
      svg.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }));
      const lab = s('text', { x: x0 - 6, y: y + 4, 'text-anchor': 'end', class: 'chart-axis' }); lab.textContent = fmt(t); svg.append(lab);
    }
  }

  function columns(rows, { title, sub, label = 'value', dateKey = 'week', valueKey = 'total', width = 720, height = 180 } = {}) {
    const f = frame(title, sub, rows.map((r) => [r[dateKey], String(r[valueKey])]), [dateKey === 'week' ? 'Week of' : 'Date', label]);
    if (!rows.length) { f.body.append(div('dim', 'No data.')); return f.wrap; }
    const L = 40, R = 8, T = 10, B = 24;
    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img', 'aria-label': title });
    const max = niceMax(Math.max(...rows.map((r) => r[valueKey]), 1));
    axisY(svg, max, L, width - R, T, height - B);
    const slot = (width - L - R) / rows.length;
    const bw = Math.min(24, Math.max(2, slot - 2)); // 2px surface gap between neighbours
    rows.forEach((r, i) => {
      const v = r[valueKey];
      const h = ((height - T - B) * v) / max;
      const x = L + i * slot + (slot - bw) / 2;
      const y = height - B - h;
      if (h > 0) {
        const rad = Math.min(4, bw / 2, h);
        // Rounded data end, square at the baseline.
        svg.append(s('path', { d: `M${x},${height - B} V${y + rad} Q${x},${y} ${x + rad},${y} H${x + bw - rad} Q${x + bw},${y} ${x + bw},${y + rad} V${height - B} Z`, fill: DATA }));
      }
      const hit = s('rect', { x: L + i * slot, y: T, width: slot, height: height - T - B, fill: 'transparent' });
      hit.addEventListener('mousemove', (e) => f.show(e, `${r[dateKey]}: ${v} ${label}`));
      hit.addEventListener('mouseleave', f.hide);
      svg.append(hit);
      if (i % Math.ceil(rows.length / 6) === 0) { const t = s('text', { x: L + i * slot, y: height - 6, class: 'chart-axis' }); t.textContent = month(r[dateKey]); svg.append(t); }
    });
    f.body.prepend(svg);
    return f.wrap;
  }

  function line(points, { title, sub, label = 'stars', width = 720, height = 200 } = {}) {
    const f = frame(title, sub, points.map((p) => [p.date, String(p.stars)]), ['Date', label]);
    if (points.length < 2) { f.body.append(div('dim', 'Not enough data for a history.')); return f.wrap; }
    const L = 44, R = 12, T = 12, B = 24;
    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img', 'aria-label': title });
    const t0 = Date.parse(points[0].date), t1 = Math.max(Date.parse(points[points.length - 1].date), t0 + 1);
    const max = niceMax(Math.max(...points.map((p) => p.stars)));
    axisY(svg, max, L, width - R, T, height - B);
    const X = (d) => L + ((width - L - R) * (Date.parse(d) - t0)) / (t1 - t0);
    const Y = (v) => height - B - ((height - T - B) * v) / max;
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.date).toFixed(1)},${Y(p.stars).toFixed(1)}`).join(' ');
    svg.append(s('path', { d: `${d} L${X(points[points.length - 1].date)},${height - B} L${X(points[0].date)},${height - B} Z`, fill: DATA, 'fill-opacity': 0.1 }));
    svg.append(s('path', { d, fill: 'none', stroke: DATA, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = points[points.length - 1];
    svg.append(s('circle', { cx: X(last.date), cy: Y(last.stars), r: 4, fill: DATA, stroke: 'var(--bg-2)', 'stroke-width': 2 }));
    const endLab = s('text', { x: X(last.date) - 8, y: Y(last.stars) - 10, 'text-anchor': 'end', class: 'chart-label' }); endLab.textContent = fmt(last.stars); svg.append(endLab);
    for (const p of [points[0], points[Math.floor(points.length / 2)], last]) { const t = s('text', { x: X(p.date), y: height - 6, 'text-anchor': p === last ? 'end' : p === points[0] ? 'start' : 'middle', class: 'chart-axis' }); t.textContent = month(p.date); svg.append(t); }
    // Crosshair: nearest point to the pointer.
    const cross = s('line', { y1: T, y2: height - B, stroke: 'var(--fg-dim)', 'stroke-width': 1, visibility: 'hidden' });
    svg.append(cross);
    const hit = s('rect', { x: L, y: T, width: width - L - R, height: height - T - B, fill: 'transparent' });
    hit.addEventListener('mousemove', (e) => {
      const box = svg.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * width;
      let best = points[0];
      for (const p of points) if (Math.abs(X(p.date) - px) < Math.abs(X(best.date) - px)) best = p;
      cross.setAttribute('x1', X(best.date)); cross.setAttribute('x2', X(best.date)); cross.setAttribute('visibility', 'visible');
      f.show(e, `${best.date}: about ${best.stars.toLocaleString('en-US')} ${label}`);
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); f.hide(); });
    svg.append(hit);
    f.body.prepend(svg);
    return f.wrap;
  }

  function bars(rows, { title, sub, unit = '', max: fixedMax } = {}) {
    const f = frame(title, sub, rows.map((r) => [r.label, `${r.value}${unit}`]), ['Name', 'Value']);
    if (!rows.length) { f.body.append(div('dim', 'No data.')); return f.wrap; }
    const max = fixedMax || Math.max(...rows.map((r) => r.value), 1);
    const list = div('hbars');
    for (const r of rows) {
      const row = div('hbar');
      const name = div('hbar-name', r.label);
      const track = div('hbar-track');
      const fill = div('hbar-fill');
      fill.style.width = `${Math.max(1, (r.value / max) * 100)}%`;
      track.append(fill);
      const val = div('hbar-val', `${typeof r.value === 'number' ? r.value.toLocaleString('en-US') : r.value}${unit}`);
      row.append(name, track, val);
      row.addEventListener('mousemove', (e) => f.show(e, `${r.label}: ${r.value.toLocaleString('en-US')}${unit}${r.note ? ` · ${r.note}` : ''}`));
      row.addEventListener('mouseleave', f.hide);
      list.append(row);
    }
    f.body.prepend(list);
    return f.wrap;
  }

  function timeline(items, { title, sub, width = 720, height = 70 } = {}) {
    const f = frame(title, sub, items.map((r) => [r.date, r.tag, r.prerelease ? 'pre-release' : '']), ['Date', 'Release', 'Type']);
    const rel = items.filter((r) => r.date).slice().reverse();
    if (!rel.length) { f.body.append(div('dim', 'No releases published.')); return f.wrap; }
    const L = 12, R = 12, Y = 30;
    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img', 'aria-label': title });
    const t0 = Math.min(Date.parse(rel[0].date), Date.now() - 365 * 86400000), t1 = Date.now();
    const X = (d) => L + ((width - L - R) * (Date.parse(d) - t0)) / (t1 - t0);
    svg.append(s('line', { x1: L, x2: width - R, y1: Y, y2: Y, stroke: 'var(--line)', 'stroke-width': 1 }));
    for (const r of rel) {
      const c = s('circle', { cx: X(r.date), cy: Y, r: 5, fill: r.prerelease ? 'var(--bg-2)' : DATA, stroke: r.prerelease ? DATA : 'var(--bg-2)', 'stroke-width': 2 });
      c.addEventListener('mousemove', (e) => f.show(e, `${r.tag}${r.prerelease ? ' (pre-release)' : ''}: ${r.date}`));
      c.addEventListener('mouseleave', f.hide);
      svg.append(c);
    }
    for (const [d, anchor] of [[new Date(t0).toISOString().slice(0, 10), 'start'], [new Date(t1).toISOString().slice(0, 10), 'end']]) {
      const t = s('text', { x: anchor === 'start' ? L : width - R, y: height - 8, 'text-anchor': anchor, class: 'chart-axis' }); t.textContent = month(d); svg.append(t);
    }
    f.body.prepend(svg);
    return f.wrap;
  }

  /* Score meter: the fill carries the status, the track is the same hue, lighter. */
  function meter(value, max = 100) {
    const pct = Math.max(0, Math.min(100, (value / max) * 100));
    const level = pct >= 60 ? 'ok' : pct >= 40 ? 'warn' : 'bad';
    const m = div(`meter meter-${level}`);
    const fill = div('meter-fill'); fill.style.width = `${pct}%`;
    m.append(fill);
    m.title = `${value} of ${max}`;
    return m;
  }

  window.RHCharts = { columns, line, bars, timeline, meter, DATA };
})();
