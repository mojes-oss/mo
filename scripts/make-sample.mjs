// Writes data/sample/weeks.json: made-up numbers that show how the dashboard
// looks once real Insights come in. Every week is flagged sample: true and the
// dashboard labels it on screen. Deterministic, so rebuilding never shifts it.
import { join } from 'node:path';
import { DATA, writeJSON, addDays } from './lib.mjs';

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260927);
const between = (a, b) => a + (b - a) * rand();
const int = (a, b) => Math.round(between(a, b));

const WEEKS = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];

const ACCOUNTS = {
  prometrausa: { base: 900, followers: 180, posts: [['Movement talk', 'Reel', 1, 16, 58], ['Plant reel', 'Reel', 3, 9, 52]] },
  meto: { base: 1900, followers: 420, posts: [['Call-to-action video', 'Reel', 2, 15, 47], ['Healing short', 'Reel', 4, 15, 49]] },
  dromavi: { base: 5200, followers: 3100, posts: [['Africa short', 'Reel', 0, 16, 55], ['Kingship short', 'Reel', 4, 17, 46]] },
};

function retentionCurve(skip, decay) {
  const first = 100 * (1 - skip);
  const pts = [100, first];
  for (let i = 2; i <= 10; i++) pts.push(first * Math.exp(-decay * (i - 1)) + between(-1.2, 1.2));
  return pts.map(v => Math.max(0, Math.round(v)));
}
const avgWatchedShare = pts => pts.slice(1).reduce((s, v, i) => s + (pts[i] + v) / 2, 0) / 1000;

const weeks = WEEKS.map((start, wi) => {
  const growth = Math.pow(1.09, wi);
  const week = { start, end: addDays(start, 6), sample: true, accounts: {}, posts: [], funnel: {}, ads: [], notes: [] };
  let totalKw = 0, totalClicks = 0, totalReach = 0;
  for (const [id, a] of Object.entries(ACCOUNTS)) {
    let accViews = 0, accReach = 0, accFollows = 0, accClicks = 0;
    a.posts.forEach(([label, format, dayOffset, hour, lengthSec], pi) => {
      const views = Math.round(a.base * growth * between(0.55, 1.6));
      const reach = Math.round(views * between(0.58, 0.8));
      const skip = between(0.28, 0.52);
      const retention = retentionCurve(skip, between(0.07, 0.17));
      const avgWatchSec = Math.round(avgWatchedShare(retention) * lengthSec * 10) / 10;
      const comments = Math.round(views * between(0.003, 0.009));
      const keywordComments = Math.round(comments * between(0.35, 0.7));
      const linkClicks = Math.round(keywordComments * between(0.45, 0.8));
      const follows = Math.round(reach * between(0.003, 0.009));
      const post = {
        id: `sample-${start}-${id}-${pi + 1}`,
        account: id,
        title: `Sample ${label.toLowerCase()}`,
        format,
        posted: `${addDays(start, dayOffset)}T${String(hour).padStart(2, '0')}:00`,
        lengthSec,
        views, reach, avgWatchSec,
        skipRate: Math.round(skip * 1000) / 10,
        retention,
        likes: Math.round(views * between(0.03, 0.06)),
        comments, keywordComments,
        shares: Math.round(views * between(0.004, 0.011)),
        saves: Math.round(views * between(0.005, 0.013)),
        follows, linkClicks,
        boosted: false,
      };
      week.posts.push(post);
      accViews += views; accReach += reach; accFollows += follows; accClicks += linkClicks;
      totalKw += keywordComments; totalClicks += linkClicks;
    });
    const newFollowers = Math.round(accFollows * between(1.1, 1.5));
    a.followers += newFollowers;
    week.accounts[id] = {
      followers: a.followers,
      newFollowers,
      views: Math.round(accViews * between(1.15, 1.35)),
      reach: Math.round(accReach * between(1.05, 1.2)),
      profileVisits: Math.round(accReach * between(0.02, 0.04)),
      linkTaps: accClicks,
    };
    totalReach += week.accounts[id].reach;
  }
  const signups = Math.round(totalClicks * between(0.3, 0.45));
  week.funnel = {
    reach: totalReach,
    keywordComments: totalKw,
    dmsDelivered: Math.round(totalKw * between(0.86, 0.97)),
    linkClicks: totalClicks,
    signups,
    applications: Math.round(signups * between(0.06, 0.12)),
    seats: wi >= 4 ? int(0, 2) : 0,
  };
  if (wi >= 4) {
    // One made-up ad row so the per-ad table shows its layout. No sample post is marked
    // as boosted, since no real ad has run yet.
    const results = int(9, 24);
    week.ads.push({ name: 'Sample ad row', unit: null, account: 'meto', spend: 50, impressions: int(6000, 11000), reach: int(4000, 8000), results, resultType: 'link clicks', linkClicks: results });
  }
  week.notes.push('Sample numbers. They show how this page reads once real Instagram Insights are loaded.');
  return week;
});

writeJSON(join(DATA, 'sample', 'weeks.json'), weeks);
console.log(`Wrote ${weeks.length} sample weeks to data/sample/weeks.json`);
