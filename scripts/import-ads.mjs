// Load a Meta Ads Manager export (boosts and ads) into the weekly data.
//
//   node scripts/import-ads.mjs --csv ~/Downloads/ads.csv --week 2026-10-12
//
// In Ads Manager: set the date range to one Monday-Sunday week, open the Ads
// tab, then Reports > Export table data > CSV. Name ads with their unit code
// (for example "A1 Fifty Seats" or "mto-02 Back to the Source") so each row
// matches its card on the Ads slide.
import {
  args, readCSVFile, pick, num, parseDate, weekStart, loadWeek, weekPath,
  writeJSON, upsertAds, unitIdFromName, isMain,
} from './lib.mjs';

const ACCOUNT_HINTS = [
  [/prometra/i, 'prometrausa'],
  [/meto|movement/i, 'meto'],
  [/omavi|dromavi/i, 'dromavi'],
];

export function rowToAd(row) {
  const name = pick(row, 'Ad name', 'Ad Name', 'Name') || pick(row, 'Campaign name');
  if (!name) return null;
  const spend = num(pick(row, 'Amount spent (USD)', 'Amount spent', 'Spend'));
  if (spend === null && num(pick(row, 'Impressions')) === null) return null;
  const where = `${pick(row, 'Page name', 'Instagram account', 'Account name') || ''} ${pick(row, 'Campaign name') || ''} ${name}`;
  const account = (ACCOUNT_HINTS.find(([re]) => re.test(where)) || [])[1] || null;
  return {
    name,
    unit: unitIdFromName(name),
    account,
    from: parseDate(pick(row, 'Reporting starts', 'Starts'))?.slice(0, 10),
    to: parseDate(pick(row, 'Reporting ends', 'Ends'))?.slice(0, 10),
    spend: spend ?? 0,
    impressions: num(pick(row, 'Impressions')),
    reach: num(pick(row, 'Reach')),
    results: num(pick(row, 'Results')),
    resultType: pick(row, 'Result indicator', 'Result type') || undefined,
    linkClicks: num(pick(row, 'Link clicks', 'Clicks (all)')),
    follows: num(pick(row, 'Instagram follows', 'Follows')),
  };
}

function main() {
  const a = args();
  const csv = a.csv || a._[0];
  if (!csv) {
    console.error('Usage: node scripts/import-ads.mjs --csv <ads-export.csv> [--week YYYY-MM-DD]');
    process.exit(1);
  }
  const ads = readCSVFile(csv).map(rowToAd).filter(Boolean);
  if (!ads.length) {
    console.error('No ad rows found. Export from the Ads tab in Ads Manager with "Amount spent" and "Results" columns.');
    process.exit(1);
  }
  const start = a.week ? weekStart(a.week) : weekStart(ads.find(x => x.from)?.from || new Date().toISOString());
  const week = loadWeek(start);
  delete week.sample;
  week.ads = upsertAds(week.ads || [], ads);
  writeJSON(weekPath(start), week);
  const spend = ads.reduce((s, x) => s + (x.spend || 0), 0);
  console.log(`${start}: ${ads.length} ad row(s), $${spend.toFixed(2)} spent. Unmatched unit codes: ${ads.filter(x => !x.unit).map(x => x.name).join(', ') || 'none'}`);
}

if (isMain(import.meta.url)) main();
