// Pull a week of posts and their Insights straight from the Instagram Graph API.
//
//   IG_ACCESS_TOKEN=... IG_USER_ID=... node scripts/fetch-instagram.mjs --account prometrausa --week 2026-10-05
//
// Needs a Meta app with instagram_basic, instagram_manage_insights and
// pages_read_engagement, and the Instagram professional account's user id.
// Metric names change between Graph API versions: any metric the API refuses is
// skipped with a warning instead of stopping the run. The API has no retention
// curve, so fill "retention" and "skipRate" from the Instagram app by hand.
import { ACCOUNT_IDS, args, addDays, weekStart, loadWeek, weekPath, writeJSON, mergePosts, isMain } from './lib.mjs';

const API = 'https://graph.facebook.com/v21.0';

async function get(path, params, token) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, v);
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = body.error?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { code: body.error?.code });
  }
  return body;
}

// Ask for all metrics at once; if the API rejects the set, fall back to one at a time.
async function insights(mediaId, metrics, token) {
  try {
    const r = await get(`${mediaId}/insights`, { metric: metrics.join(',') }, token);
    return Object.fromEntries(r.data.map(d => [d.name, d.values?.[0]?.value ?? d.total_value?.value ?? null]));
  } catch {
    const out = {};
    for (const m of metrics) {
      try {
        const r = await get(`${mediaId}/insights`, { metric: m }, token);
        out[m] = r.data[0]?.values?.[0]?.value ?? null;
      } catch (err) {
        console.warn(`  ${mediaId}: metric "${m}" unavailable (${err.message})`);
      }
    }
    return out;
  }
}

async function main() {
  const a = args();
  const token = process.env.IG_ACCESS_TOKEN;
  const userId = process.env.IG_USER_ID;
  if (!token || !userId || !ACCOUNT_IDS.includes(a.account)) {
    console.error('Set IG_ACCESS_TOKEN and IG_USER_ID, and pass --account <prometrausa|meto|dromavi> [--week YYYY-MM-DD].');
    process.exit(1);
  }
  const start = weekStart(a.week || new Date(Date.now() - 7 * 864e5).toISOString());
  const end = addDays(start, 6);
  const since = Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000);
  const until = Math.floor(Date.parse(`${end}T23:59:59Z`) / 1000);

  const media = [];
  let page = await get(`${userId}/media`, { fields: 'id,caption,media_type,media_product_type,timestamp,permalink', since, until, limit: 50 }, token);
  while (page) {
    media.push(...page.data);
    page = page.paging?.next ? await (await fetch(page.paging.next)).json() : null;
  }
  const inWeek = media.filter(m => m.timestamp.slice(0, 10) >= start && m.timestamp.slice(0, 10) <= end);
  console.log(`${inWeek.length} post(s) on ${a.account} between ${start} and ${end}`);

  const posts = [];
  for (const m of inWeek) {
    const isReel = m.media_product_type === 'REELS';
    const metrics = isReel
      ? ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'ig_reels_avg_watch_time']
      : ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'follows', 'profile_visits'];
    const v = await insights(m.id, metrics, token);
    const caption = (m.caption || '').split('\n')[0].trim();
    posts.push({
      id: m.id,
      account: a.account,
      title: caption.length > 70 ? caption.slice(0, 67).trimEnd() + '...' : caption || 'Untitled post',
      format: isReel ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Photo',
      posted: m.timestamp.slice(0, 16),
      permalink: m.permalink,
      views: v.views ?? null,
      reach: v.reach ?? null,
      likes: v.likes ?? null,
      comments: v.comments ?? null,
      shares: v.shares ?? null,
      saves: v.saved ?? null,
      follows: v.follows ?? null,
      profileVisits: v.profile_visits ?? null,
      avgWatchSec: v.ig_reels_avg_watch_time != null ? Math.round(v.ig_reels_avg_watch_time / 100) / 10 : null,
    });
  }

  const profile = await get(userId, { fields: 'followers_count' }, token).catch(() => null);
  const week = loadWeek(start);
  delete week.sample;
  week.posts = mergePosts(week.posts || [], posts);
  if (profile?.followers_count != null) {
    week.accounts[a.account] = { ...week.accounts[a.account], followers: profile.followers_count };
  }
  writeJSON(weekPath(start), week);
  console.log(`Saved data/weeks/${start}.json. Add MOVEMENT comments and retention by hand, then npm run build.`);
}

if (isMain(import.meta.url)) main().catch(err => { console.error(err.message); process.exit(1); });
