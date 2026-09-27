// Builds the report into one self-contained HTML page.
//
//   npm run build   ->  dist/index.html     (full page: Vercel, Netlify, or open locally)
//                       dist/artifact.html  (same page as a fragment, for a Claude artifact)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, DATA, readJSON, listWeekFiles, ACCOUNT_IDS, ACCOUNT_FIELDS, FUNNEL_FIELDS, POST_NUMBER_FIELDS, addDays, isMain, run } from './lib.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');

export function loadData() {
  const report = readJSON(join(DATA, 'report.json'));
  const files = listWeekFiles();
  return {
    report,
    schedule: readJSON(join(DATA, 'schedule.json')),
    pipeline: readJSON(join(DATA, 'pipeline.json'), null),
    ads: readJSON(join(DATA, 'ads.json'), null),
    app: readJSON(join(DATA, 'app.json'), null),
    asks: readJSON(join(DATA, 'asks.json'), null),
    // A missing "end" is always start + 6, so the page never has to guess.
    weeks: files.map(({ week }) => (week.start && !week.end ? { ...week, end: addDays(week.start, 6) } : week)),
    weekFiles: files.map(f => f.file),
    sampleWeeks: readJSON(join(DATA, 'sample', 'weeks.json'), []),
  };
}

const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const numOrNull = v => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));

// Catch the mistakes a hand edit is likely to make, before they reach the client.
export function check(data) {
  const problems = [];
  const warn = msg => problems.push(msg);
  const ids = new Set(ACCOUNT_IDS);
  const starts = new Map();
  const postWeeks = new Map();
  (data.weeks || []).forEach((w, i) => {
    const file = data.weekFiles?.[i];
    const label = `week ${w.start || file || i}`;
    if (!isDay(w.start)) { warn(`${label}: "start" must be a date like 2026-10-05`); return; }
    if (new Date(`${w.start}T00:00:00Z`).getUTCDay() !== 1) warn(`${label}: weeks start on a Monday`);
    if (w.end !== undefined && w.end !== addDays(w.start, 6)) warn(`${label}: "end" should be ${addDays(w.start, 6)} (start + 6 days)`);
    if (file && file !== `${w.start}.json`) warn(`${file}: file name should match its "start" (${w.start}.json)`);
    if (starts.has(w.start)) warn(`${label}: two week files use the same "start" (${starts.get(w.start)} and ${file})`);
    starts.set(w.start, file);
    for (const [id, acc] of Object.entries(w.accounts || {})) {
      if (!ids.has(id)) warn(`${label}: accounts has unknown key "${id}" (use ${[...ids].join(', ')})`);
      for (const [k, v] of Object.entries(acc || {})) {
        if (!ACCOUNT_FIELDS.includes(k)) warn(`${label}: accounts.${id} has unknown field "${k}" (use ${ACCOUNT_FIELDS.join(', ')})`);
        else if (!numOrNull(v)) warn(`${label}: accounts.${id}.${k} must be a number or null, not ${JSON.stringify(v)}`);
      }
    }
    for (const [k, v] of Object.entries(w.funnel || {})) {
      if (!FUNNEL_FIELDS.includes(k)) warn(`${label}: funnel has unknown field "${k}" (use ${FUNNEL_FIELDS.join(', ')})`);
      else if (!numOrNull(v)) warn(`${label}: funnel.${k} must be a number or null, not ${JSON.stringify(v)}`);
    }
    for (const p of w.posts || []) {
      const name = `post "${p.title}"`;
      if (!ids.has(p.account)) warn(`${label}: ${name} has unknown account "${p.account}" (use ${[...ids].join(', ')})`);
      if (!p.posted) warn(`${label}: ${name} is missing "posted"`);
      else if (p.posted.slice(0, 10) < w.start || p.posted.slice(0, 10) > addDays(w.start, 6)) warn(`${label}: ${name} was posted ${p.posted.slice(0, 10)}, outside this week`);
      for (const k of POST_NUMBER_FIELDS) if (!numOrNull(p[k])) warn(`${label}: ${name} ${k} must be a number or null, not ${JSON.stringify(p[k])}`);
      if (p.retention !== undefined && p.retention !== null) {
        if (!Array.isArray(p.retention) || p.retention.some(v => typeof v !== 'number' || v < 0 || v > 100)) {
          warn(`${label}: ${name} retention must be numbers from 0 to 100`);
        } else if (p.retention.length !== 11 || p.retention[0] !== 100) {
          warn(`${label}: ${name} retention needs 11 numbers, starting at 100 (0%, 10%, ... 100% of the video)`);
        }
      }
      if (typeof p.avgWatchSec === 'number' && typeof p.lengthSec === 'number' && p.avgWatchSec > p.lengthSec * 3) {
        warn(`${label}: ${name} average watch time is over 3x its length; check the units (seconds)`);
      }
      if (p.id) {
        if (postWeeks.has(p.id) && postWeeks.get(p.id) !== w.start) warn(`${label}: ${name} is also in week ${postWeeks.get(p.id)}; keep it in one week only`);
        postWeeks.set(p.id, w.start);
      }
    }
    for (const a of w.ads || []) {
      if (a.account && !ids.has(a.account)) warn(`${label}: ad "${a.name}" has unknown account "${a.account}"`);
      for (const k of ['spend', 'impressions', 'reach', 'results', 'linkClicks', 'follows']) if (!numOrNull(a[k])) warn(`${label}: ad "${a.name}" ${k} must be a number or null`);
    }
  });
  for (const it of data.schedule.items) {
    if (!isDay(it.date)) warn(`schedule: "${it.title}" has a bad date`);
  }
  return problems;
}

// JSON inside <script> must not be able to close the tag.
const safeJSON = v => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

export function build({ out = join(ROOT, 'dist') } = {}) {
  const { weekFiles, ...data } = loadData();
  const problems = check({ ...data, weekFiles });
  const logo = 'data:image/png;base64,' + readFileSync(join(ROOT, 'src/assets/prometra-emblem.png')).toString('base64');
  const fragment = read('src/page.html')
    .replace('/*@CSS@*/', () => read('src/styles.css'))
    .replace('/*@APP@*/', () => read('src/app.js'))
    .replace('@DATA@', () => safeJSON(data))
    .replace('@LOGO@', () => logo);

  const split = fragment.indexOf('<header');
  const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
${fragment.slice(0, split).trim()}
</head>
<body>
${fragment.slice(split).trim()}
</body>
</html>
`;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), full);
  writeFileSync(join(out, 'artifact.html'), fragment);
  return { problems, bytes: Buffer.byteLength(full), weeks: data.weeks.length };
}

if (isMain(import.meta.url)) {
  run(() => {
    const { problems, bytes, weeks } = build();
    for (const p of problems) console.warn(`warning: ${p}`);
    console.log(`Built dist/index.html and dist/artifact.html (${(bytes / 1024).toFixed(0)} KB, ${weeks} real week${weeks === 1 ? '' : 's'} of numbers${weeks ? '' : ', showing sample numbers'}).`);
    if (process.argv.includes('--strict') && problems.length) {
      console.error(`Stopped: fix the ${problems.length} warning${problems.length === 1 ? '' : 's'} above, then run npm run check again.`);
      process.exit(1);
    }
  });
}
