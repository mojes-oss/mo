// Load an Instagram content export into the weekly data.
//
//   node scripts/import-insights.mjs --csv ~/Downloads/export.csv --account prometrausa
//
// Export it from Meta Business Suite: Insights > Content > pick the date range >
// Export data > CSV. Each post lands in the week (Monday to Sunday) it was
// published in. Running it again with a newer export updates the numbers and
// keeps anything filled in by hand (MOVEMENT comments, retention, titles).
import { basename } from 'node:path';
import {
  ACCOUNT_IDS, args, readCSVFile, pick, num, parseDate, weekStart,
  loadWeek, weekPath, writeJSON, mergePosts, isMain,
} from './lib.mjs';

const HANDLE_TO_ID = { prometrausa: 'prometrausa', prometra_usa: 'prometrausa', metomovement: 'meto', dromavi: 'dromavi' };

export function rowToPost(row, fallbackAccount) {
  const id = pick(row, 'Post ID', 'Media ID', 'ID');
  const posted = parseDate(pick(row, 'Publish time', 'Published', 'Timestamp', 'Date'));
  if (!id || !posted) return null;
  const username = (pick(row, 'Account username', 'Username') || '').replace(/^@/, '').toLowerCase();
  const account = HANDLE_TO_ID[username] || fallbackAccount;
  const caption = pick(row, 'Description', 'Caption', 'Title') || '';
  const type = (pick(row, 'Post type', 'Media type', 'Type') || '').toLowerCase();
  const format = type.includes('reel') || type.includes('video') ? 'Reel'
    : type.includes('carousel') ? 'Carousel'
    : type.includes('story') ? 'Story'
    : type ? 'Photo' : 'Reel';
  const firstLine = caption.split(/\n/)[0].trim();
  const avgMs = num(pick(row, 'Average watch time (ms)', 'ig_reels_avg_watch_time'));
  return {
    id: String(id),
    account,
    title: firstLine.length > 70 ? firstLine.slice(0, 67).trimEnd() + '...' : firstLine || 'Untitled post',
    format,
    posted,
    permalink: pick(row, 'Permalink', 'Link') || undefined,
    lengthSec: num(pick(row, 'Duration (sec)', 'Duration', 'Video duration')),
    views: num(pick(row, 'Views', 'Plays', 'Impressions')),
    reach: num(pick(row, 'Reach', 'Accounts reached')),
    avgWatchSec: avgMs !== null ? Math.round(avgMs / 100) / 10 : num(pick(row, 'Average watch time', 'Avg. watch time')),
    likes: num(pick(row, 'Likes')),
    comments: num(pick(row, 'Comments')),
    shares: num(pick(row, 'Shares')),
    saves: num(pick(row, 'Saves', 'Saved')),
    follows: num(pick(row, 'Follows')),
    profileVisits: num(pick(row, 'Profile visits')),
  };
}

export function importRows(rows, fallbackAccount) {
  const byWeek = new Map();
  let skipped = 0;
  for (const row of rows) {
    const post = rowToPost(row, fallbackAccount);
    if (!post || !post.account) { skipped++; continue; }
    const wk = weekStart(post.posted);
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(post);
  }
  return { byWeek, skipped };
}

function main() {
  const a = args();
  const csv = a.csv || a._[0];
  if (!csv) {
    console.error('Usage: node scripts/import-insights.mjs --csv <export.csv> --account <prometrausa|meto|dromavi>');
    process.exit(1);
  }
  if (a.account && !ACCOUNT_IDS.includes(a.account)) {
    console.error(`--account must be one of: ${ACCOUNT_IDS.join(', ')}`);
    process.exit(1);
  }
  const rows = readCSVFile(csv);
  const { byWeek, skipped } = importRows(rows, a.account);
  if (!byWeek.size) {
    console.error(`No posts found in ${basename(csv)}. Check that it is a Meta Business Suite content export, and pass --account if the file has no "Account username" column.`);
    process.exit(1);
  }
  for (const [start, posts] of [...byWeek].sort()) {
    const week = loadWeek(start);
    delete week.sample;
    week.posts = mergePosts(week.posts || [], posts);
    writeJSON(weekPath(start), week);
    console.log(`${start}: ${posts.length} post(s) merged, ${week.posts.length} in the week`);
  }
  if (skipped) console.log(`Skipped ${skipped} row(s) without a post id, date, or account.`);
  console.log('Next: fill in MOVEMENT comments for each post, then run npm run build.');
}

if (isMain(import.meta.url)) main();
