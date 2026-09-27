// Load an Instagram content export into the weekly data.
//
//   node scripts/import-insights.mjs --csv ~/Downloads/export.csv --account prometrausa
//
// Export it from Meta Business Suite: Insights > Content > pick the date range >
// Export data > CSV. Import the file as downloaded: opening and re-saving it in
// Excel rounds the long post IDs. Each post lands in the week (Monday to Sunday)
// it was published in. Running it again with a newer export updates the numbers
// and keeps the hand-filled fields (MOVEMENT comments, retention, skip rate, titles).
// Story frames are skipped unless you pass --stories.
import { basename, join } from 'node:path';
import {
  ACCOUNT_IDS, DATA, UserError, args, readCSVFile, readJSON, findColumn, pick, num, parseDate,
  weekStart, loadWeek, weekPath, writeJSON, mergePosts, isMain, run,
} from './lib.mjs';

const KNOWN_HANDLES = { prometrausa: 'prometrausa', prometra_usa: 'prometrausa', metomovement: 'meto', dromavi: 'dromavi' };

function accountNames() {
  const report = readJSON(join(DATA, 'report.json'), { accounts: [] });
  const out = {};
  for (const a of report.accounts) {
    out[a.name.toLowerCase()] = a.id;
    if (a.handle.startsWith('@')) out[a.handle.slice(1).toLowerCase()] = a.id;
  }
  return out;
}

// Decide which columns to read once per file, so a blank cell never falls back to another metric.
export function columnsFor(rows) {
  const views = findColumn(rows, 'Views', 'Plays') || findColumn(rows, 'Impressions');
  return {
    id: findColumn(rows, 'Post ID', 'Media ID', 'ID'),
    posted: findColumn(rows, 'Publish time', 'Published', 'Timestamp', 'Date'),
    username: findColumn(rows, 'Account username', 'Username'),
    accountName: findColumn(rows, 'Account name'),
    type: findColumn(rows, 'Post type', 'Media type', 'Type'),
    views,
    reach: findColumn(rows, 'Reach', 'Accounts reached'),
    lengthSec: findColumn(rows, 'Duration (sec)', 'Duration', 'Video duration'),
    avgMs: findColumn(rows, 'Average watch time (ms)', 'ig_reels_avg_watch_time'),
    avgSec: findColumn(rows, 'Average watch time', 'Avg. watch time'),
    likes: findColumn(rows, 'Likes'),
    comments: findColumn(rows, 'Comments'),
    shares: findColumn(rows, 'Shares'),
    saves: findColumn(rows, 'Saves', 'Saved'),
    follows: findColumn(rows, 'Follows'),
    profileVisits: findColumn(rows, 'Profile visits'),
    linkClicks: findColumn(rows, 'Link clicks', 'Sticker taps'),
    permalink: findColumn(rows, 'Permalink', 'Link'),
  };
}

const cell = (row, col) => (col === undefined ? undefined : row[col]);

export function rowToPost(row, cols = columnsFor([row])) {
  const id = cell(row, cols.id);
  const rawDate = cell(row, cols.posted);
  const posted = parseDate(rawDate);
  const caption = pick(row, 'Description', 'Caption', 'Title') || '';
  const type = (cell(row, cols.type) || '').toLowerCase();
  const format = type.includes('reel') || type.includes('video') ? 'Reel'
    : type.includes('carousel') ? 'Carousel'
    : type.includes('story') ? 'Story'
    : type ? 'Photo' : 'Reel';
  const firstLine = caption.split(/\n/)[0].trim();
  const avgMs = num(cell(row, cols.avgMs));
  return {
    id: id ? String(id).trim() : '',
    rawDate,
    username: (cell(row, cols.username) || '').replace(/^@/, '').trim().toLowerCase(),
    accountName: (cell(row, cols.accountName) || '').trim().toLowerCase(),
    post: {
      id: id ? String(id).trim() : '',
      account: null,
      title: firstLine.length > 70 ? firstLine.slice(0, 67).trimEnd() + '...' : firstLine || 'Untitled post',
      format,
      posted,
      permalink: cell(row, cols.permalink) || undefined,
      lengthSec: num(cell(row, cols.lengthSec)),
      views: num(cell(row, cols.views)),
      reach: num(cell(row, cols.reach)),
      avgWatchSec: avgMs !== null ? Math.round(avgMs / 100) / 10 : num(cell(row, cols.avgSec)),
      likes: num(cell(row, cols.likes)),
      comments: num(cell(row, cols.comments)),
      shares: num(cell(row, cols.shares)),
      saves: num(cell(row, cols.saves)),
      follows: num(cell(row, cols.follows)),
      profileVisits: num(cell(row, cols.profileVisits)),
      linkClicks: format === 'Story' ? num(cell(row, cols.linkClicks)) : null,
    },
  };
}

// Turn export rows into posts grouped by week. Throws UserError for anything that
// would silently put wrong numbers on the page.
export function importRows(rows, { account, stories = false, names = accountNames() } = {}) {
  const cols = columnsFor(rows);
  if (!cols.id || !cols.posted) {
    throw new UserError('This file has no "Post ID" or "Publish time" column. Use the CSV from Meta Business Suite > Insights > Content > Export data.');
  }
  const parsed = rows.map(r => rowToPost(r, cols));

  // Excel turns 18-digit post IDs into "1.79E+16" or rounds them, which would merge different posts.
  const bad = parsed.find(p => p.id && !/^\d+$/.test(p.id));
  if (bad) throw new UserError(`Post ID "${bad.id}" was changed, most likely by Excel. Download the export again and import it without opening it in Excel.`);
  const seen = new Map();
  for (const p of parsed) {
    if (!p.id) continue;
    if (seen.has(p.id)) throw new UserError(`Two rows share Post ID ${p.id} ("${seen.get(p.id)}" and "${p.post.title}"). The IDs were probably rounded by Excel. Download the export again and import it without opening it in Excel.`);
    seen.set(p.id, p.post.title);
  }

  // Map usernames to accounts. An unknown handle is only accepted when --account says
  // which account this file is, and the file holds a single unknown handle.
  const resolve = p => KNOWN_HANDLES[p.username] || names[p.username] || names[p.accountName] || null;
  const unknown = [...new Set(parsed.filter(p => p.username && !resolve(p)).map(p => p.username))];
  const notices = [];
  if (unknown.length) {
    if (account && unknown.length === 1 && new Set(parsed.map(p => p.username).filter(Boolean)).size === 1) {
      notices.push(`Assigned @${unknown[0]} to ${account} (from --account).`);
    } else {
      throw new UserError(`Unknown Instagram account${unknown.length > 1 ? 's' : ''}: ${unknown.map(u => '@' + u).join(', ')}. Import one account per file with --account (${ACCOUNT_IDS.join(', ')}).`);
    }
  }

  const byWeek = new Map();
  let storiesSkipped = 0, badDates = 0, sampleBadDate = '', noAccount = 0;
  for (const p of parsed) {
    if (!p.id) continue;
    if (!p.post.posted) { badDates++; sampleBadDate ||= p.rawDate || '(blank)'; continue; }
    if (p.post.format === 'Story' && !stories) { storiesSkipped++; continue; }
    p.post.account = resolve(p) || account || null;
    if (!p.post.account) { noAccount++; continue; }
    const wk = weekStart(p.post.posted);
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(p.post);
  }
  if (storiesSkipped) notices.push(`${storiesSkipped} Story frame${storiesSkipped === 1 ? '' : 's'} skipped (pass --stories to include them).`);
  if (badDates) notices.push(`Could not read Publish time "${sampleBadDate}" in ${badDates} row${badDates === 1 ? '' : 's'}; those rows were skipped.`);
  if (noAccount) notices.push(`${noAccount} row${noAccount === 1 ? '' : 's'} had no account; re-run with --account.`);
  return { byWeek, notices };
}

async function main() {
  const a = args();
  const csv = a.csv || a._[0];
  if (!csv) throw new UserError('Usage: npm run import:insights -- --csv <export.csv> --account <prometrausa|meto|dromavi>');
  if (a.account && !ACCOUNT_IDS.includes(a.account)) throw new UserError(`--account must be one of: ${ACCOUNT_IDS.join(', ')}`);
  const rows = readCSVFile(csv);
  const { byWeek, notices } = importRows(rows, { account: a.account, stories: !!a.stories });
  for (const n of notices) console.log(n);
  if (!byWeek.size) throw new UserError(`No posts found in ${basename(csv)}.`);
  for (const [start, posts] of [...byWeek].sort()) {
    const week = loadWeek(start);
    delete week.sample;
    week.posts = mergePosts(week.posts || [], posts);
    writeJSON(weekPath(start), week);
    console.log(`${start}: ${posts.length} post(s) merged, ${week.posts.length} in the week`);
  }
  console.log('Next: fill in MOVEMENT comments, skip rate and retention for each post, then run npm run check.');
}

if (isMain(import.meta.url)) run(main);
