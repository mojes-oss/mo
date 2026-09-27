// Start a week file with the Friday numbers left blank, ready to fill in.
//
//   node scripts/new-week.mjs --week 2026-10-05
import { existsSync } from 'node:fs';
import { args, weekStart, weekPath, emptyWeek, writeJSON, isMain } from './lib.mjs';

function main() {
  const a = args();
  const start = weekStart(a.week || new Date().toISOString());
  const path = weekPath(start);
  if (existsSync(path)) {
    console.log(`data/weeks/${start}.json already exists. Edit it directly.`);
    return;
  }
  const week = emptyWeek(start);
  week.accounts = {
    prometrausa: { followers: null, newFollowers: null, views: null, reach: null, profileVisits: null, linkTaps: null },
    meto: { followers: null, newFollowers: null, views: null, reach: null, profileVisits: null, linkTaps: null },
    dromavi: { followers: null, newFollowers: null, views: null, reach: null, profileVisits: null, linkTaps: null },
  };
  week.funnel = { reach: null, keywordComments: null, dmsDelivered: null, linkClicks: null, signups: null, applications: null, seats: null };
  writeJSON(path, week);
  console.log(`Created data/weeks/${start}.json. Fill in the numbers (leave null for anything not measured), then npm run build.`);
}

if (isMain(import.meta.url)) main();
