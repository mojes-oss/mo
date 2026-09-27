// Builds the report into one self-contained HTML page.
//
//   npm run build   ->  dist/index.html     (full page: Vercel, Netlify, or open locally)
//                       dist/artifact.html  (same page as a fragment, for a Claude artifact)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, DATA, readJSON, listWeeks, ACCOUNT_IDS, isMain } from './lib.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');

export function loadData() {
  const report = readJSON(join(DATA, 'report.json'));
  return {
    report,
    schedule: readJSON(join(DATA, 'schedule.json')),
    pipeline: readJSON(join(DATA, 'pipeline.json'), null),
    ads: readJSON(join(DATA, 'ads.json'), null),
    app: readJSON(join(DATA, 'app.json'), null),
    asks: readJSON(join(DATA, 'asks.json'), null),
    weeks: listWeeks(),
    sampleWeeks: readJSON(join(DATA, 'sample', 'weeks.json'), []),
  };
}

// Catch the mistakes a hand edit is likely to make, before they reach the client.
export function check(data) {
  const problems = [];
  const warn = msg => problems.push(msg);
  const ids = new Set(ACCOUNT_IDS);
  for (const w of data.weeks) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.start)) warn(`week ${w.start}: "start" must be YYYY-MM-DD`);
    if (new Date(`${w.start}T00:00:00Z`).getUTCDay() !== 1) warn(`week ${w.start}: weeks start on a Monday`);
    for (const p of w.posts || []) {
      if (!ids.has(p.account)) warn(`week ${w.start}: post "${p.title}" has unknown account "${p.account}" (use ${[...ids].join(', ')})`);
      if (!p.posted) warn(`week ${w.start}: post "${p.title}" is missing "posted"`);
      if (p.retention && (!Array.isArray(p.retention) || p.retention.some(v => typeof v !== 'number' || v < 0 || v > 100))) {
        warn(`week ${w.start}: post "${p.title}" retention must be numbers from 0 to 100`);
      }
      if (typeof p.avgWatchSec === 'number' && typeof p.lengthSec === 'number' && p.avgWatchSec > p.lengthSec * 3) {
        warn(`week ${w.start}: post "${p.title}" average watch time is over 3x its length; check the units (seconds)`);
      }
    }
    for (const a of w.ads || []) if (a.account && !ids.has(a.account)) warn(`week ${w.start}: ad "${a.name}" has unknown account "${a.account}"`);
  }
  for (const it of data.schedule.items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date)) warn(`schedule: "${it.title}" has a bad date`);
  }
  return problems;
}

// JSON inside <script> must not be able to close the tag.
const safeJSON = v => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

export function build({ out = join(ROOT, 'dist') } = {}) {
  const data = loadData();
  const problems = check(data);
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
  const { problems, bytes, weeks } = build();
  for (const p of problems) console.warn(`warning: ${p}`);
  console.log(`Built dist/index.html and dist/artifact.html (${(bytes / 1024).toFixed(0)} KB, ${weeks} real week${weeks === 1 ? '' : 's'} of numbers${weeks ? '' : ', showing sample numbers'}).`);
  if (process.argv.includes('--strict') && problems.length) process.exit(1);
}
