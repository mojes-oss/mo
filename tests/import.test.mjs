import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCSV, readCSVFile, pick, num, parseDate, weekStart, mergePosts, unitIdFromName, upsertAds } from '../scripts/lib.mjs';
import { rowToPost, importRows } from '../scripts/import-insights.mjs';
import { rowToAd } from '../scripts/import-ads.mjs';
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
  const rows = readCSVFile(fixture('insights-export.csv'));
  const first = rowToPost(rows[0]);
  assert.equal(first.account, 'prometrausa');
  assert.equal(first.title, 'A healer is a library.');
  assert.equal(first.views, 1204);
  assert.equal(first.lengthSec, 58);
  assert.equal(first.format, 'Reel');
  assert.equal(first.posted, '2026-10-02T16:00');
  assert.equal(rowToPost(rows[1]).title, 'CTA video A "Restore Your Humanity"');

  const { byWeek, skipped } = importRows(rows);
  assert.equal(skipped, 0);
  assert.deepEqual([...byWeek.keys()].sort(), ['2026-09-28', '2026-10-05', '2026-10-12']);
  const blank = byWeek.get('2026-10-12')[0];
  assert.equal(blank.views, null, 'a "--" cell is not measured, not zero');
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

test('Ads Manager rows map to ad units and accounts', () => {
  const [a, b] = readCSVFile(fixture('ads-export.csv')).map(rowToAd);
  assert.equal(a.unit, 'mto-02');
  assert.equal(a.account, 'meto');
  assert.equal(a.spend, 50);
  assert.equal(a.results, 31);
  assert.equal(a.from, '2026-10-12');
  assert.equal(b.account, 'dromavi');
  assert.equal(b.results, null);
  assert.equal(unitIdFromName('A5b Fee completes Nov 1'), 'A5b');
  assert.equal(unitIdFromName('R-C retarget'), 'R-C');
  assert.equal(unitIdFromName('Boost of a reel'), null);
  assert.equal(upsertAds([a], [{ ...a, spend: 75 }]).length, 1);
});

test('check() flags the hand-edit mistakes that would break the page', () => {
  const problems = check({
    schedule: { items: [{ date: 'Oct 2', title: 'x' }] },
    weeks: [{ start: '2026-09-29', posts: [{ title: 'p', account: 'prometra', retention: [100, 140] }] }],
  });
  assert.ok(problems.some(p => p.includes('start on a Monday')));
  assert.ok(problems.some(p => p.includes('unknown account')));
  assert.ok(problems.some(p => p.includes('retention')));
  assert.ok(problems.some(p => p.includes('missing "posted"')));
  assert.ok(problems.some(p => p.includes('bad date')));
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
