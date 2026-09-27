// Shared helpers for the build and import scripts. No dependencies: Node 18+.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');
export const WEEKS = join(DATA, 'weeks');

export const ACCOUNT_IDS = ['prometrausa', 'meto', 'dromavi'];

export function readJSON(path, fallback) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing file: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${path}: ${err.message}`);
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
  const buf = readFileSync(path);
  // UTF-16 LE export (Excel "Unicode text") starts with FF FE.
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
  return parseCSV(text);
}

// Find a column by any of several header spellings, ignoring case, spaces and punctuation.
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function pick(row, ...names) {
  const keys = Object.keys(row);
  for (const name of names) {
    const want = norm(name);
    const hit = keys.find(k => norm(k) === want);
    if (hit !== undefined && row[hit] !== '') return row[hit];
  }
  for (const name of names) {
    const want = norm(name);
    const hit = keys.find(k => norm(k).startsWith(want));
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

// Parse the date formats Meta uses: "09/25/2026 16:00", "2026-09-25T16:00:00-0600", "2026-09-25".
export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const [, mo, d, y, h = '0', mi = '0'] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h = '00', mi = '00'] = m;
    return `${y}-${mo}-${d}T${h}:${mi}`;
  }
  return null;
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

export function emptyWeek(start) {
  return {
    start,
    end: addDays(start, 6),
    accounts: {},
    posts: [],
    funnel: {},
    ads: [],
    notes: [],
  };
}

export function weekPath(start) {
  return join(WEEKS, `${start}.json`);
}

export function loadWeek(start) {
  return readJSON(weekPath(start), emptyWeek(start));
}

export function listWeeks(dir = WEEKS) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map(f => readJSON(join(dir, f)));
}

// Fields a person fills in by hand. An import never overwrites them with blanks.
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

export function upsertAds(existing, incoming) {
  const key = a => `${a.name}|${a.from || ''}|${a.to || ''}`;
  const byKey = new Map(existing.map(a => [key(a), a]));
  for (const a of incoming) byKey.set(key(a), { ...byKey.get(key(a)), ...a });
  return [...byKey.values()];
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
