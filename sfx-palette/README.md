# SleepMD SFX palette

Turns the real sound library already on the Mac into a large, sorted SFX palette,
so every scene in a SleepMD reel gets its own sound.

**No synthesized sounds.** This tool never makes audio. It only measures real
recorded files that are already licensed (Apple's Final Cut Pro Sound Effects
library, and anything you add from Epidemic Sound) and sorts them into roles.

## Why

The King and SleepMD edits draw on about 30 SFX keys. The Apple library on the
Mac has 1,337 files. One short used the same whoosh 13 times ("machine-gun
repetition"). This builds up to 246 distinct keys across 18 roles, grouped by what they score on
screen, and the picker never repeats a sound inside one video.

## Run it (on the Mac)

```bash
cd sfx-palette
python3 build_palette.py \
  --library "/Library/Audio/Apple Loops/Apple/Final Cut Pro Sound Effects" \
  --library ~/SFX/packs \
  --previews
```

With no `--library`, it uses the Apple library only. Put downloaded packs
(the Drive packs, Epidemic Sound, Ocular Sounds, CinePacks) as unzipped folders
under `~/SFX/packs/`; every audio file below that folder is picked up. The
sources and their licenses are tracked in Notion: Dr. Omavi Bailey →
SleepMD — Music, SFX & Asset Library → 🔊 SFX Sources.

Needs `ffmpeg` on PATH and `numpy`. The first run measures every file (a few
minutes). Later runs reuse `out/measure_cache.json` and only measure new or
changed files.

Files that hold a row of separate hits (a pack's `Clicks.wav` with 20 clicks)
are split into one sound per hit, each with its own in and out point. Single
designed sounds are left whole. Use `--no-split` to turn this off.

Outputs in `out/`:

| File | What it is |
|---|---|
| `palette.json` | role → keys, and key → absolute path, in/out points (`start_s`, `end_s`), sync point (`sync_s`, seconds into the file), peak/RMS dB, attack, tail, centroid, reels and TV clip gains, TV-safe flag |
| `palette_report.md` | keys per role vs target, which roles came up short, and Epidemic Sound search terms to fill them |
| `previews/<role>.wav` | one audition file per role: every sound in that role, peak-matched, 0.5 s apart |
| `measure_cache.json` | per-file measurements |

## How files are sorted

`palette_spec.json` defines 18 roles (what each sound scores on screen) and the
placement rules. For each file the builder trims head and tail quieter than
50 dB below the peak, then measures, from a mono 22.05 kHz decode:

- **sync point**: time of the loudest 10 ms window (same idea as `sfx_scan.py`),
  also given as a fraction of the sound's length (`sync_frac`)
- **attack**: rise time from onset (-20 dB) to within 3 dB of the peak. Bigger = softer entry
- **tail**: time from the peak until it falls 30 dB
- **spectral centroid**: lower = warmer, less hissy
- **crest factor**: peak minus RMS. Lower = less spiky

Then the roles claim sounds one at a time, in the order the spec lists them,
each taking its best matches (lowest crest, then lowest centroid) up to its
target:

- **Name and folder.** An Apple file must sit in one of the role's Apple folders
  and have a name hint. The transition roles (`glide_soft`, `whip_motion`,
  `low_dolly`, `rise_swell`) may also take plain names like "Whoosh 07" in their
  folders. Files from packs and Epidemic need a name hint. Exclude words always win.
- **Gates.** Duration, attack, centroid and crest limits, plus shape checks:
  gentle transitions peak between 20% and 80% of their length, swells peak in
  the last 30%, drops can't be low thuds, and payoff chimes need a long tail.
- **Fallback.** A role under half its target searches name hints across the
  whole library, never in the Cartoon, Weapons, Explosions, Sci-Fi or Impacts folders.
- **Relax once.** A role still short loosens crest (+2 dB), centroid (+15%) and
  attack (-30%) one time. Relaxed keys are marked reels-only.
- **Variety.** Each sound goes to one role only. At most 3 keys come from one
  source file, at least 1 s apart, and a near-twin (same name apart from the
  number, with duration and centroid within 5%) is skipped.

Keys are named `<role>_a01` (Apple), `<role>_e01` (Epidemic) or `<role>_p01`
(other packs). Long continuous recordings (a ticking clock, rain) are kept
whole; trim them in the edit.

## Use it in the edit pipeline

```python
from palette import Palette
pal = Palette("sfx-palette/out/palette.json", usage_log="sfx-palette/out/usage_log.json")

key = pal.pick("glide_soft", video="N21", scene="S3")                # locked to S3 for all of N21
key = pal.pick("tick_soft", video="N21", scene="S4", repeat=True)    # same motion again, max 3 uses
key = pal.pick_for_device("checkmark", video="N21", scene="S5")      # uses the spec's device map
key = pal.pick("glide_soft", video="TV-sleep", scene="T1", tv=True)  # TV-safe keys only
pal.finish_video("N21")   # log what N21 used so the next videos pick fresh sounds

info = pal.keys[key]   # path, start_s, end_s, sync_s, gain_db, gain_db_tv
```

The picker follows the spec's variety rule: a key belongs to the first scene
that uses it and is locked for the rest of that video. New picks prefer the
least recently used key across the last 10 videos in the usage log. `tv=True`
only returns keys marked `calm_ok_for_tv`, which leaves out reels-only roles,
relaxed keys and room-event names (doorbell, phone, cough, footsteps...).

To place a key so its peak lands on a motion at time `T` in the edit: use the
file from `start_s` to `end_s`, starting it at `T - (sync_s - start_s)`.

`gain_db` is the clip gain for the spec's reels level (whooshes -13 dBFS peak,
swells and shimmers -15, fast transients -18, beds -38 dBFS RMS). `gain_db_tv`
is the quieter TV level (-18, transients -24, swells -22, bed -40 RMS). Neither
ever puts a clip above the -10 dBFS ceiling. Still ebur128-check the finished
preview before delivering (see the Sep 26 `light_on` clipping bug).

Paths are always absolute. ffmpeg reads a relative path that starts with a
folder like `Work:Home` as a protocol name, so the tool passes `file:` URLs.

## Tests

```bash
python3 -m unittest discover -s sfx-palette/tests -v
```

The tests build two throwaway libraries of test tones in a temp folder (an
Apple-style one with a `Work:Home` folder, and a pack with a multi-hit file),
run the whole pipeline and the picker on them, and delete them.
