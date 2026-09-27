// Shared helpers for the build and import scripts. No dependencies: Node 18+.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');
export const WEEKS = join(DATA, 'weeks');

export const ACCOUNT_IDS = ['prometrausa', 'meto', 'dromavi'];

// Every week file has this shape. null means "not measured"; the page shows "–".
export const ACCOUNT_FIELDS = ['followers', 'newFollowers', 'views', 'reach', 'profileVisits', 'linkTaps'];
export const FUNNEL_FIELDS = ['reach', 'keywordComments', 'dmsDelivered', 'linkClicks', 'signups', 'applications', 'seats', 'ambassadors'];
export const POST_NUMBER_FIELDS = ['lengthSec', 'views', 'reach', 'avgWatchSec', 'skipRate', 'likes', 'comments', 'keywordComments', 'shares', 'saves', 'follows', 'linkClicks', 'profileVisits'];

// A friendly one-line failure for people running the scripts, instead of a stack trace.
export class UserError extends Error {}

export function readJSON(path, fallback) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new UserError(`Missing file: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UserError(`Could not read ${basename(path)}: ${err.message}. Check for a missing comma or quote near that spot.`);
  }
}

export function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

// RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF, and a UTF-8 BOM.
// Meta exports are sometimes UTF-16 or tab-separated, so detect both.
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function readCSVFile(path) {
  if (!existsSync(path)) throw new UserError(`Could not find ${path}. Check the file name and folder.`);
  const buf = readFileSync(path);
  // UTF-16 LE export (Excel "Unicode text") starts with FF FE.
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  return parseCSV(text);
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// The first header, of several spellings, that exists in the file (even if some cells are blank).
// Choosing the column once per file stops a blank "Views" cell from silently using "Impressions".
export function findColumn(rows, ...names) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  for (const name of names) {
    const hit = headers.find(h => norm(h) === norm(name));
    if (hit !== undefined) return hit;
  }
  for (const name of names) {
    const hit = headers.find(h => norm(h).startsWith(norm(name)));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// Find a non-blank cell by any of several header spellings, ignoring case, spaces and punctuation.
// Use it for text fields where falling through to the next spelling is fine.
export function pick(row, ...names) {
  const keys = Object.keys(row);
  for (const name of names) {
    const hit = keys.find(k => norm(k) === norm(name));
    if (hit !== undefined && row[hit] !== '') return row[hit];
  }
  for (const name of names) {
    const hit = keys.find(k => norm(k).startsWith(norm(name)));
    if (hit !== undefined && row[hit] !== '') return row[hit];
  }
  return undefined;
}

// "1,234" -> 1234, "$12.50" -> 12.5, "" -> null, "12.3%" -> 12.3
export function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[$,%\s]/g, '');
  if (s === '' || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
function to24(h, ampm) {
  h = Number(h);
  if (!ampm) return h;
  const pm = /p/i.test(ampm);
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}
function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Parse the date formats Meta and Excel use, returning local "YYYY-MM-DDTHH:MM", or null:
// "10/02/2026 16:00", "10/02/2026 4:00 PM", "10/02/2026 4:00:00 PM",
// "2026-10-02T16:00:00-0600", "2026-10-02", "Oct 2, 2026 4:00 pm".
export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let y, mo, d, h = 0, mi = 0, ap;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?)?/);
  if (m) [, mo, d, y, h = 0, mi = 0, ap] = m;
  else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/))) [, y, mo, d, h = 0, mi = 0] = m;
  else if ((m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?)?/))) {
    const month = MONTH[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)];
    if (!month) return null;
    mo = month; [, , d, y, h = 0, mi = 0, ap] = m;
  } else return null;
  y = Number(y); mo = Number(mo); d = Number(d);
  const hh = to24(h, ap), mm = Number(mi);
  if (!validDate(y, mo, d) || hh > 23 || mm > 59) return null;
  return `${y}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mm)}`;
}

// The Monday (YYYY-MM-DD) of the week that contains an ISO date string.
export function weekStart(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dow);
  return date.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return date.toISOString().slice(0, 10);
}

// Today's date where the script runs (not UTC), so Sunday evening stays in this week.
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// --week accepts 2026-10-05 or 10/05/2026 and returns that week's Monday.
export function parseWeekArg(v, fallback = localToday()) {
  if (v === undefined || v === true) return weekStart(fallback);
  const iso = parseDate(String(v));
  if (!iso) throw new UserError(`Could not read --week "${v}". Use --week YYYY-MM-DD, for example --week 2026-10-05.`);
  return weekStart(iso);
}

export function emptyWeek(start) {
  return fillWeekTemplate({ start });
}

// Add any missing keys (as null) without touching numbers already filled in.
export function fillWeekTemplate(week) {
  week.end = week.end || addDays(week.start, 6);
  week.accounts = week.accounts || {};
  for (const id of ACCOUNT_IDS) {
    week.accounts[id] = week.accounts[id] || {};
    for (const f of ACCOUNT_FIELDS) if (!(f in week.accounts[id])) week.accounts[id][f] = null;
  }
  week.funnel = week.funnel || {};
  for (const f of FUNNEL_FIELDS) if (!(f in week.funnel)) week.funnel[f] = null;
  week.posts = week.posts || [];
  week.ads = week.ads || [];
  week.notes = week.notes || [];
  const ordered = { start: week.start, end: week.end };
  return Object.assign(ordered, week);
}

export function weekPath(start) {
  return join(WEEKS, `${start}.json`);
}

export function loadWeek(start) {
  const path = weekPath(start);
  return fillWeekTemplate(existsSync(path) ? readJSON(path) : { start });
}

// Week files with their file names, so checks can catch a copied file that kept the old "start".
export function listWeekFiles(dir = WEEKS) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(file => ({ file, week: readJSON(join(dir, file)) }));
}

export function listWeeks(dir = WEEKS) {
  return listWeekFiles(dir).map(x => x.week);
}

// Fields a person fills in by hand. An import never overwrites them once they are set.
// avgWatchSec is not here on purpose: a newer export's watch time should replace an older one.
const MANUAL = ['title', 'keywordComments', 'retention', 'skipRate', 'linkClicks', 'boosted', 'note', 'series'];
const isSet = v => v !== null && v !== undefined && v !== '';

// Upsert posts by id. Imported numbers replace old numbers; a hand-filled field
// (a shortened title, MOVEMENT comments, the retention curve) is never replaced.
export function mergePosts(existing, incoming) {
  const byId = new Map(existing.map(p => [p.id, p]));
  for (const p of incoming) {
    const old = byId.get(p.id);
    if (!old) { byId.set(p.id, p); continue; }
    const merged = { ...old };
    for (const [k, v] of Object.entries(p)) {
      if (!isSet(v)) continue;
      if (MANUAL.includes(k) && isSet(old[k])) continue;
      merged[k] = v;
    }
    byId.set(p.id, merged);
  }
  return [...byId.values()].sort((a, b) => String(a.posted).localeCompare(String(b.posted)));
}

// Ad units are named like "A1 Fifty Seats", "R-C retarget", "mto-02 Back to the Source".
export function unitIdFromName(name = '') {
  const m = name.match(/\b(A5b|A[1-6]|R-[A-H]|C[1-4]|P[1-4]|O[1-6]|D[1-3]|(?:mto|afr|omv|evt)-\d{2})\b/i);
  return m ? m[1].replace(/^(mto|afr|omv|evt)/i, s => s.toLowerCase()) : null;
}

// A newer export of the same week replaces the older rows for each ad it contains.
// Rows from other ads (for example a second ad account's export) are kept, and a
// day-by-day export keeps one row per day.
export function upsertAds(existing, incoming, start) {
  const end = start ? addDays(start, 6) : null;
  const inWeek = a => !start || !a.from || (a.from >= start && (a.to || a.from) <= end);
  const names = new Set(incoming.map(a => a.name));
  const kept = existing.filter(a => !(names.has(a.name) && inWeek(a)));
  const byKey = new Map();
  for (const a of incoming) byKey.set(`${a.name}|${a.from || ''}|${a.to || ''}`, a);
  return [...kept, ...byKey.values()];
}

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// True when the module is the script node was asked to run (not an import from a test).
export function isMain(metaUrl) {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}

// Run a script's main(), printing a UserError as one clear line instead of a stack trace.
export async function run(main) {
  try {
    await main();
  } catch (err) {
    if (err instanceof UserError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
