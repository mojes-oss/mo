/* PROMETRA weekly report: renders every slide from the JSON embedded at build time. */
(() => {
  'use strict';

  if (!document.documentElement.lang) document.documentElement.lang = 'en';
  const D = JSON.parse(document.getElementById('dash-data').textContent);
  const R = D.report;

  // ---------- small utilities ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('prometra-report:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('prometra-report:' + k, JSON.stringify(v)); } catch { /* storage blocked: fine */ } },
  };

  const fmt = n => isNum(n) ? Math.round(n).toLocaleString('en-US') : '–';
  const compact = n => {
    if (!isNum(n)) return '–';
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return Math.round(n / 1e3) + 'K';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return fmt(n);
  };
  const pct = (n, d = 0) => isNum(n) ? n.toFixed(d) + '%' : '–';
  const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;
  const money = n => isNum(n) ? '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)) : '–';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const parseDay = iso => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const isoDay = dt => dt.toISOString().slice(0, 10);
  const addDays = (iso, n) => { const d = parseDay(iso); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
  const dayLabel = iso => { const d = parseDay(iso); return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  const shortDate = iso => { const d = parseDay(iso); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  const rangeLabel = (a, b) => {
    const x = parseDay(a), y = parseDay(b);
    return x.getUTCMonth() === y.getUTCMonth()
      ? `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}–${y.getUTCDate()}`
      : `${shortDate(a)} – ${shortDate(b)}`;
  };
  const time12 = t => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'am' : 'pm'}`;
  };
  // Pick a round tick step so the axis never shows labels like 6.3K.
  const niceTicks = (max, maxTicks = 5) => {
    if (!(max > 0)) return { ymax: 1, step: 0.25 };
    const mag = Math.pow(10, Math.floor(Math.log10(max / maxTicks)));
    for (const m of [1, 2, 5, 10, 20]) {
      const step = m * mag;
      if (Math.ceil(max / step) <= maxTicks) return { ymax: Math.ceil(max / step) * step, step };
    }
    return { ymax: max, step: max / maxTicks };
  };
  const niceMax = v => {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  };

  // ---------- icons ----------
  const I = {
    play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11a.5.5 0 0 0 .76.43l9-5.5a.5.5 0 0 0 0-.86l-9-5.5A.5.5 0 0 0 4 2.5Z"/></svg>',
    boost: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5v13M11 4.2C10.4 3.2 9.3 2.8 8 2.8c-1.8 0-3 .9-3 2.3 0 3.2 6.2 1.6 6.2 5 0 1.4-1.3 2.4-3.2 2.4-1.5 0-2.6-.5-3.2-1.6"/></svg>',
    camera: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="4" width="9" height="8" rx="2"/><path d="m10.5 7 4-2.2v6.4l-4-2.2"/></svg>',
    flag: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 14.5V2M3 2.5h8.5l-1.8 3 1.8 3H3"/></svg>',
    star: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="m8 1.3 2 4.2 4.6.6-3.4 3.2.9 4.5L8 11.6l-4.1 2.2.9-4.5-3.4-3.2 4.6-.6Z"/></svg>',
    up: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M6 1.5 10.5 7H7.5v3.5h-3V7h-3Z"/></svg>',
    down: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M6 10.5 1.5 5h3V1.5h3V5h3Z"/></svg>',
    left: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 3-5 5 5 5"/></svg>',
    right: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>',
    close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9"/></svg>',
    present: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2" width="13" height="9" rx="1.5"/><path d="M8 11v3M5 14.5h6" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 9v5M10 6.2v.1" stroke-linecap="round"/></svg>',
    alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.5 18 17H2Z"/><path d="M10 8v4M10 14.3v.1" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 6.3 2.6 2.5L10 3.3"/></svg>',
    minus: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2.5 6h7"/></svg>',
    ban: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="m3.7 3.7 8.6 8.6"/></svg>',
    key: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6.5" cy="13.5" r="3.5"/><path d="m9 11 8-8M14 6l2 2M12 8l1.5 1.5"/></svg>',
    ask: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 4.5h13v9h-7l-4 3v-3h-2Z"/><path d="M10 7.2v2.6M10 11.4v.1"/></svg>',
    money: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="2" y="5" width="16" height="10" rx="2"/><circle cx="10" cy="10" r="2.3"/></svg>',
    chart: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 16.5h14M5.5 13V9M10 13V5M14.5 13v-6"/></svg>',
    chev: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>',
  };
  const KIND_ICON = { post: I.play, boost: I.boost, shoot: I.camera, deadline: I.flag, event: I.star };
  const KIND_LABEL = { post: 'Post', boost: 'Boost', shoot: 'Filming', deadline: 'Deadline', event: 'Event' };

  // ---------- accounts ----------
  const ACC = {};
  for (const a of R.accounts) ACC[a.id] = a;
  const ACC_IDS = R.accounts.map(a => a.id);
  const HANDLE_TO_ID = {};
  for (const a of R.accounts) HANDLE_TO_ID[a.handle] = a.id;
  HANDLE_TO_ID['YouTube @dromavi'] = 'dromavi';
  const accName = id => (ACC[id] ? ACC[id].handle : id);
  const accShort = id => ({ prometrausa: '@prometrausa', meto: 'METO', dromavi: '@dromavi' }[id] || id);
  const accDot = id => `<i class="dot ${esc(id)}" aria-hidden="true"></i>`;

  // ---------- state ----------
  const withEnd = w => ({ ...w, end: w.end || addDays(w.start, 6) });
  const REAL = (D.weeks || []).filter(w => w && w.start).map(withEnd).sort((a, b) => a.start.localeCompare(b.start));
  const SAMPLE = (D.sampleWeeks || []).map(withEnd).sort((a, b) => a.start.localeCompare(b.start));
  const hasReal = REAL.length > 0;
  const state = {
    account: ACC_IDS.includes(store.get('account', 'all')) ? store.get('account', 'all') : 'all',
    sample: store.get('sample', true),
    weekStart: null,
    presenting: false,
    current: 0,
  };
  const weeks = () => (hasReal ? REAL : state.sample ? SAMPLE : []);
  const usingSample = () => !hasReal && state.sample && SAMPLE.length > 0;
  function weekIndex() {
    const ws = weeks();
    if (!ws.length) return -1;
    const i = ws.findIndex(w => w.start === state.weekStart);
    return i === -1 ? ws.length - 1 : i;
  }
  const curWeek = () => weeks()[weekIndex()] || null;
  const prevWeek = () => { const i = weekIndex(); return i > 0 ? weeks()[i - 1] : null; };
  // The report period: the chosen week, or the report week when there are no numbers.
  const period = () => { const w = curWeek(); return w ? { start: w.start, end: w.end } : R.reportWeek; };

  // ---------- metrics ----------
  const inScope = id => state.account === 'all' || state.account === id;
  const postsOf = w => (w?.posts || []).filter(p => inScope(p.account));
  function sumKey(list, key) {
    let s = 0, any = false;
    for (const x of list) if (isNum(x[key])) { s += x[key]; any = true; }
    return any ? s : null;
  }
  // Per account: the account-level number when it was filled in, otherwise that account's posts
  // added up. Summing per account keeps one filled-in account from hiding the others.
  function statFor(w, key, postKey, scope = state.account) {
    if (!w) return null;
    let s = 0, any = false;
    for (const id of ACC_IDS) {
      if (scope !== 'all' && scope !== id) continue;
      const a = w.accounts?.[id]?.[key];
      const v = isNum(a) ? a : sumKey((w.posts || []).filter(p => p.account === id), postKey);
      if (isNum(v)) { s += v; any = true; }
    }
    return any ? s : null;
  }
  // MOVEMENT comments. Across all accounts, Nehanda's Friday count wins; for one account, its posts add up.
  function keywordFor(w, scope = state.account) {
    if (!w) return null;
    if (scope === 'all') return w.funnel?.keywordComments ?? sumKey(w.posts || [], 'keywordComments');
    return sumKey((w.posts || []).filter(p => p.account === scope), 'keywordComments');
  }
  const curveAvg = pts => pts && pts.length > 1 ? pts.slice(1).reduce((s, v, i) => s + (pts[i] + v) / 2, 0) / (pts.length - 1) : null;
  const watched = p => (isNum(p.avgWatchSec) && p.lengthSec ? (p.avgWatchSec / p.lengthSec) * 100 : curveAvg(p.retention));
  function weightedWatched(posts) {
    let num = 0, den = 0;
    for (const p of posts) { const w = watched(p); if (isNum(w)) { const wt = isNum(p.views) ? p.views : 1; num += w * wt; den += wt; } }
    return den ? num / den : null;
  }
  const M = {
    views: w => statFor(w, 'views', 'views'),
    reach: w => statFor(w, 'reach', 'reach'),
    watched: w => weightedWatched(postsOf(w)),
    follows: w => statFor(w, 'newFollowers', 'follows'),
    keyword: w => keywordFor(w),
  };
  const history = (fn, n = 6) => { const ws = weeks(); const i = weekIndex(); return ws.slice(Math.max(0, i - n + 1), i + 1).map(fn); };
  // Percent change. Infinity means "up from zero", which is common for a new account.
  function delta(cur, prev) {
    if (!isNum(cur) || !isNum(prev)) return null;
    if (prev === 0) return cur === 0 ? 0 : Infinity;
    return ((cur - prev) / prev) * 100;
  }
  function deltaHTML(d, { vs = 'last week', pts = false } = {}) {
    if (d === Infinity) return `<span class="delta-up">${I.up} Up from 0 vs ${vs}</span>`;
    if (!isNum(d)) return `<span class="delta-flat">No prior week</span>`;
    const dir = Math.abs(d) < 0.5 ? 'flat' : d > 0 ? 'up' : 'down';
    const txt = pts ? `${d > 0 ? '+' : ''}${d.toFixed(1)} pts` : `${d > 0 ? '+' : ''}${d.toFixed(0)}%`;
    if (dir === 'flat') return `<span class="delta-flat">${I.minus} Flat vs ${vs}</span>`;
    return `<span class="delta-${dir}">${dir === 'up' ? I.up : I.down} ${txt} vs ${vs}</span>`;
  }

  // ---------- charts ----------
  const charts = new Map();
  let chartSeq = 0;

  function sparkline(values, { color = 'currentColor', w = 120, h = 36, fill = true, label = '' } = {}) {
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => isNum(v));
    if (pts.length < 2) return '';
    const max = Math.max(...pts.map(p => p[1])), min = Math.min(0, ...pts.map(p => p[1]));
    const n = values.length - 1 || 1;
    const x = i => 3 + (i / n) * (w - 6);
    const y = v => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
    const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const last = pts[pts.length - 1];
    const area = fill ? `<path d="${d}L${x(last[0]).toFixed(1)},${h - 1}L${x(pts[0][0]).toFixed(1)},${h - 1}Z" fill="${color}" opacity=".12"/>` : '';
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${area}<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3.4" fill="${color}" stroke="var(--surface)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
  }

  // Multi-series line chart with a crosshair tooltip. One y-axis only.
  function lineChart({ labels, series, height = 230, yFmt = compact, title = '' }) {
    const id = 'c' + (++chartSeq);
    const W = 640, H = height, L = 46, Rm = 16, T = 14, B = 30;
    const all = series.flatMap(s => s.values).filter(isNum);
    if (!all.length) return `<div class="empty"><b>No weekly numbers yet</b><span>The trend starts after the second week of data.</span></div>`;
    const { ymax, step } = niceTicks(Math.max(...all));
    const n = labels.length;
    const x = i => L + (n === 1 ? (W - L - Rm) / 2 : (i / (n - 1)) * (W - L - Rm));
    const y = v => T + (1 - v / ymax) * (H - T - B);
    let g = '';
    for (let v = 0; v <= ymax + step / 2; v += step) {
      g += `<line class="grid-line" x1="${L}" x2="${W - Rm}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
      g += `<text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(yFmt(v))}</text>`;
    }
    labels.forEach((lab, i) => { g += `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`; });
    let p = '';
    for (const s of series) {
      const pts = s.values.map((v, i) => [i, v]).filter(([, v]) => isNum(v));
      if (!pts.length) continue;
      const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      if (series.length === 1 && pts.length > 1) {
        p += `<path d="${d}L${x(pts[pts.length - 1][0]).toFixed(1)},${y(0)}L${x(pts[0][0]).toFixed(1)},${y(0)}Z" fill="${s.color}" opacity=".1"/>`;
      }
      p += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
      const [li, lv] = pts[pts.length - 1];
      p += `<circle cx="${x(li).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
    }
    const base = `<line class="axis-line" x1="${L}" x2="${W - Rm}" y1="${y(0)}" y2="${y(0)}"/>`;
    charts.set(id, { kind: 'line', labels, series, x, y, W, H, T, B, yFmt });
    const legend = series.length > 1
      ? `<div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>` : '';
    const table = `<table class="sr-only"><caption>${esc(title)}</caption><thead><tr><th scope="col">Week of</th>${series.map(s => `<th scope="col">${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${labels.map((lab, i) => `<tr><th scope="row">${esc(lab)}</th>${series.map(s => `<td>${esc(fmt(s.values[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    return `${legend}${table}<div class="chart" data-chart="${id}" data-vbw="${W}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}${base}${p}<line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--ink)" stroke-width="1" opacity="0"/><g class="hover-dots"></g><rect class="hit" x="${L}" y="${T}" width="${W - L - Rm}" height="${H - T - B}" fill="transparent"/></svg></div>`;
  }

  // One retention curve: 100 people start, how many are left at each tenth of the video.
  function retentionChart(curve, color, avg) {
    const id = 'c' + (++chartSeq);
    const W = 260, H = 116, L = 26, Rm = 8, T = 8, B = 20;
    const n = curve.length - 1;
    const x = i => L + (i / n) * (W - L - Rm);
    const y = v => T + (1 - v / 100) * (H - T - B);
    let g = '';
    for (const v of [0, 50, 100]) {
      g += `<line class="grid-line" x1="${L}" x2="${W - Rm}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
    }
    g += `<text x="${L}" y="${H - 5}">Start</text><text x="${(L + W - Rm) / 2}" y="${H - 5}" text-anchor="middle">Middle</text><text x="${W - Rm}" y="${H - 5}" text-anchor="end">End</text>`;
    const d = curve.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `<path d="${d}L${x(n)},${y(0)}L${x(0)},${y(0)}Z" fill="${color}" opacity=".13"/>`;
    const line = `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const end = `<circle cx="${x(n)}" cy="${y(curve[n])}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`;
    const avgLine = isNum(avg) ? `<line x1="${L}" x2="${W - Rm}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--ink-2)" stroke-width="1" stroke-dasharray="0" opacity=".45"/>` : '';
    charts.set(id, { kind: 'retention', curve, x, y, T, B, H, W, color });
    const at = k => curve[Math.round((n * k) / 4)];
    return `<div class="chart" data-chart="${id}" data-vbw="${W}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Retention curve: of 100 viewers, ${at(1)} are still watching a quarter of the way in, ${at(2)} at the middle, and ${curve[n]} at the end">${g}${area}${avgLine}${line}${end}<line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--ink)" stroke-width="1" opacity="0"/><g class="hover-dots"></g><rect class="hit" x="${L}" y="${T}" width="${W - L - Rm}" height="${H - T - B}" fill="transparent"/></svg></div>`;
  }

  function wireCharts(root) {
    for (const el of $$('[data-chart]', root)) {
      const c = charts.get(el.dataset.chart);
      if (!c) continue;
      const svg = $('svg', el), hit = $('rect.hit', svg), xh = $('.xhair', svg), dots = $('.hover-dots', svg);
      let tip = null;
      const hide = () => { xh.setAttribute('opacity', 0); dots.innerHTML = ''; tip?.remove(); tip = null; };
      const show = evt => {
        const pt = svg.createSVGPoint();
        const src = evt.touches ? evt.touches[0] : evt;
        pt.x = src.clientX; pt.y = src.clientY;
        const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
        const count = c.kind === 'line' ? c.labels.length : c.curve.length;
        let best = 0, bd = Infinity;
        for (let i = 0; i < count; i++) { const dd = Math.abs(c.x(i) - loc.x); if (dd < bd) { bd = dd; best = i; } }
        const cx = c.x(best);
        xh.setAttribute('x1', cx); xh.setAttribute('x2', cx); xh.setAttribute('opacity', .35);
        let html, topY;
        if (c.kind === 'line') {
          const rows = c.series.filter(s => isNum(s.values[best]));
          dots.innerHTML = rows.map(s => `<circle cx="${cx}" cy="${c.y(s.values[best])}" r="5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join('');
          topY = Math.min(...rows.map(s => c.y(s.values[best])), c.H - c.B);
          html = `<b>Week of ${esc(c.labels[best])}</b>` + rows.map(s => `<div class="row"><i class="dot" style="background:${s.color}"></i>${esc(s.label)}: <b>${esc(fmt(s.values[best]))}</b></div>`).join('');
        } else {
          const v = c.curve[best];
          dots.innerHTML = `<circle cx="${cx}" cy="${c.y(v)}" r="5" fill="${c.color}" stroke="var(--surface)" stroke-width="2"/>`;
          topY = c.y(v);
          const where = best === 0 ? 'At the start' : best === c.curve.length - 1 ? 'At the end' : `${Math.round((best / (c.curve.length - 1)) * 100)}% of the way in`;
          html = `<b>${where}</b><div>${v} of every 100 viewers still watching</div>`;
        }
        if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; el.appendChild(tip); }
        tip.innerHTML = html;
        const box = svg.getBoundingClientRect(), host = el.getBoundingClientRect();
        const sx = box.width / c.W;
        let left = cx * sx + (box.left - host.left);
        const half = tip.offsetWidth / 2;
        left = Math.max(half, Math.min(host.width - half, left));
        tip.style.left = left + 'px';
        tip.style.top = (topY * (box.height / c.H) + (box.top - host.top)) + 'px';
      };
      hit.addEventListener('mousemove', show);
      hit.addEventListener('mouseleave', hide);
      hit.addEventListener('touchstart', show, { passive: true });
      hit.addEventListener('touchmove', show, { passive: true });
      hit.addEventListener('touchend', () => setTimeout(hide, 1600));
    }
    scaleChartText(root);
  }

  // Chart text is drawn in viewBox units, so it shrinks with the chart. Scale it back to
  // about 11px on screen (capped so the labels still fit their margins on a phone).
  const textScaler = 'ResizeObserver' in window ? new ResizeObserver(entries => {
    for (const en of entries) {
      const el = en.target, w = en.contentRect.width;
      if (w > 0) el.style.setProperty('--k', Math.min(1.9, Math.max(0.8, Number(el.dataset.vbw) / w)).toFixed(3));
    }
  }) : null;
  function scaleChartText(root) {
    for (const el of $$('[data-vbw]', root)) {
      const w = el.getBoundingClientRect().width;
      if (w > 0) el.style.setProperty('--k', Math.min(1.9, Math.max(0.8, Number(el.dataset.vbw) / w)).toFixed(3));
      textScaler?.observe(el);
    }
  }

  // ---------- shared pieces ----------
  const thumb = (p, cls = '') => {
    const letter = (p.title || '?').replace(/^sample\s+/i, '').trim().charAt(0).toUpperCase() || '?';
    return `<span class="thumb ${esc(p.account)} ${cls}" aria-hidden="true">${esc(letter)}</span>`;
  };
  const videoTitle = (p, { date = true } = {}) => `<div class="vtitle">${thumb(p)}<div><div class="t">${
    p.permalink ? `<a href="${esc(p.permalink)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)
  }</div><div class="m">${accDot(p.account)}${esc(accShort(p.account))} · ${esc(p.format || 'Reel')}${date ? ' · ' + esc(dayLabel(p.posted)) : ''}${p.boosted ? ' · <span class="chip warn" style="padding:0 7px">Boosted</span>' : ''}</div></div></div>`;

  const sampleFlag = () => usingSample()
    ? `<div class="sample-flag" role="note"><b>Sample numbers</b><span>These are made up to show how this page reads. Real numbers replace them once Instagram Insights are loaded.</span></div>` : '';
  const samplePill = () => (usingSample() ? '<span class="pill-sample">Sample</span>' : '');

  const nextPromPost = () => D.schedule.items.find(it => it.kind === 'post' && it.date > period().end && (it.accounts || []).includes('@prometrausa'));
  function noNumbers(what) {
    const first = nextPromPost();
    return `<div class="empty"><b>No ${esc(what)} loaded yet</b>
      <span>Numbers start once Venelt has read access to Instagram Insights for @prometrausa, the METO Movement account and @dromavi.${first ? ` The next @prometrausa post is planned for ${esc(dayLabel(first.date))}.` : ''}</span>
      ${!hasReal && SAMPLE.length ? '<button class="chip info" type="button" data-action="sample-on">Show sample numbers</button>' : ''}
    </div>`;
  }

  function slideHead(i, eyebrow, headline, lede = '', extra = '') {
    return `<header class="slide-head"><div class="eyebrow"><span>${String(i + 1).padStart(2, '0')} / ${String(SLIDES.length).padStart(2, '0')}</span><span>${esc(eyebrow)}</span>${extra}</div><h2>${headline}</h2>${lede ? `<p class="lede">${lede}</p>` : ''}</header>`;
  }

  const scopeLabel = () => (state.account === 'all' ? 'all three accounts' : accName(state.account));

  // ---------- slide: overview ----------
  function renderOverview(i) {
    const w = curWeek(), pw = prevWeek(), per = period();
    const posts = postsOf(w);
    const views = M.views(w), pviews = M.views(pw);
    const top = posts.filter(p => isNum(p.views)).sort((a, b) => b.views - a.views)[0];
    let headline;
    if (!w) headline = 'Instagram numbers start with the first tracked posts.';
    else if (!isNum(views)) headline = 'Instagram numbers for this week are not in yet.';
    else {
      const d = delta(views, pviews);
      const change = d === Infinity ? ', up from none last week.'
        : !isNum(d) ? '.'
        : Math.abs(d) < 0.5 ? ', about the same as last week.'
        : `, ${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(0)}% from last week.`;
      headline = `${compact(views)} views across ${esc(scopeLabel())}${change}`;
    }
    const stats = [
      { label: 'Accounts reached', fn: M.reach, fmt: compact },
      { label: 'Watched, on average', fn: M.watched, fmt: v => (isNum(v) ? `${v.toFixed(0)}<small>%</small>` : '–'), pts: true },
      { label: 'New followers', fn: M.follows, fmt: fmt },
      { label: 'MOVEMENT comments', fn: M.keyword, fmt: fmt },
    ];
    const color = state.account === 'all' ? 'var(--acc-all)' : `var(--acc-${state.account})`;
    const statHTML = stats.map(s => {
      const cur = s.fn(w), prev = s.fn(pw);
      const d = s.pts ? (isNum(cur) && isNum(prev) ? cur - prev : null) : delta(cur, prev);
      return `<div class="stat"><div class="label">${esc(s.label)}</div><div class="value">${w ? s.fmt(cur) : '–'}</div>${w ? sparkline(history(s.fn), { color, w: 96, h: 34, label: s.label + ' over recent weeks' }) : ''}<div class="foot">${w ? deltaHTML(d, { pts: s.pts }) : 'Waiting on Insights'}</div></div>`;
    }).join('');

    const nextItems = D.schedule.items.filter(it => it.date > per.end && !it.onHold && (it.kind === 'post' || it.kind === 'boost') && itemInScope(it)).slice(0, 4);
    const goal = R.targets.goals.find(g => g.account === (state.account === 'all' ? 'prometrausa' : state.account)) || R.targets.goals[0];
    const firstProm = nextPromPost();

    return `
      <div class="cover-blobs" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="cover-inner">
        <div class="cover-title">
          <div class="eyebrow">${String(i + 1).padStart(2, '0')} / ${String(SLIDES.length).padStart(2, '0')} · Weekly report · ${esc(R.client)}</div>
          <h1>Week of <em>${esc(rangeLabel(per.start, per.end))}</em></h1>
          <p>${headline} ${samplePill()}</p>
        </div>
        ${sampleFlag()}
        <div class="hero-row">
          <div class="hero-fig">
            <div class="eyebrow">Views · ${esc(scopeLabel())}</div>
            <div class="big">${w ? compact(views) : '–'}</div>
            ${w ? `<span class="delta">${deltaHTML(delta(views, pviews)).replace(/class="delta-(up|down|flat)"/, 'style="color:inherit"')}</span>` : '<span class="delta">Waiting on Insights access</span>'}
            ${w ? sparkline(history(M.views), { color: '#F3C66B', w: 300, h: 56, label: 'Views over recent weeks' }) : ''}
          </div>
          <div class="stat-bubbles">${statHTML}</div>
        </div>
        <div class="cover-bottom">
          <div class="card card-plain">
            <div class="eyebrow">Top video</div>
            ${top ? `<div style="margin-top:10px">${videoTitle(top)}</div>
              <div class="ret-nums" style="margin-top:12px"><div><b>${compact(top.views)}</b><span>views</span></div><div><b>${pct(watched(top))}</b><span>watched</span></div><div><b>${fmt(top.shares)}</b><span>shares</span></div></div>`
              : `<p class="sub" style="margin-top:8px">The top video shows here once posts have numbers.</p>`}
          </div>
          <div class="card card-plain">
            <div class="eyebrow">Going out next</div>
            <div class="mini-list">${nextItems.length ? nextItems.map(it => `<div class="mini-item"><time>${esc(dayLabel(it.date))}</time><span>${it.kind === 'boost' ? '<span class="chip warn" style="padding:0 7px">Boost</span> ' : ''}${esc(it.title)} <span class="sub">${esc((it.accounts || []).join(' + '))}</span></span></div>`).join('') : '<span class="sub">Nothing scheduled for this view.</span>'}</div>
          </div>
          <div class="card card-plain">
            <div class="eyebrow">Where things stand</div>
            <ul class="plain-list" style="margin-top:10px">
              ${firstProm ? `<li><b>Next @prometrausa post:</b> ${esc(dayLabel(firstProm.date))}, ${esc(firstProm.title)}.</li>` : ''}
              <li><b>Boosts:</b> ${R.boost.approved ? 'caps approved.' : 'waiting on Dr. Omavi to approve the monthly caps.'}</li>
              ${goal ? `<li><b>Goal:</b> ${esc(goal.label)}, ${fmt(goal.target)} by ${esc(shortDate(goal.by))}.</li>` : ''}
            </ul>
          </div>
        </div>
      </div>
      <div class="cover-strip" aria-hidden="true"></div>`;
  }

  // ---------- slide: views ----------
  function renderViews(i) {
    const w = curWeek();
    const posts = postsOf(w).filter(p => isNum(p.views)).sort((a, b) => b.views - a.views);
    const head = posts.length
      ? `<em style="font-style:normal">${esc(posts[0].title)}</em> led the week with ${compact(posts[0].views)} views.`
      : 'Views per video, and how the weekly total is moving.';
    const max = posts.length ? niceMax(posts[0].views) : 1;
    const bars = posts.length ? `<div class="bars">${posts.map(p => `
        <div class="bar-row">${videoTitle(p)}
          <div class="bar-track" title="${esc(p.title)}: ${fmt(p.views)} views"><div class="bar-fill ${esc(p.account)}" style="width:${Math.max(0.6, (p.views / max) * 88).toFixed(1)}%"></div><span class="bar-val num">${fmt(p.views)}</span></div>
        </div>`).join('')}</div>` : noNumbers('video views');

    const ws = weeks(), wi = weekIndex();
    const span = ws.slice(Math.max(0, wi - 5), wi + 1);
    const labels = span.map(x => shortDate(x.start));
    const ids = state.account === 'all' ? ACC_IDS : [state.account];
    const series = ids.map(id => ({ label: accName(id), color: `var(--acc-${id})`, values: span.map(x => statFor(x, 'views', 'views', id)) }));

    return `${slideHead(i, 'Views', head, 'Every video posted this week, ranked by views. Bar color shows the account.', samplePill())}
      ${sampleFlag()}
      <div class="grid cols-2" style="align-items:start">
        <div>${bars}</div>
        <div class="card card-plain"><h3>Weekly views</h3><p class="sub" style="margin-bottom:10px">Total views per week, by account</p>${span.length ? lineChart({ labels, series, title: 'Weekly views by account' }) : noNumbers('weekly totals')}</div>
      </div>`;
  }

  // ---------- slide: retention ----------
  function renderRetention(i) {
    const w = curWeek();
    const posts = postsOf(w).filter(p => isNum(watched(p)) || p.retention);
    const avg = weightedWatched(posts);
    const best = posts.slice().sort((a, b) => (watched(b) ?? 0) - (watched(a) ?? 0))[0];
    const head = posts.length
      ? `People watched ${pct(avg)} of the average video. <em style="font-style:normal">${esc(best.title)}</em> held attention longest.`
      : 'How long people keep watching each video.';
    const cards = posts.length ? `<div class="ret-grid">${posts.map(p => {
      const color = `var(--acc-${p.account})`;
      const wv = watched(p);
      return `<article class="ret-card ${p === best ? 'best' : ''}">
          ${videoTitle(p)}
          <div class="ret-nums">
            <div><b>${pct(wv)}</b><span>watched on average</span></div>
            <div><b>${isNum(p.skipRate) ? pct(p.skipRate) : '–'}</b><span>skipped in 3 sec</span></div>
            <div><b>${isNum(p.avgWatchSec) ? p.avgWatchSec.toFixed(0) + 's' : '–'}</b><span>of ${isNum(p.lengthSec) ? p.lengthSec + 's' : '?'}</span></div>
          </div>
          ${p.retention && p.retention.length > 2 ? retentionChart(p.retention, color, null) : '<p class="sub">Curve not entered yet. Copy it from the reel\'s Insights in the Instagram app.</p>'}
          ${p === best ? '<span class="chip warn">' + I.star + ' Best hold this week</span>' : ''}
        </article>`;
    }).join('')}</div>` : noNumbers('watch-time numbers');
    return `${slideHead(i, 'Retention', head, 'Each curve starts with 100 people who began the video and shows how many were still watching at each point. A flatter curve means the video kept its audience.', samplePill())}
      ${sampleFlag()}${cards}`;
  }

  // ---------- slide: every video ----------
  const COLS = [
    { key: 'posted', label: 'Posted', get: p => p.posted, show: p => esc(dayLabel(p.posted)) },
    { key: 'views', label: 'Views', get: p => p.views },
    { key: 'reach', label: 'Reach', get: p => p.reach, floor: 'reach' },
    { key: 'watched', label: 'Watched', get: p => watched(p), show: p => pct(watched(p)) },
    { key: 'skipRate', label: 'Skipped', get: p => p.skipRate, show: p => pct(p.skipRate) },
    { key: 'likes', label: 'Likes', get: p => p.likes },
    { key: 'comments', label: 'Comments', get: p => p.comments },
    { key: 'keywordComments', label: 'MOVEMENT', get: p => p.keywordComments, floor: 'keywordComments' },
    { key: 'shares', label: 'Shares', get: p => p.shares, floor: 'shares' },
    { key: 'saves', label: 'Saves', get: p => p.saves },
    { key: 'follows', label: 'Follows', get: p => p.follows, floor: 'follows' },
    { key: 'linkClicks', label: 'Link clicks', get: p => p.linkClicks, floor: 'linkClicks' },
  ];
  let sortKey = 'views', sortDir = -1;
  function floorFor(account, metric) { return R.targets.perPost.find(f => f.account === account && f.metric === metric); }
  function renderTable(i) {
    const w = curWeek();
    const posts = postsOf(w).slice().sort((a, b) => {
      const col = COLS.find(c => c.key === sortKey);
      const va = col.get(a), vb = col.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir;
    });
    const cell = (p, c) => {
      const v = c.get(p);
      const txt = c.show ? c.show(p) : fmt(v);
      if (!c.floor || !isNum(v)) return `<td>${v == null ? '<span class="na">–</span>' : txt}</td>`;
      const f = floorFor(p.account, c.floor);
      if (!f) return `<td>${txt}</td>`;
      const ok = v >= f.floor;
      return `<td title="Day-7 floor: ${fmt(f.floor)} ${esc(f.label)}">${txt} <span class="${ok ? 'hit' : 'miss'}" aria-label="${ok ? 'meets' : 'below'} the day-7 floor of ${fmt(f.floor)}">${ok ? '✓' : '↓'}</span></td>`;
    };
    const table = posts.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Scorecard, scrolls sideways"><table class="scorecard">
        <thead><tr><th scope="col">Video</th>${COLS.map(c => `<th scope="col" ${sortKey === c.key ? `aria-sort="${sortDir < 0 ? 'descending' : 'ascending'}"` : ''}><button type="button" data-sort="${c.key}">${esc(c.label)}${sortKey === c.key ? `<span aria-hidden="true">${sortDir < 0 ? ' ↓' : ' ↑'}</span>` : ''}</button></th>`).join('')}</tr></thead>
        <tbody>${posts.map(p => `<tr><td>${videoTitle(p, { date: false })}</td>${COLS.map(c => cell(p, c)).join('')}</tr>`).join('')}</tbody>
      </table></div>` : noNumbers('post numbers');
    const floors = ACC_IDS.filter(inScope).map(id => {
      const fs = R.targets.perPost.filter(f => f.account === id);
      return fs.length ? `<li><b>${esc(accName(id))}, by day 7:</b> ${fs.map(f => `${fmt(f.floor)} ${esc(f.label)}`).join(', ')}</li>` : '';
    }).join('');
    return `${slideHead(i, 'Every video', 'The scorecard: every post, every number.', 'Tap a column to sort. A check means the post already meets its day-7 floor from the Q4 plan. An arrow means it is still below it.', samplePill())}
      ${sampleFlag()}${table}
      <div class="slide-foot"><ul class="plain-list">${floors}</ul></div>`;
  }

  // ---------- slide: funnel & goals ----------
  // Progress toward a goal, counted from the week that holds the Sep 25 baseline, up to the
  // selected week and never past the goal's deadline. A monthly goal counts only the weeks
  // that end in its month.
  const BASE_WEEK = '2026-09-21';
  function goalProgress(g) {
    const cur = curWeek();
    if (!cur) return null;
    let ws = weeks().filter(x => x.start <= cur.start && x.start <= g.by);
    if (!usingSample()) {
      ws = ws.filter(x => x.start >= BASE_WEEK);
      if (g.period === 'month') ws = ws.filter(x => x.end.slice(0, 7) === g.by.slice(0, 7));
    }
    let val = 0, any = false;
    for (const x of ws) {
      let v = null;
      if (g.unit === 'follows') {
        const ids = g.account === 'all' ? ACC_IDS : [g.account];
        for (const id of ids) {
          const a = x.accounts?.[id]?.newFollowers;
          const pv = isNum(a) ? a : sumKey((x.posts || []).filter(p => p.account === id), 'follows');
          if (isNum(pv)) v = (v ?? 0) + pv;
        }
      } else if (g.unit === 'sign-ups') v = x.funnel?.signups;
      else if (g.unit === 'applications') v = x.funnel?.applications;
      else if (g.unit === 'comments') v = keywordFor(x, 'all');
      else if (g.unit === 'ambassadors') v = x.funnel?.ambassadors;
      if (isNum(v)) { val += v; any = true; }
    }
    return any ? val : null;
  }
  function renderFunnel(i) {
    const w = curWeek();
    const raw = w?.funnel || {};
    // Nehanda's Friday counts first; Instagram numbers fill the steps she does not send.
    const f = {
      ...raw,
      reach: raw.reach ?? statFor(w, 'reach', 'reach', 'all'),
      keywordComments: keywordFor(w, 'all'),
      linkClicks: raw.linkClicks ?? sumKey(w?.posts || [], 'linkClicks'),
    };
    const steps = [
      { k: 'reach', l: 'Accounts reached' },
      { k: 'keywordComments', l: 'MOVEMENT comments' },
      { k: 'dmsDelivered', l: 'Course links sent by DM' },
      { k: 'linkClicks', l: 'Link clicks' },
      { k: 'signups', l: 'Curriculum sign-ups' },
      { k: 'applications', l: 'Pilgrimage applications' },
      { k: 'seats', l: 'Seats confirmed' },
    ];
    const haveFunnel = steps.some(s => isNum(f[s.k]));
    const funnel = haveFunnel ? `<div class="funnel">${steps.map((s, k) => {
      const v = f[s.k], prev = k ? f[steps[k - 1].k] : null;
      const rate = k && isNum(v) && isNum(prev) && prev > 0 ? (v / prev) * 100 : null;
      const rateTxt = isNum(rate) ? `${rate < 1 ? rate.toFixed(2) : rate.toFixed(rate < 10 ? 1 : 0)}%` : '';
      return `<div class="f-step"><div class="v num">${fmt(v)}</div><div class="l">${esc(s.l)}</div>${k ? `<div class="rate">${rateTxt ? `<b>${rateTxt}</b> of the step before` : ''}</div>` : '<div class="rate">Top of the funnel</div>'}</div>`;
    }).join('')}</div>` : noNumbers('funnel counts');
    const parts = [
      isNum(f.keywordComments) && plural(f.keywordComments, 'MOVEMENT comment'),
      isNum(f.signups) && plural(f.signups, 'curriculum sign-up'),
      isNum(f.applications) && plural(f.applications, 'application'),
    ].filter(Boolean);
    const head = parts.length ? `This week: ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : 'From a view to a seat on the trip.';

    const endDay = period().end;
    const base = '2026-09-25';
    const meters = R.targets.goals.filter(g => g.account === 'all' || inScope(g.account)).map(g => {
      const v = goalProgress(g);
      const tgt = g.target;
      const total = (parseDay(g.by) - parseDay(base)) / 864e5;
      const elapsed = Math.max(0, Math.min(total, (parseDay(endDay) - parseDay(base)) / 864e5));
      const expected = tgt * (elapsed / total);
      let chip;
      if (usingSample() && isNum(v)) chip = '<span class="pill-sample">Sample</span>';
      else if (!isNum(v)) chip = '<span class="chip ghost">Not measured yet</span>';
      else if (v >= tgt) chip = `<span class="chip good">${I.check} Goal reached</span>`;
      else if (v >= expected) chip = `<span class="chip good">${I.check} On pace</span>`;
      else chip = `<span class="chip warn">${I.alert.replace('viewBox="0 0 20 20"', 'viewBox="0 0 20 20" width="12" height="12"')} Behind pace</span>`;
      const tick = g.checkpoint ? `<i class="meter-tick" style="left:${Math.min(100, (g.checkpoint.target / tgt) * 100)}%" data-label="${esc(shortDate(g.checkpoint.by))}: ${fmt(g.checkpoint.target)}"></i>` : '';
      return `<div class="meter ${g.checkpoint ? 'has-tick' : ''}">
          <div class="meter-head"><b>${accDot(g.account === 'all' ? 'all' : g.account)} ${esc(g.label)}</b><span class="num">${isNum(v) ? fmt(v) : '–'} of ${fmt(tgt)} by ${esc(shortDate(g.by))}</span></div>
          <div class="meter-track" role="img" aria-label="${esc(g.label)}: ${isNum(v) ? fmt(v) : 'not measured'} of ${fmt(tgt)}"><div class="meter-fill" style="width:${isNum(v) ? Math.min(100, (v / tgt) * 100).toFixed(1) : 0}%"></div>${tick}</div>
          <div class="meter-foot">${chip}${g.stretch ? `<span class="sub">Then ${fmt(g.stretch.target)} by ${esc(shortDate(g.stretch.by))}</span>` : ''}</div>
        </div>`;
    }).join('');

    const ladder = R.ladder.steps.map((s, k) => `
      <div class="ladder-row"><span class="sub">${esc(s.label)}</span><div><b>${esc(s.display)}</b>${k < R.ladder.steps.length - 1 ? ` <span class="chip ghost" style="margin-left:6px">about ${Math.round(s.value / R.ladder.steps[k + 1].value)}× the next step</span>` : ''}</div></div>`).join('');

    return `${slideHead(i, 'Funnel and goals', head, state.account === 'all' ? 'The funnel counts all three accounts together, because MOVEMENT comments on any of them lead to the same course.' : 'The funnel always counts all three accounts together. Goals below are filtered to this account.', samplePill())}
      ${sampleFlag()}${funnel}
      <div class="grid cols-2" style="margin-top:22px;align-items:start">
        <div class="card card-plain"><h3>Q4 goals ${samplePill()}</h3><p class="sub" style="margin-bottom:16px">${usingSample() ? 'Made-up progress, to show how the meters read. ' : ''}Counted from the week of Sep 21 (the Sep 25 baseline) through the week shown. The tick marks each checkpoint.</p><div class="meters">${meters}</div></div>
        <div class="card"><h3>What it takes to fill the trip</h3><p class="sub" style="margin-bottom:14px">${esc(R.ladder.note)}</p><div class="ladder">${ladder}</div></div>
      </div>`;
  }

  // ---------- slide: up next ----------
  function itemInScope(it) {
    if (state.account === 'all') return true;
    const on = [...(it.accounts || []), ...(it.alsoOn || [])];
    return on.some(a => HANDLE_TO_ID[a] === state.account);
  }
  const STAGE = {
    idea: 1, scripted: 1, 'to film': 1, 'needs approval': 1, 'client decision': 1, 'needs shoot': 1,
    filmed: 2, 'in edit': 2, 'needs reshoot': 2, 'needs edit': 2, 'needs re-cut': 2,
    ready: 3, scheduled: 3, exists: 3,
    posted: 4,
  };
  const STAGE_NAMES = { 1: 'To film or approve', 2: 'Filmed, in edit', 3: 'Ready or scheduled', 4: 'Posted' };
  const stageOf = s => STAGE[String(s || '').toLowerCase()] || 0;
  const stageChip = s => { const n = stageOf(s); return `<span class="stage-chip"><i class="s-${n}"></i>${esc(s || 'unknown')}</span>`; };
  function evCard(it) {
    return `<div class="ev ${esc(it.kind)} ${it.onHold ? 'hold' : ''}"><div class="k">${KIND_ICON[it.kind] || ''}${esc(KIND_LABEL[it.kind] || it.kind)}${it.onHold ? ' · on hold' : ''}${it.time ? `<span class="tm">${esc(time12(it.time))}</span>` : ''}</div>
      <div class="ti">${esc(it.title)}${it.amount ? ` <span class="num">$${it.amount}</span>` : ''}</div>
      ${it.accounts?.length ? `<div class="ac">${it.accounts.map(a => `<span>${accDot(HANDLE_TO_ID[a] || '')}${esc(a)}</span>`).join('')}</div>` : ''}
      ${it.gated && !it.onHold ? '<div class="ac"><span class="sub">Only if it earns 10 MOVEMENT comments in 48h</span></div>' : ''}
      ${it.format && it.format !== 'Reel' ? `<div class="ac"><span class="sub">${esc(it.format)}</span></div>` : ''}
      ${it.note ? `<div class="nt">${esc(it.note)}</div>` : ''}
    </div>`;
  }
  function renderNext(i) {
    const per = period();
    const from = addDays(per.end, 1);
    const items = D.schedule.items.filter(itemInScope);
    const days = Array.from({ length: 7 }, (_, k) => addDays(from, k));
    const inWeek = items.filter(it => it.date >= days[0] && it.date <= days[6]);
    const nPosts = inWeek.filter(x => x.kind === 'post').length, nBoost = inWeek.filter(x => x.kind === 'boost').length, nShoot = inWeek.filter(x => x.kind === 'shoot').length;
    const parts = [nPosts && plural(nPosts, 'post'), nBoost && plural(nBoost, 'boost'), nShoot && plural(nShoot, 'filming block')].filter(Boolean);
    const head = parts.length ? `${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')} in the week of ${esc(rangeLabel(days[0], days[6]))}.` : `Nothing is scheduled for ${esc(scopeLabel())} in the week of ${esc(rangeLabel(days[0], days[6]))}.`;
    const strip = `<div class="weekstrip">${days.map(d => {
      const its = inWeek.filter(x => x.date === d);
      const dt = parseDay(d);
      const wk = dt.getUTCDay() === 0 || dt.getUTCDay() === 6;
      return `<div class="day ${wk ? 'weekend' : ''} ${its.length ? '' : 'no-items'}"><div class="day-h"><span>${DAYS[dt.getUTCDay()]}</span><b>${dt.getUTCDate()}</b></div>${its.map(evCard).join('') || '<span class="sub" style="padding:2px 4px">Open</span>'}</div>`;
    }).join('')}</div>`;

    const later = items.filter(it => it.date > days[6] && it.kind !== 'shoot');
    const byWeek = new Map();
    for (const it of later) {
      const ws = (() => { const d = parseDay(it.date); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return isoDay(d); })();
      if (!byWeek.has(ws)) byWeek.set(ws, []);
      byWeek.get(ws).push(it);
    }
    const agenda = [...byWeek].map(([ws, its]) => `
      <div class="ag-week"><div><h4>${esc(rangeLabel(ws, addDays(ws, 6)))}</h4><div class="c">${plural(its.filter(x => x.kind === 'post').length, 'post')} · ${plural(its.filter(x => x.kind === 'boost').length, 'boost')}</div></div>
        <div class="ag-items">${its.map(it => `<div class="ag-item"><time>${esc(dayLabel(it.date).slice(0, 3))} ${esc(shortDate(it.date))}</time>${KIND_ICON[it.kind] || ''}<div><b style="font-weight:650">${esc(it.title)}</b>${it.amount ? ` <span class="num">$${it.amount}</span>` : ''}${it.note ? `<span class="nt">${esc(it.note)}</span>` : ''}<span class="meta">${(it.accounts || []).map(a => `<span>${accDot(HANDLE_TO_ID[a] || '')}${esc(a)}</span>`).join('')}${it.gated ? '<span class="chip warn">Only if it earns 10 MOVEMENT comments</span>' : ''}${it.organicOnly ? '<span class="chip ghost">Never boosted</span>' : ''}</span></div></div>`).join('')}</div>
      </div>`).join('');

    const series = (D.pipeline?.series || []).filter(s => state.account === 'all' || !s.account || s.account.includes(accName(state.account)) || (state.account === 'meto' && /METO/i.test(s.account)));
    const pipeline = series.map((s, k) => {
      const counts = [0, 0, 0, 0, 0];
      for (const it of s.items) counts[stageOf(it.status)]++;
      const total = s.items.length || 1;
      const ordered = s.items.slice().sort((a, b) => (a.order || 999) - (b.order || 999));
      return `<details class="series-card" ${k === 0 ? 'open' : ''}>
        <summary>
          <div class="top"><h3>${esc(s.name)}</h3><span class="sub">${s.items.length} pieces${s.account ? ' · ' + esc(s.account) : ''} <span class="caret">${I.chev}</span></span></div>
          ${s.summary ? `<p class="desc">${esc(s.summary)}</p>` : ''}
          <div class="stackbar" role="img" aria-label="${[1, 2, 3, 4].map(n => `${counts[n]} ${STAGE_NAMES[n].toLowerCase()}`).join(', ')}">${[4, 3, 2, 1, 0].map(n => counts[n] ? `<i class="s-${n}" style="width:${(counts[n] / total) * 100}%"></i>` : '').join('')}</div>
        </summary>
        <div class="items">${ordered.map(it => `<div class="item"><span class="code">${esc(it.code)}</span><div>${esc(it.title)}${it.pillar ? ` <span class="chip" style="margin-left:4px">${esc(it.pillar)}</span>` : ''}${it.note ? `<span class="nt">${esc(it.note)}</span>` : ''}</div>${stageChip(it.status)}</div>`).join('')}</div>
      </details>`;
    }).join('');

    const review = D.schedule.planReview;
    const lede = `From the Q4 plan (built Sep 24).${review && per.end < review ? ` Dr. Omavi reviews it on ${esc(dayLabel(review))}, so dates can move.` : ' Dates can move as pieces are filmed and approved.'}`;
    return `${slideHead(i, 'Up next', head, lede)}
      ${strip}
      <div class="grid cols-2" style="margin-top:22px;align-items:start">
        <div class="card card-plain"><h3>After that, through Nov 1</h3><p class="sub">Posts, boosts and deadlines. Filming days are on the week view.</p><div class="agenda" style="margin-top:6px">${agenda || '<p class="sub">Nothing else scheduled yet.</p>'}</div></div>
        <div><div class="card" style="margin-bottom:12px"><h3>In the pipeline</h3><p class="sub">Every video in production, by stage.</p>
          <div class="stage-key" style="margin-top:10px">${[1, 2, 3, 4].map(n => `<span><i class="s-${n}"></i>${STAGE_NAMES[n]}</span>`).join('')}</div></div>
          <div class="series">${pipeline || '<p class="sub">Pipeline data not loaded.</p>'}</div></div>
      </div>`;
  }

  // ---------- slide: ads ----------
  function renderAds(i) {
    const A = D.ads || {};
    const per = period();
    const ledger = R.boost.ledger.filter(r => state.account === 'all' || HANDLE_TO_ID[r.account] === state.account);
    const months = [...new Set(R.boost.ledger.map(r => r.month))].sort();
    const monthLabel = m => MONTHS[Number(m.slice(5, 7)) - 1] + (m.startsWith('2027') ? ' 2027' : '');
    const realAds = hasReal ? REAL.flatMap(w => (w.ads || []).map(a => ({ ...a, week: w.start }))) : usingSample() ? SAMPLE.flatMap(w => (w.ads || []).map(a => ({ ...a, week: w.start }))) : [];
    // An ad with no account only shows under "All accounts", so it is never counted twice.
    const scopedAds = realAds.filter(a => (a.account ? inScope(a.account) : state.account === 'all'));
    const weekAds = scopedAds.filter(a => a.week === curWeek()?.start);
    // Sample ads only illustrate the weekly table; the monthly plan compares real spend.
    const spentIn = m => (hasReal ? scopedAds : []).filter(a => (a.from || a.week).slice(0, 7) === m).reduce((s, a) => s + (a.spend || 0), 0);
    // Sample ads only fill the per-ad table; the headline, stats and board stay real.
    const liveAds = hasReal ? weekAds : [];
    const weekSpend = liveAds.reduce((s, a) => s + (a.spend || 0), 0);
    const weekResults = liveAds.reduce((s, a) => s + (a.results || 0), 0);
    // Results only add up when they are the same kind (link clicks and follows do not).
    const resultTypes = [...new Set(liveAds.filter(a => isNum(a.results)).map(a => a.resultType || 'results'))];
    const mixed = resultTypes.length > 1;
    const spentToDate = (hasReal ? scopedAds : []).reduce((s, a) => s + (a.spend || 0), 0);
    const curMonth = addDays(per.end, 1).slice(0, 7);
    const liveLedger = ledger.filter(r => !r.optional && !r.onHold);
    const plannedNext = liveLedger.filter(r => r.month === curMonth).reduce((s, r) => s + r.planned, 0);

    const running = (A.photoAds || []).filter(a => a.status === 'running').length + (A.videoAds || []).filter(a => a.status === 'running').length;
    const head = weekSpend
      ? `${money(weekSpend)} spent this week${mixed ? '' : ` for ${plural(weekResults, (resultTypes[0] || 'results').replace(/s$/, ''), resultTypes[0] || 'results')}`}.`
      : spentToDate
        ? `No boost ran this week. ${money(spentToDate)} spent so far.`
        : running
          ? 'Ads are live. Their spend shows here once the Ads Manager export is loaded.'
          : 'No paid ads are running yet. The first boosts launch once the budget is approved.';

    const statCards = [
      { l: `Planned for ${monthLabel(curMonth)}`, v: money(plannedNext), s: ledger.some(r => r.month === curMonth && r.onHold) ? 'from the boost plan; one boost on hold' : 'from the boost plan' },
      { l: 'Spent this week', v: liveAds.length ? money(weekSpend) : '$0', s: liveAds.length ? plural(liveAds.length, 'ad') : 'nothing live' },
      { l: 'Results this week', v: liveAds.length ? (mixed ? 'Mixed' : fmt(weekResults)) : '–', s: liveAds.length ? (mixed ? resultTypes.join(', ') : resultTypes[0] || 'results') : 'clicks, sign-ups or follows' },
      { l: 'Cost per result', v: weekResults && !mixed ? money(Math.round((weekSpend / weekResults) * 100) / 100) : '–', s: mixed ? 'see each ad below' : 'lower is better' },
    ].map(c => `<div class="stat"><div class="label">${esc(c.l)}</div><div class="value">${c.v}</div><div class="foot">${esc(c.s)}</div></div>`).join('');

    const monthMeters = months.filter(m => m <= '2026-12').map(m => {
      const planned = liveLedger.filter(r => r.month === m).reduce((s, r) => s + r.planned, 0);
      const opt = ledger.filter(r => r.month === m && r.optional).reduce((s, r) => s + r.planned, 0);
      const hold = ledger.filter(r => r.month === m && r.onHold && !r.optional).reduce((s, r) => s + r.planned, 0);
      const spent = spentIn(m);
      const cap = planned || 1;
      const extra = [opt && `+${money(opt)} optional`, hold && `+${money(hold)} on hold`].filter(Boolean).join(', ');
      return `<div class="meter spend"><div class="meter-head"><b>${esc(monthLabel(m))}</b><span class="num">${money(spent)} spent of ${money(planned)} planned${extra ? ` (${extra})` : ''}</span></div>
        <div class="meter-track" role="img" aria-label="${esc(monthLabel(m))}: ${money(spent)} of ${money(planned)}"><div class="meter-fill" style="width:${Math.min(100, (spent / cap) * 100)}%"></div></div></div>`;
    }).join('');

    const caps = R.boost.caps.filter(c => state.account === 'all' || HANDLE_TO_ID[c.account] === state.account).map(c =>
      `<div class="fact"><b>${money(c.monthly)}<span class="sub" style="font-size:13px"> a month</span></b><span>${accDot(HANDLE_TO_ID[c.account])} ${esc(c.account)}. ${esc(c.note)}</span></div>`).join('');

    const lane = (title, cards, emptyText) => {
      const head = cards.slice(0, 4).join(''), rest = cards.slice(4);
      return `<div class="lane"><div class="lane-h"><h4>${esc(title)}</h4><span class="n num">${cards.length}</span></div>
        ${cards.length ? head : `<div class="empty-lane">${esc(emptyText)}</div>`}
        ${rest.length ? `<details><summary>Show ${rest.length} more</summary><div>${rest.join('')}</div></details>` : ''}</div>`;
    };
    const adCard = (id, name, desc, chip = '') => `<div class="adcard"><span class="id">${esc(id)}</span><span class="nm">${esc(name)}</span>${desc ? `<span class="ds">${esc(desc)}</span>` : ''}${chip}</div>`;
    const photo = A.photoAds || [], video = A.videoAds || [], filmed = A.filmed || [], toFilm = A.toFilm || [];
    const flight = a => a.flightStart ? `${shortDate(a.flightStart)}${a.flightEnd ? ' to ' + shortDate(a.flightEnd) : ''}` : '';
    const runningCards = [
      ...photo.filter(a => a.status === 'running').map(a => adCard(a.id, a.name, [a.format, flight(a)].filter(Boolean).join(' · '))),
      ...video.filter(a => a.status === 'running').map(a => adCard(a.id, a.name, a.group)),
      ...liveAds.map(a => adCard(a.unit || 'Ad', a.name, `${money(a.spend)} · ${fmt(a.results)} ${a.resultType || 'results'}`)),
    ];
    const readyCards = [
      ...photo.filter(a => a.status === 'ready').map(a => adCard(a.id, a.name, [a.format, flight(a)].filter(Boolean).join(' · '))),
      ...video.filter(a => ['ready', 'filmed'].includes(a.status)).map(a => adCard(a.id, a.name, a.group)),
      ...filmed.filter(a => a.verdict === 'ready for paid').map(a => adCard(a.clip, a.title, a.length)),
    ];
    const fixCards = filmed.filter(a => a.verdict === 're-cut for paid' || a.verdict === 're-shoot')
      .map(a => adCard(`${a.clip} · ${a.length || ''}`, a.title, a.short, `<span class="chip ${a.verdict === 're-shoot' ? 'crit' : 'warn'}">${a.verdict === 're-shoot' ? 'Re-shoot' : 'Re-cut for paid'}</span>`));
    // Re-cuts and re-shoots already sit in their own lane.
    const filmCards = toFilm.filter(a => !/^(Paid re-cuts|C0676 re-shoot)/.test(a.name))
      .map(a => adCard(a.when && a.when.length < 48 ? a.when : 'To film', a.name, firstSentence(a.why)));
    const organic = filmed.filter(a => a.verdict === 'organic only');

    const groups = [...new Set(video.map(v => v.group))];
    const statusChip = st => st === 'needs approval' ? '<span class="chip warn">Needs sign-off</span>' : st === 'scripted' ? '<span class="chip ghost">Script ready</span>' : `<span class="chip">${esc(st)}</span>`;
    const library = `
      <div class="grid cols-2" style="margin-top:16px;align-items:start">
        <details class="series-card"><summary><div class="top"><h3>${video.length} video ad scripts</h3><span class="sub">${video.filter(v => v.status === 'needs approval').length} need sign-off · none filmed <span class="caret">${I.chev}</span></span></div>
          <p class="desc">${groups.map(g => `${esc(g)} (${video.filter(v => v.group === g).length})`).join(', ')}.</p></summary>
          <div class="items">${video.map(v => `<div class="item"><span class="code">${esc(v.id)}</span><div>${esc(v.name)}<span class="nt">${esc(v.group)}. ${esc(v.short || '')}</span></div>${statusChip(v.status)}</div>`).join('')}</div>
        </details>
        <details class="series-card"><summary><div class="top"><h3>${photo.length} photo ads</h3><span class="sub">In design, on placeholder images <span class="caret">${I.chev}</span></span></div>
          <p class="desc">Real photos have to replace the placeholders before any of these can run.</p></summary>
          <div class="items">${photo.map(a => `<div class="item"><span class="code">${esc(a.id)}</span><div>${esc(a.name)}<span class="nt">${esc([a.format, flight(a) && 'planned ' + flight(a)].filter(Boolean).join(', '))}. ${esc(a.short || '')}</span></div><span class="chip ghost">${esc(a.status)}</span></div>`).join('')}</div>
        </details>
      </div>`;

    const convRows = weekAds.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Spend and results per ad"><table><thead><tr><th scope="col">Ad</th><th scope="col">Spend</th><th scope="col">Results</th><th scope="col">Per result</th></tr></thead><tbody>${weekAds.map(a => `<tr><td><b>${esc(a.name)}</b><div class="sub">${a.account ? accDot(a.account) + ' ' + esc(accShort(a.account)) + ' · ' : ''}${esc(a.resultType || 'results')} · ${fmt(a.impressions)} impressions</div></td><td>${money(a.spend)}</td><td>${fmt(a.results)}</td><td>${a.results ? money(Math.round((a.spend / a.results) * 100) / 100) : '–'}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty"><b>No paid results yet</b><span>Spend and conversions show here, per ad, once the first boost runs. Load them with the Ads Manager export.</span></div>`;

    return `${slideHead(i, 'Ads', head, 'What is live, what is ready, what still needs filming, and where the money goes.')}
      <div class="callout info">${I.info}<div><p><b>Right now:</b> ${esc(A.liveStatus || 'No live ads confirmed.')}</p><p>${esc(R.boost.approved ? 'Monthly caps are approved.' : 'The monthly boost caps are waiting on Dr. Omavi\'s approval at the Sep 28 meeting. Nothing is spent before that.')}</p></div></div>
      <div class="stat-bubbles" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));margin-top:16px">${statCards}</div>
      <h3 style="margin:26px 0 12px;font-size:20px">The ad board</h3>
      <div class="board">
        ${lane('Running', runningCards, 'Nothing is live yet.')}
        ${lane('Ready to launch', readyCards, 'Nothing is waiting to launch.')}
        ${lane('Needs a re-cut or re-shoot', fixCards, 'Nothing to fix.')}
        ${lane('To film or make', filmCards, 'Nothing left to film.')}
      </div>
      ${organic.length ? `<p class="slide-foot">Also filmed Aug 22, organic only (never paid): ${organic.map(a => esc(a.title)).join(', ')}.</p>` : ''}
      ${library}
      <div class="grid cols-2" style="margin-top:24px;align-items:start">
        <div class="card card-plain"><h3>Spend plan, by month</h3><p class="sub" style="margin-bottom:14px">${esc(R.boost.run)}</p><div class="meters">${monthMeters}</div>
          <div class="caps">${caps}</div></div>
        <div class="card card-plain"><h3>Spend and conversions this week ${!hasReal && weekAds.length ? samplePill() : ''}</h3><p class="sub" style="margin-bottom:14px">${!hasReal && weekAds.length ? 'A made-up row, to show how results will read. ' : ''}One row per ad from the Ads Manager export.</p>${convRows}</div>
      </div>
      <div class="grid cols-2" style="margin-top:16px;align-items:start">
        <div class="card"><h3>The rules we buy by</h3><ul class="rules" style="margin-top:10px">${(A.rules && A.rules.length ? A.rules : [R.boost.gate]).map(r => `<li>${I.ban}<span>${esc(r)}</span></li>`).join('')}</ul></div>
        <div class="card"><h3>Who sees the ads</h3>${moreList((A.audiences || []).map(a => `<li><b>${esc(a.id)}:</b> ${esc(a.definition)}</li>`), 4, 'audiences') || '<p class="sub">Audiences are set in Ads Manager.</p>'}</div>
      </div>`;
  }
  const firstSentence = t => String(t || '').split(/(?<=\.)\s/)[0];
  // A list that shows the first few items and tucks the rest behind "Show more".
  function moreList(lis, n, what) {
    if (!lis.length) return '';
    const head = `<ul class="plain-list" style="margin-top:10px">${lis.slice(0, n).join('')}</ul>`;
    const rest = lis.slice(n);
    return head + (rest.length ? `<details class="more"><summary>Show ${rest.length} more ${esc(what)}</summary><ul class="plain-list">${rest.join('')}</ul></details>` : '');
  }
  function shortDateSafe(s) { return /^\d{4}-\d{2}-\d{2}/.test(s) ? shortDate(s) : s; }

  // ---------- slide: the app ----------
  function renderApp(i) {
    const P = D.app;
    if (!P) return `${slideHead(i, 'The app', 'The METO app, screen by screen.')}<p class="sub">App map not loaded.</p>`;
    // Count real screens only: the shell area (header, tabs, footer, install) frames them.
    const pageAreas = P.areas.filter(a => a.kind !== 'shell');
    const screens = pageAreas.flatMap(a => a.screens).filter(s => s.status !== 'planned');
    const live = screens.filter(s => s.status === 'live').length, partial = screens.length - live;
    const planned = P.areas.flatMap(a => a.screens).filter(s => s.status === 'planned');
    const head = `The METO app has ${screens.length} screens in ${pageAreas.length} parts: ${live} fully live${partial ? ` and ${partial} partly built` : ''}.${planned.length ? ` ${esc(planned.map(s => s.name).join(', '))} ${planned.length === 1 ? 'is' : 'are'} planned.` : ''}`;
    const facts = (P.app.facts || []).map(f => `<div class="fact"><b>${esc(f.value)}</b><span>${esc(f.label)}</span></div>`).join('');
    const journey = (P.journey || []).map((s, k) => `<div class="j-step"><span class="n">Step ${k + 1}</span><b>${esc(s.label)}</b><p>${esc(s.detail)}</p></div>`).join('');
    const phone = s => {
      const blocks = s.sections || [];
      const shown = blocks.slice(0, 7);
      return `<div class="phone-col">
        <div class="phone ${s.status === 'planned' ? 'planned' : ''}" role="img" aria-label="${esc(s.name)} screen: ${esc(blocks.join(', '))}">
          <div class="url">${esc(s.route || '/')}</div>
          ${shown.map((b, k) => `<div class="blk ${k === 0 ? 'hero' : ''}"><span>${esc(b)}</span></div>`).join('')}
          ${blocks.length > shown.length ? `<div class="more-blk">+${plural(blocks.length - shown.length, 'more section', 'more sections')}</div>` : ''}
        </div>
        <div class="phone-cap"><b>${esc(s.name)}</b><p>${esc(s.job)}</p>
          <span class="chip ${s.status === 'live' ? 'good' : s.status === 'partial' ? 'warn' : 'ghost'}">${s.status === 'live' ? I.check + ' Live' : s.status === 'partial' ? 'Partly built' : 'Planned'}</span>
          ${s.note ? `<details class="more"><summary>Details</summary><p class="sub">${esc(s.note)}</p></details>` : ''}</div>
      </div>`;
    };
    const areas = P.areas.map(a => `<section class="area" aria-label="${esc(a.name)}"><div class="area-h"><h3>${esc(a.name)}</h3><p>${esc(a.blurb)}</p><span class="chip">${plural(a.screens.length, 'screen')}</span></div><div class="phones" tabindex="0" role="region" aria-label="${esc(a.name)} screens, scrolls sideways">${a.screens.map(phone).join('')}</div></section>`).join('');
    return `${slideHead(i, 'The app', head, `${esc(P.app.oneLiner)} ${P.app.url ? `<a href="${esc(P.app.url)}" target="_blank" rel="noopener">Open the live app</a>.` : ''}`)}
      <div class="app-facts app-facts-grid">${facts}</div>
      ${P.app.status ? `<p class="slide-foot" style="margin-top:12px">${esc(P.app.status)} ${esc(P.app.builtWith || '')}</p>` : ''}
      <h3 style="margin:24px 0 10px;font-size:19px">How someone finds and uses it</h3>
      <div class="journey">${journey}</div>
      <div style="display:grid;gap:22px;margin-top:26px">${areas}</div>
      <div class="twocol-list" style="margin-top:26px">
        <div class="card"><h3>Asked for, not built yet</h3>${moreList((P.requested || []).map(r => `<li><b>${esc(r.name)}.</b> ${esc(r.detail)}</li>`), 6, 'requests')}</div>
        <div class="card"><h3>Open questions</h3>${moreList((P.openQuestions || []).map(q => `<li>${esc(q)}</li>`), 6, 'questions')}</div>
      </div>`;
  }

  // ---------- slide: asks ----------
  function renderAsks(i) {
    const groups = D.asks?.groups || [{ title: '', items: D.asks?.items || [] }];
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    const ICONS = { access: I.key, decision: I.ask, budget: I.money, data: I.chart };
    const ask = a => `<div class="ask"><span class="ic">${ICONS[a.kind] || I.ask}</span><div><b>${esc(a.title)}</b><p>${esc(a.detail)}</p><div class="meta">${a.owner ? `<span class="chip">${esc(a.owner)}</span>` : ''}${a.due ? `<span class="chip warn">${/^\d{4}-/.test(a.due) ? 'By ' + esc(shortDate(a.due)) : esc(a.due)}</span>` : ''}${a.unlocks ? `<span class="chip ghost">Unlocks: ${esc(a.unlocks)}</span>` : ''}</div></div></div>`;
    return `${slideHead(i, 'What we need', `${total} things we need to keep this moving.`, 'Each one unlocks a number on this report, a post on the calendar, or the first ad dollar.')}
      <div class="ask-groups">${groups.map(g => `<section class="ask-group">${g.title ? `<h3>${esc(g.title)} <span class="chip">${g.items.length}</span></h3>` : ''}<div class="asks">${g.items.map(ask).join('')}</div></section>`).join('')}</div>`;
  }

  // ---------- deck ----------
  const SLIDES = [
    { id: 'overview', nav: 'Overview', render: renderOverview, cls: 'cover' },
    { id: 'views', nav: 'Views', render: renderViews },
    { id: 'retention', nav: 'Retention', render: renderRetention },
    { id: 'videos', nav: 'Every video', render: renderTable },
    { id: 'funnel', nav: 'Funnel & goals', render: renderFunnel },
    { id: 'next', nav: 'Up next', render: renderNext },
    { id: 'ads', nav: 'Ads', render: renderAds },
    { id: 'app', nav: 'The app', render: renderApp },
    { id: 'asks', nav: 'What we need', render: renderAsks },
  ];

  function renderControls() {
    const ws = weeks(), wi = weekIndex();
    const per = period();
    const accBtns = [['all', 'All accounts'], ...ACC_IDS.map(id => [id, accShort(id)])]
      .map(([id, label]) => `<button type="button" data-account="${id}" aria-pressed="${state.account === id}">${id === 'all' ? '' : accDot(id)}${esc(label)}</button>`).join('');
    $('#controls').innerHTML = `
      <div class="seg" role="group" aria-label="Account">${accBtns}</div>
      <div class="weekpick" role="group" aria-label="Week">
        <button type="button" data-week="-1" aria-label="Previous week" ${wi <= 0 ? 'disabled' : ''}>${I.left}</button>
        <output>${esc(rangeLabel(per.start, per.end))}</output>
        <button type="button" data-week="1" aria-label="Next week" ${wi < 0 || wi >= ws.length - 1 ? 'disabled' : ''}>${I.right}</button>
      </div>
      ${!hasReal && SAMPLE.length ? `<label class="switch"><input type="checkbox" id="sample-toggle" ${state.sample ? 'checked' : ''}> Sample numbers</label>` : ''}
      <button type="button" class="btn-present" data-action="present">${I.present} Present</button>`;
  }

  function renderDeck() {
    charts.clear();
    chartSeq = 0;
    const deck = $('#deck');
    if (!deck.children.length) {
      deck.innerHTML = SLIDES.map(s => `<section class="slide ${s.cls || ''}" id="${s.id}" aria-label="${esc(s.nav)}"></section>`).join('');
      $('#slidenav').innerHTML = SLIDES.map(s => `<a href="#${s.id}" data-nav="${s.id}">${esc(s.nav)}</a>`).join('');
    }
    SLIDES.forEach((s, k) => {
      const el = document.getElementById(s.id);
      try { el.innerHTML = s.render(k); }
      catch (err) { el.innerHTML = `<div class="empty"><b>This slide could not be drawn</b><span>${esc(err.message)}</span></div>`; console.error(err); }
      el.classList.toggle('current', state.presenting && k === state.current);
    });
    wireCharts(deck);
    renderControls();
    renderPresentBar();
  }

  // ---------- present mode ----------
  // Built once and then updated in place, so a focused button keeps focus between slides.
  function renderPresentBar() {
    const bar = $('#present-bar');
    if (!bar.children.length) {
      bar.innerHTML = `<button type="button" data-action="prev" aria-label="Previous slide">${I.left}</button>
        <span class="present-dots" aria-hidden="true">${SLIDES.map(() => '<i></i>').join('')}</span>
        <span class="count" aria-live="polite"></span>
        <button type="button" data-action="next" aria-label="Next slide">${I.right}</button>
        <button type="button" data-action="exit" aria-label="Exit presentation">${I.close}</button>`;
    }
    $$('.present-dots i', bar).forEach((d, k) => d.classList.toggle('on', k === state.current));
    $('.count', bar).textContent = `${state.current + 1} / ${SLIDES.length}`;
    $('[data-action="prev"]', bar).disabled = state.current === 0;
    $('[data-action="next"]', bar).disabled = state.current === SLIDES.length - 1;
  }
  function go(k, { focusSlide = true } = {}) {
    state.current = Math.max(0, Math.min(SLIDES.length - 1, k));
    $$('.slide').forEach((el, n) => {
      el.classList.toggle('current', n === state.current);
      if (n === state.current) {
        el.scrollTop = 0;
        el.setAttribute('tabindex', '-1');
        // Focus the slide itself so arrow keys and PageDown-free scrolling work on tall slides.
        if (focusSlide && !$('#present-bar').contains(document.activeElement)) el.focus({ preventScroll: true });
      }
    });
    renderPresentBar();
  }
  function nearestSlide() {
    let best = 0, bd = Infinity;
    $$('.slide').forEach((el, k) => { const d = Math.abs(el.getBoundingClientRect().top - 120); if (d < bd) { bd = d; best = k; } });
    return best;
  }
  function present(on) {
    if (on === state.presenting) return;
    state.presenting = on;
    if (on) {
      state.current = nearestSlide();
      document.documentElement.classList.add('presenting');
      go(state.current);
      try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* not allowed here */ }
    } else {
      document.documentElement.classList.remove('presenting');
      $$('.slide').forEach(el => { el.classList.remove('current'); el.removeAttribute('tabindex'); });
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch { /* ignore */ }
      document.getElementById(SLIDES[state.current].id).scrollIntoView({ block: 'start' });
      $('[data-action="present"]')?.focus({ preventScroll: true });
    }
  }

  // ---------- events ----------
  // Re-rendering replaces the focused control, so remember which one it was and focus it again.
  function focusKey() {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    for (const attr of ['data-account', 'data-week', 'data-sort', 'data-action']) {
      if (el.hasAttribute(attr)) return `[${attr}="${el.getAttribute(attr)}"]`;
    }
    return el.id ? `#${el.id}` : null;
  }
  function rerender(fn) {
    const key = focusKey();
    fn();
    if (!key) return;
    let el = $(key);
    if (el && el.disabled && key.startsWith('[data-week')) el = $(`[data-week="${key.includes('"-1"') ? '1' : '-1'}"]`);
    el?.focus({ preventScroll: true });
  }
  document.addEventListener('click', e => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.dataset.account) { state.account = t.dataset.account; store.set('account', state.account); rerender(renderDeck); return; }
    if (t.dataset.week) {
      const ws = weeks(); const k = weekIndex() + Number(t.dataset.week);
      if (ws[k]) { state.weekStart = ws[k].start; rerender(renderDeck); }
      return;
    }
    if (t.dataset.sort) {
      if (sortKey === t.dataset.sort) sortDir *= -1; else { sortKey = t.dataset.sort; sortDir = -1; }
      rerender(() => { document.getElementById('videos').innerHTML = renderTable(SLIDES.findIndex(s => s.id === 'videos')); });
      return;
    }
    const act = t.dataset.action;
    if (act === 'present') present(true);
    else if (act === 'exit') present(false);
    else if (act === 'next') go(state.current + 1);
    else if (act === 'prev') go(state.current - 1);
    else if (act === 'sample-on') { state.sample = true; store.set('sample', true); rerender(renderDeck); $('#sample-toggle')?.focus(); }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'sample-toggle') { state.sample = e.target.checked; store.set('sample', state.sample); state.weekStart = null; rerender(renderDeck); }
  });
  document.addEventListener('keydown', e => {
    if (!state.presenting) return;
    // Space and Enter keep their normal job on buttons, links, toggles and form fields.
    const onControl = e.target.closest?.('button, a, summary, input, select, textarea, [role="region"]');
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !onControl)) {
      if (e.key === 'ArrowRight' && e.target.closest?.('[role="region"]')) return;
      e.preventDefault(); go(state.current + 1);
    }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      if (e.key === 'ArrowLeft' && e.target.closest?.('[role="region"]')) return;
      e.preventDefault(); go(state.current - 1);
    }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(SLIDES.length - 1);
    else if (e.key === 'Escape') present(false);
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && state.presenting) present(false); });
  // Swipe between slides, unless the finger started on something that scrolls sideways
  // (the scorecard, the phone screens) or on a chart.
  let touchX = null, touchY = null;
  const insideSideScroller = el => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches?.('[data-chart]')) return true;
      const ox = getComputedStyle(n).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth + 2) return true;
    }
    return false;
  };
  document.addEventListener('touchstart', e => {
    touchX = touchY = null;
    if (!state.presenting || insideSideScroller(e.target)) return;
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!state.presenting || touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
    touchX = touchY = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(state.current + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // Highlight the slide in view in the section nav.
  function watchNav() {
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) {
        $$('#slidenav a').forEach(a => a.setAttribute('aria-current', a.dataset.nav === en.target.id ? 'true' : 'false'));
      }
    }, { rootMargin: '-35% 0px -60% 0px' });
    $$('.slide').forEach(el => io.observe(el));
  }

  // Keep anchor jumps clear of the sticky header, whatever height it wraps to.
  const topbar = $('.topbar');
  const setHdr = () => document.documentElement.style.setProperty('--hdr', `${Math.round(topbar.getBoundingClientRect().height)}px`);
  if (topbar) { setHdr(); if ('ResizeObserver' in window) new ResizeObserver(setHdr).observe(topbar); }

  $('#built').textContent = `Updated ${shortDate(R.updated)} ${R.updated.slice(0, 4)}`;
  renderDeck();
  watchNav();
  const hash = location.hash.slice(1);
  if (hash && document.getElementById(hash)) document.getElementById(hash).scrollIntoView();
})();
