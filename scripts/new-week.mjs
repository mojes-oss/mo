// Start a week file with every number blank (null), ready to fill in.
// If the week already exists (for example after an import), it adds any missing
// fields as blanks and leaves the numbers already there alone.
//
//   npm run new-week -- --week 2026-10-05
import { existsSync } from 'node:fs';
import { args, parseWeekArg, weekPath, loadWeek, writeJSON, isMain, run } from './lib.mjs';

async function main() {
  const start = parseWeekArg(args().week);
  const existed = existsSync(weekPath(start));
  writeJSON(weekPath(start), loadWeek(start));
  console.log(existed
    ? `data/weeks/${start}.json already existed. Added any missing fields as blanks; nothing else changed.`
    : `Created data/weeks/${start}.json. Fill in the numbers (leave null for anything not measured), then npm run check.`);
}

if (isMain(import.meta.url)) run(main);
