import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCSV, readCSVFile, pick, num, parseDate, parseWeekArg, weekStart, mergePosts, unitIdFromName, upsertAds,
  fillWeekTemplate, localToday, UserError,
} from '../scripts/lib.mjs';
import { importRows } from '../scripts/import-insights.mjs';
import { parseAds, resultWords } from '../scripts/import-ads.mjs';
import { localStamp } from '../scripts/fetch-instagram.mjs';
import { build, check } from '../scripts/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = name => join(here, 'fixtures', name);

test('parseCSV handles quotes, doubled quotes, newlines in fields and a BOM', () => {
  const rows = parseCSV('﻿a,b\n"x, y","he said ""hi""\nthen left"\n1,2\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: 'he said "hi"\nthen left' }, { a: '1', b: '2' }]);
});

test('parseCSV reads tab-separated exports', () => {
  assert.deepEqual(parseCSV('Views\tReach\n10\t8'), [{ Views: '10', Reach: '8' }]);
});

test('pick matches headers loosely and num cleans Meta number formats', () => {
  const row = { 'Amount spent (USD)': '$1,050.25', 'Post ID': '9' };
  assert.equal(num(pick(row, 'Amount spent')), 1050.25);
  assert.equal(pick(row, 'post id'), '9');
  assert.equal(num('--'), null);
  assert.equal(num(''), null);
  assert.equal(num('12.5%'), 12.5);
});

test('parseDate and weekStart put a post in its Monday-Sunday week', () => {
  assert.equal(parseDate('10/02/2026 16:00'), '2026-10-02T16:00');
  assert.equal(parseDate('2026-10-04T23:10:00+0000'), '2026-10-04T23:10');
  assert.equal(weekStart('2026-10-02T16:00'), '2026-09-28'); // Friday
  assert.equal(weekStart('2026-10-04'), '2026-09-28'); // Sunday stays in the same week
  assert.equal(weekStart('2026-10-05'), '2026-10-05'); // Monday starts a new one
});

test('a Meta Business Suite export becomes posts grouped by week', () => {
  const { byWeek, notices } = importRows(readCSVFile(fixture('insights-export.csv')));
  assert.deepEqual(notices, []);
  assert.deepEqual([...byWeek.keys()].sort(), ['2026-09-28', '2026-10-05', '2026-10-12']);
  const [first] = byWeek.get('2026-09-28');
  assert.equal(first.account, 'prometrausa');
  assert.equal(first.title, 'A healer is a library.');
  assert.equal(first.views, 1204);
  assert.equal(first.lengthSec, 58);
  assert.equal(first.format, 'Reel');
  assert.equal(first.posted, '2026-10-02T16:00');
  assert.equal(byWeek.get('2026-10-05')[0].title, 'CTA video A "Restore Your Humanity"');
  const blank = byWeek.get('2026-10-12')[0];
  assert.equal(blank.views, null, 'a "--" cell is not measured, not zero');
});

test('parseDate reads 12-hour, seconds and month-name formats', () => {
  assert.equal(parseDate('10/02/2026 04:00 PM'), '2026-10-02T16:00');
  assert.equal(parseDate('10/02/2026 4:00:00 PM'), '2026-10-02T16:00');
  assert.equal(parseDate('10/02/2026 12:30 AM'), '2026-10-02T00:30');
  assert.equal(parseDate('10/02/2026 12:05 PM'), '2026-10-02T12:05');
  assert.equal(parseDate('Oct 2, 2026 4:00 pm'), '2026-10-02T16:00');
  assert.equal(parseDate('September 27, 2026'), '2026-09-27T00:00');
  assert.equal(parseDate('02/30/2026'), null, 'impossible dates are rejected, not rolled over');
  assert.equal(parseWeekArg('10/07/2026'), '2026-10-05');
  assert.throws(() => parseWeekArg('next week'), UserError);
  assert.match(localToday(new Date(2026, 8, 27, 23, 30)), /^2026-09-27$/);
});

const header = 'Post ID,Account username,Description,Publish time,Post type,Views,Impressions,Reach';
test('Excel-mangled or repeated post IDs stop the import instead of merging posts', () => {
  const rounded = parseCSV(`${header}\n1.79E+16,prometrausa,A,10/02/2026 16:00,IG reel,10,20,5`);
  assert.throws(() => importRows(rounded), /changed, most likely by Excel/);
  const dupes = parseCSV(`${header}\n17900000000000000,prometrausa,A,10/02/2026 16:00,IG reel,10,20,5\n17900000000000000,prometrausa,B,10/03/2026 16:00,IG reel,11,20,5`);
  assert.throws(() => importRows(dupes), /Two rows share Post ID/);
});

test('Stories are skipped by default, and a blank Views cell never becomes Impressions', () => {
  const rows = parseCSV(`${header}\n1,prometrausa,Reel,10/02/2026 16:00,IG reel,,900,5\n2,prometrausa,Frame,10/02/2026 17:00,IG story,40,50,30`);
  const { byWeek, notices } = importRows(rows);
  const posts = byWeek.get('2026-09-28');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].views, null);
  assert.match(notices.join(' '), /1 Story frame skipped/);
  assert.equal(importRows(rows, { stories: true }).byWeek.get('2026-09-28').length, 2);
});

test('an unknown handle needs --account, and only one unknown handle per file', () => {
  const one = parseCSV(`${header}\n1,meto.movement,A,10/02/2026 16:00,IG reel,10,20,5`);
  assert.throws(() => importRows(one), /Unknown Instagram account: @meto.movement/);
  const { byWeek, notices } = importRows(one, { account: 'meto' });
  assert.equal(byWeek.get('2026-09-28')[0].account, 'meto');
  assert.match(notices[0], /Assigned @meto.movement to meto/);
  const mixed = parseCSV(`${header}\n1,meto.movement,A,10/02/2026 16:00,IG reel,10,20,5\n2,prometrausa,B,10/02/2026 17:00,IG reel,10,20,5`);
  assert.throws(() => importRows(mixed, { account: 'meto' }), /Unknown Instagram account/);
});

test('re-importing keeps hand-entered fields and updates numbers', () => {
  const existing = [{ id: '1', account: 'meto', title: 'Short title', views: 100, keywordComments: 12, retention: [100, 60, 40] }];
  const incoming = [{ id: '1', account: 'meto', title: 'A much longer caption from Instagram', views: 250, keywordComments: null }];
  const [merged] = mergePosts(existing, incoming);
  assert.equal(merged.views, 250);
  assert.equal(merged.title, 'Short title');
  assert.equal(merged.keywordComments, 12);
  assert.deepEqual(merged.retention, [100, 60, 40]);
});

test('Ads Manager rows map to ad units, accounts and plain result words', () => {
  const [a, b] = parseAds(readCSVFile(fixture('ads-export.csv')));
  assert.equal(a.unit, 'mto-02');
  assert.equal(a.account, 'meto');
  assert.equal(a.spend, 50);
  assert.equal(a.results, 31);
  assert.equal(a.resultType, 'link clicks');
  assert.equal(a.from, '2026-10-12');
  assert.equal(b.account, 'dromavi');
  assert.equal(b.results, null);
  assert.equal(unitIdFromName('A5b Fee completes Nov 1'), 'A5b');
  assert.equal(unitIdFromName('R-C retarget'), 'R-C');
  assert.equal(unitIdFromName('Boost of a reel'), null);
  assert.equal(resultWords('actions:onsite_conversion.ig_follow'), 'follows');
  assert.equal(resultWords('profile_visit'), 'profile visits');
});

test('Ads Manager summary rows are skipped and the ad account name is ignored', () => {
  const rows = parseCSV('Account name,Campaign name,Ad name,Amount spent (USD),Impressions,Results\nPROMETRA USA,Fall,mto-02 Back to the Source,50,9000,30\nPROMETRA USA,Fall,A1 Fifty Seats,25,4000,10\n,,,75,13000,40\nPROMETRA USA,Total,,75,13000,40');
  const ads = parseAds(rows);
  assert.equal(ads.length, 2);
  assert.equal(ads[0].account, 'meto', 'the unit code wins over the ad account name');
  assert.equal(ads[1].account, null, 'no hint means no account, so it only shows under All accounts');
});

test('a newer export of the same week replaces older rows; daily rows are kept', () => {
  const fri = [{ name: 'mto-02', from: '2026-10-12', to: '2026-10-16', spend: 30 }];
  const sun = [{ name: 'mto-02', from: '2026-10-12', to: '2026-10-18', spend: 50 }];
  assert.deepEqual(upsertAds(fri, sun, '2026-10-12').map(a => a.spend), [50]);
  const days = [1, 2, 3].map(d => ({ name: 'mto-02', from: `2026-10-1${d + 1}`, to: `2026-10-1${d + 1}`, spend: 10 }));
  assert.equal(upsertAds([], days, '2026-10-12').length, 3);
  const other = [{ name: 'A1 Fifty Seats', from: '2026-10-12', to: '2026-10-18', spend: 5 }];
  assert.equal(upsertAds(other, sun, '2026-10-12').length, 2);
});

test('week files get every field as a blank without losing filled numbers', () => {
  const w = fillWeekTemplate({ start: '2026-10-05', funnel: { signups: 12 } });
  assert.equal(w.end, '2026-10-11');
  assert.equal(w.funnel.signups, 12);
  assert.equal(w.funnel.ambassadors, null);
  assert.equal(w.accounts.meto.views, null);
});

test('Graph API times are converted to the team time zone before picking the week', () => {
  assert.equal(localStamp('2026-10-05T02:10:00+0000', 'America/Denver'), '2026-10-04T20:10');
});

test('check() flags the hand-edit mistakes that would break the page', () => {
  const problems = check({
    schedule: { items: [{ date: 'Oct 2', title: 'x' }] },
    weeks: [
      { start: '2026-09-29', posts: [{ title: 'p', account: 'prometra', retention: [100, 140] }] },
      { start: '2026-10-05', end: '2026-10-10', funnel: { 'sign-ups': 3, signups: '22' }, posts: [
        { id: '9', title: 'q', account: 'meto', posted: '2026-10-20T10:00', views: '1,200', retention: [100, 60, 40] },
      ] },
      { start: '2026-10-12', end: '2026-10-18', posts: [{ id: '9', title: 'q', account: 'meto', posted: '2026-10-13T10:00' }] },
    ],
    weekFiles: ['2026-09-29.json', 'copy.json', '2026-10-12.json'],
  });
  const has = s => assert.ok(problems.some(p => p.includes(s)), `expected a warning containing "${s}"`);
  has('start on a Monday');
  has('unknown account');
  has('numbers from 0 to 100');
  has('missing "posted"');
  has('bad date');
  has('"end" should be 2026-10-11');
  has('unknown field "sign-ups"');
  has('funnel.signups must be a number');
  has('views must be a number');
  has('needs 11 numbers');
  has('outside this week');
  has('file name should match');
  has('also in week');
});

test('build() writes a full page and an artifact fragment with safe embedded data', () => {
  const out = mkdtempSync(join(tmpdir(), 'prometra-build-'));
  const { problems } = build({ out });
  assert.deepEqual(problems, []);
  const full = readFileSync(join(out, 'index.html'), 'utf8');
  const frag = readFileSync(join(out, 'artifact.html'), 'utf8');
  assert.match(full, /^<!doctype html>/);
  assert.match(frag, /^<title>PROMETRA Weekly<\/title>/);
  const json = frag.slice(frag.indexOf('<script id="dash-data"'), frag.indexOf('</script>', frag.indexOf('<script id="dash-data"')));
  assert.ok(!json.slice(40).includes('<'), 'embedded JSON has no raw "<"');
  assert.ok(!full.includes('/*@CSS@*/') && !full.includes('@DATA@') && !full.includes('@LOGO@'));
});
