# PROMETRA Weekly

A weekly report for PROMETRA USA and the METO Movement that reads like a pitch deck. Every slide makes one point, with the number and the chart that back it up. Venelt Media presents it to Dr. Omavi Bailey and Nehanda Jones.

It covers three Instagram accounts: **@prometrausa**, the **METO Movement** account, and **@dromavi** (for movement and Africa collab posts).

## The slides

| # | Slide | What it shows |
|---|-------|---------------|
| 1 | Overview | Views for the week, reach, average percent watched, new followers, MOVEMENT comments, the top video, and what goes out next |
| 2 | Views | Every video ranked by views, plus the weekly trend per account |
| 3 | Retention | A watch curve for every video (out of 100 people who started, how many were still watching), skip rate, and average watch time |
| 4 | Every video | The full scorecard, sortable, with each number checked against its day-7 floor from the Q4 plan |
| 5 | Funnel & goals | Reach, then MOVEMENT comments, DMs, clicks, sign-ups, applications and seats. Also the Q4 goals with checkpoints, and the planning math behind 50 seats |
| 6 | Up next | The coming week day by day, everything scheduled through Nov 1, and every video in production by stage |
| 7 | Ads | What is running, ready, needs a re-cut, or still needs filming. Also spend against the monthly plan, spend and results per ad, the boost rules, and audiences |
| 8 | The app | The METO web app screen by screen: how people find it, each area, each screen's sections, what is live, and what was asked for but is not built |
| 9 | What we need | The access, numbers and decisions that unlock the rest of the report |

**Present** turns the page into full-screen slides. Use the arrow keys or swipe to move, and Esc to leave. The account buttons filter every slide. The week arrows step back through past weeks.

## Numbers: real vs. sample

No Instagram or ad numbers were available when this was built. Venelt did not yet have Insights access, and the first @prometrausa post is planned for Fri Oct 2. Until real weeks exist, the performance slides show **sample numbers**. They are marked with a striped "Sample numbers" band on every slide that uses them. The **Sample numbers** switch in the header hides them.

As soon as one real week is in `data/weeks/`, the sample numbers stop showing.

Everything else is real and comes from the team's own plans: the schedule, pipeline, boost plan, targets, ad units and app map. Each data file names its source.

## Friday routine

1. **Instagram numbers.** In Meta Business Suite, go to Insights > Content. Set the date range to the week, click Export data, and choose CSV. Do this once per account. Import the file exactly as downloaded: opening and re-saving it in Excel rounds the long post IDs, and the importer stops if it sees that.
   ```sh
   npm run import:insights -- --csv ~/Downloads/prometrausa.csv --account prometrausa
   ```
   Each post lands in the Monday-to-Sunday week it was published in. Running it again with a newer export updates the numbers. Story frames are skipped unless you add `--stories`. If the file holds a handle the importer does not know yet (the METO Movement handle is not on record), `--account` tells it which account the file is.
2. **What Insights exports leave out.** Open `data/weeks/<monday>.json` and fill these in by hand for each post:
   - `keywordComments`: MOVEMENT comments
   - `skipRate`
   - `retention`: 11 numbers starting at 100, read off the reel's retention graph in the Instagram app at 0%, 10%, and so on up to 100% of the video
   - `avgWatchSec`, if the export did not include it

   Re-imports never overwrite `keywordComments`, `skipRate`, `retention` or a shortened `title`. A later export that includes watch time does replace `avgWatchSec`, since the newer number is the better one.
3. **Ads.** In Ads Manager, open the Ads tab for the week, then Reports > Export table data > CSV.
   ```sh
   npm run import:ads -- --csv ~/Downloads/ads.csv --week 2026-10-12
   ```
   Name ads with their unit code (for example `A1 Fifty Seats` or `mto-02 Back to the Source`) so each row lands on its card, and put METO, PROMETRA or Omavi in the campaign name so each ad lands under the right account. An ad with no account shows only under "All accounts". The "Total" row Ads Manager adds is skipped, and a newer export of the same week replaces the older rows.
4. **Nehanda's Friday counts.** Put sign-ups, applications, seats and ambassadors in the week's `funnel`. `npm run new-week -- --week 2026-10-05` creates the week with every field blank, or adds any missing blank fields to a week an import already created.
5. **Build and share.**
   ```sh
   npm run check   # builds, and stops on data mistakes such as a number typed as text or a misspelled field
   ```
   Then deploy, or republish the artifact from `dist/artifact.html`.

Leave a number as `null` when it was not measured. Never guess a number: the page shows `–` for anything missing.

### Pulling straight from the API (optional)

`npm run fetch:instagram -- --account prometrausa --week 2026-10-05` reads posts and Insights from the Instagram Graph API. It needs `IG_ACCESS_TOKEN` and `IG_USER_ID` from a Meta app with `instagram_manage_insights`.

The API has no retention curve, so step 2 above still applies. Times come back in UTC and are converted to Mountain Time (set `REPORT_TZ` to change it), so a Sunday-evening post stays in its own week. This script has not been run against a live token yet. Expect to adjust metric names on the first run, since Meta renames them between API versions. It warns and skips any metric it cannot read.

## Data files

| File | What it holds | Source |
|------|---------------|--------|
| `data/report.json` | Accounts, Q4 goals and per-post floors, the boost caps and plan, the planning ladder | Q4 Playbook (Sep 24) |
| `data/schedule.json` | Posts, boosts, filming and deadlines, Sep 23 to Nov 1 | Q4 Playbook calendar |
| `data/pipeline.json` | Every piece in production and its stage | Q4 Playbook and Google Drive script docs |
| `data/ads.json` | Ad units, filmed ads and their audit, what still needs filming, audiences and rules | Script Review page, Drive ad docs, Q4 Playbook |
| `data/app.json` | The METO web app, screen by screen | Notion build notes and the live app |
| `data/asks.json` | What we need from the client | Open items across the sources |
| `data/weeks/*.json` | Real weekly numbers (one file per Monday) | Instagram Insights, Ads Manager, Nehanda |
| `data/sample/weeks.json` | Made-up numbers for the preview (`npm run sample` rebuilds them) | Generated |

Keep raw exports out of git. The `.gitignore` already blocks `*.csv`, `*.tsv`, `*.txt`, `*.xls`, `*.xlsx` and the `imports/` folder.

## Build, run, deploy

No dependencies. Node 18 or newer.

```sh
npm run build    # dist/index.html (full page) and dist/artifact.html (Claude artifact)
npm run serve    # build and open locally
npm test         # importer and build tests
```

**Vercel:** import this repo. `vercel.json` sets the build command and the `dist` output, and adds a `noindex` header. For privacy, turn on Vercel's deployment protection, or share the Claude artifact instead.

## What to keep off this page

The report goes to the client, and links travel. Never add:
- pilgrimage prices
- retainer or payment details
- logins
- donor or patient details
- pilgrim names or photos without a signed release

Planning ratios, seats and deadlines are fine for the client, but never in public posts.
