# SleepMD SFX palette

Turns the real sound library already on the Mac into a large, sorted SFX palette,
so every scene in a SleepMD reel gets its own sound.

**No synthesized sounds.** This tool never makes audio. It only measures real
recorded files that are already licensed (Apple's Final Cut Pro Sound Effects
library, and anything you add from Epidemic Sound) and sorts them into roles.

## Why

The King and SleepMD edits draw on about 30 SFX keys. The Apple library on the
Mac has 1,337 files. One short used the same whoosh 13 times ("machine-gun
repetition"). This builds 150+ distinct keys, grouped by what they score on
screen, and the picker never repeats a sound inside one video.

## Run it (on the Mac)

```bash
cd sfx-palette
python3 build_palette.py --previews
```

Defaults: library `/Library/Audio/Apple Loops/Apple/Final Cut Pro Sound Effects`,
spec `palette_spec.json`, output `out/`. Needs `ffmpeg` on PATH and `numpy`.
The first run measures every file (a few minutes). Later runs reuse
`out/measure_cache.json` and only measure new or changed files.

Outputs in `out/`:

| File | What it is |
|---|---|
| `palette.json` | role → keys, and key → absolute path, sync point (s), peak/RMS dB, attack, tail, centroid, suggested gain |
| `palette_report.md` | keys per role vs target, which roles came up short, and Epidemic Sound search terms to fill them |
| `previews/<role>.wav` | one audition file per role: every sound in that role, peak-matched, 0.5 s apart |
| `measure_cache.json` | per-file measurements |

To add Epidemic Sound downloads, put them in a folder and run again with
`--library` pointing at that folder and `--out` at a second output dir.

## How files are sorted

For each file it measures, from a mono 22.05 kHz decode:

- **sync point**: time of the loudest 10 ms window (same idea as `sfx_scan.py`)
- **attack**: rise time from onset (-20 dB) to within 3 dB of the peak. Bigger = softer entry
- **tail**: time from the peak until it falls 30 dB
- **spectral centroid**: lower = warmer, less hissy
- **crest factor**: peak minus RMS. Lower = less spiky

A file fits a role when its folder or filename matches the role's hints, no
exclude word appears, and it passes the role's duration, attack, centroid and
crest limits. Each file goes to the single role it fits best, so no sound is
used in two roles. Roles that come up short get one more pass with limits
loosened by 25%, and the report says so.

## Use it in the edit pipeline

```python
from palette import Palette
pal = Palette("sfx-palette/out/palette.json")

key = pal.pick("glide_soft", video="N21")          # never repeats inside N21
key = pal.pick_for_device("checkmark", video="N21") # uses the spec's device map
key = pal.pick("glide_soft", video="TV", tv=True)   # only TV-calm roles

info = pal.keys[key]   # info["path"], info["sync_s"], info["gain_db"]
```

`gain_db` puts the file's peak at -12 dBFS, and never above the -10 dBFS
ceiling for placed SFX. Still ebur128-check the finished preview before
delivering (see the Sep 26 `light_on` clipping bug).

Paths are always absolute. ffmpeg reads a relative path that starts with a
folder like `Work:Home` as a protocol name, so the tool passes `file:` URLs.

## Tests

```bash
python3 -m unittest discover -s sfx-palette/tests -v
```

The tests build a throwaway library of test tones in a temp folder (including
a `Work:Home` folder), run the whole pipeline on it, and delete it.
