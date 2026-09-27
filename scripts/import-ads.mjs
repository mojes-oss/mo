// Load a Meta Ads Manager export (boosts and ads) into the weekly data.
//
//   node scripts/import-ads.mjs --csv ~/Downloads/ads.csv --week 2026-10-12
//
// In Ads Manager: set the date range to one Monday-Sunday week, open the Ads
// tab, then Reports > Export table data > CSV. Name ads with their unit code
// (for example "A1 Fifty Seats" or "mto-02 Back to the Source") so each row
// matches its card on the Ads slide. Re-importing a newer export of the same
// week replaces the older rows for those ads.
import {
  UserError, args, readCSVFile, findColumn, pick, num, parseDate, parseWeekArg, weekStart, addDays,
  loadWeek, weekPath, writeJSON, upsertAds, unitIdFromName, isMain, run,
} from './lib.mjs';

// Most specific signal first. The ad account's own name is never used: one ad
// account can run ads for every Instagram account.
const ACCOUNT_HINTS = [
  [/prometra/i, 'prometrausa'],
  [/meto|movement/i, 'meto'],
  [/omavi|dromavi/i, 'dromavi'],
];
const hint = text => (ACCOUNT_HINTS.find(([re]) => re.test(text || '')) || [])[1] || null;

// Ads Manager's result indicators, in words a client reads.
const RESULT_WORDS = {
  link_click: 'link clicks',
  landing_page_view: 'landing page views',
  post_engagement: 'post engagements',
  video_view: 'video views',
  profile_visit: 'profile visits',
  'onsite_conversion.post_save': 'saves',
  post_save: 'saves',
  follow: 'follows',
  reach: 'people reached',
  lead: 'leads',
};
export function resultWords(indicator) {
  if (!indicator) return undefined;
  const key = indicator.replace(/^actions:/, '').replace(/^.*\big_/, '').toLowerCase();
  if (RESULT_WORDS[key]) return RESULT_WORDS[key];
  if (/follow/.test(key)) return 'follows';
  if (/profile/.test(key)) return 'profile visits';
  if (/link_click/.test(key)) return 'link clicks';
  if (/[a-z]/.test(indicator) && !/[:_.]/.test(indicator)) return indicator.toLowerCase();
  return 'results';
}

export function columnsFor(rows) {
  return {
    adName: findColumn(rows, 'Ad name'),
    adSet: findColumn(rows, 'Ad set name'),
    campaign: findColumn(rows, 'Campaign name'),
    instagram: findColumn(rows, 'Instagram account', 'Instagram account name'),
    spend: findColumn(rows, 'Amount spent (USD)', 'Amount spent', 'Spend'),
    impressions: findColumn(rows, 'Impressions'),
    reach: findColumn(rows, 'Reach'),
    results: findColumn(rows, 'Results'),
    resultType: findColumn(rows, 'Result indicator', 'Result type'),
    linkClicks: findColumn(rows, 'Link clicks') || findColumn(rows, 'Clicks (all)'),
    follows: findColumn(rows, 'Instagram follows') || findColumn(rows, 'Follows'),
    from: findColumn(rows, 'Reporting starts', 'Starts'),
    to: findColumn(rows, 'Reporting ends', 'Ends'),
  };
}

const cell = (row, col) => (col === undefined ? '' : row[col] || '');
const SUMMARY = /^(total|totals|results from\b)/i;

export function rowToAd(row, cols = columnsFor([row]), { hasAdNames = false } = {}) {
  const adName = cell(row, cols.adName), adSet = cell(row, cols.adSet), campaign = cell(row, cols.campaign);
  // Ads Manager adds a summary row ("Total", "Results from 3 ads") that would double the spend.
  if ([adName, adSet, campaign].some(v => SUMMARY.test(v))) return null;
  if (hasAdNames && !adName) return null;
  const name = adName || campaign || pick(row, 'Name');
  if (!name) return null;
  const spend = num(cell(row, cols.spend));
  if (spend === null && num(cell(row, cols.impressions)) === null) return null;
  const unit = unitIdFromName(name);
  const account = hint(cell(row, cols.instagram))
    || (unit && unit.startsWith('mto-') ? 'meto' : null)
    || hint(campaign)
    || hint(adSet)
    || hint(name);
  return {
    name,
    unit,
    account,
    from: parseDate(cell(row, cols.from))?.slice(0, 10),
    to: parseDate(cell(row, cols.to))?.slice(0, 10),
    spend: spend ?? 0,
    impressions: num(cell(row, cols.impressions)),
    reach: num(cell(row, cols.reach)),
    results: num(cell(row, cols.results)),
    resultType: resultWords(cell(row, cols.resultType)),
    linkClicks: num(cell(row, cols.linkClicks)),
    follows: num(cell(row, cols.follows)),
  };
}

export function parseAds(rows) {
  const cols = columnsFor(rows);
  const hasAdNames = !!cols.adName && rows.some(r => cell(r, cols.adName) && !SUMMARY.test(cell(r, cols.adName)));
  return rows.map(r => rowToAd(r, cols, { hasAdNames })).filter(Boolean);
}

async function main() {
  const a = args();
  const csv = a.csv || a._[0];
  if (!csv) throw new UserError('Usage: npm run import:ads -- --csv <ads-export.csv> [--week YYYY-MM-DD]');
  const ads = parseAds(readCSVFile(csv));
  if (!ads.length) throw new UserError('No ad rows found. Export from the Ads tab in Ads Manager with the "Amount spent" and "Results" columns.');
  const firstFrom = ads.find(x => x.from)?.from;
  const start = a.week ? parseWeekArg(a.week) : firstFrom ? weekStart(firstFrom) : parseWeekArg();
  const end = addDays(start, 6);
  const outside = ads.filter(x => x.from && (x.from < start || (x.to || x.from) > end));
  if (outside.length) {
    console.warn(`Warning: ${outside.length} row(s) report dates outside ${start} to ${end} (for example "${outside[0].name}", ${outside[0].from} to ${outside[0].to}). Export exactly one Monday-Sunday week.`);
  }
  const week = loadWeek(start);
  delete week.sample;
  week.ads = upsertAds(week.ads || [], ads, start);
  writeJSON(weekPath(start), week);
  const spend = ads.reduce((s, x) => s + (x.spend || 0), 0);
  console.log(`${start}: ${ads.length} ad row(s), $${spend.toFixed(2)} spent.`);
  const noAccount = ads.filter(x => !x.account).map(x => x.name);
  if (noAccount.length) console.log(`No account found for: ${noAccount.join(', ')}. They show only under "All accounts". Put METO, PROMETRA or Omavi in the campaign name to fix it.`);
  const noUnit = ads.filter(x => !x.unit).map(x => x.name);
  if (noUnit.length) console.log(`No unit code in: ${noUnit.join(', ')}.`);
}

if (isMain(import.meta.url)) run(main);
