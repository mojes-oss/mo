#!/usr/bin/env python3
"""Build the SleepMD SFX palette from REAL recorded sound libraries.

This script never creates sound. It measures every file in one or more existing
libraries (by default Apple's Final Cut Pro Sound Effects, installed on the Mac)
and sorts the sounds into the palette roles defined in palette_spec.json, using
acoustic gates (duration, attack, spectral centroid, crest factor, shape) plus
filename and folder hints. Files that hold a row of separate hits (a pack's
"Clicks.wav" with 20 clicks in it) are split into one entry per hit.

The result is a much larger set of distinct keys, so every scene in a reel can
get its own sound instead of repeating the same whoosh.

Outputs (in --out):
  palette.json        role -> keys, key -> path, in/out points, sync point, levels, gains
  palette_report.md   counts per role vs target, shortfalls, Epidemic search terms
  measure_cache.json  per-file measurements (reused on the next run)
  previews/<role>.wav one audition file per role (only with --previews)

Usage:
  python3 build_palette.py
  python3 build_palette.py --library "/Library/Audio/Apple Loops/Apple/Final Cut Pro Sound Effects" \
      --library ~/SFX/packs --spec palette_spec.json --out out --previews

Requires ffmpeg on PATH (or --ffmpeg) and numpy.
"""

import argparse
import collections
import concurrent.futures
import json
import math
import os
import re
import shutil
import subprocess
import sys
import wave

import numpy as np

DEFAULT_LIBRARY = "/Library/Audio/Apple Loops/Apple/Final Cut Pro Sound Effects"
APPLE_LIBRARY_NAME = "Final Cut Pro Sound Effects"
AUDIO_EXTS = {".caf", ".wav", ".aif", ".aiff", ".mp3", ".m4a", ".flac", ".ogg"}
SR = 22050             # analysis sample rate
WIN = int(SR * 0.010)  # 10 ms envelope window
HOP = int(SR * 0.005)  # 5 ms hop
SILENT_DB = -80.0
TRIM_DB = 50.0         # head and tail quieter than this below the peak are trimmed first
PEAK_CEIL_DB = -10.0   # placed SFX must never peak above this

# One relaxation step for roles that come up short. Durations and shape gates never relax.
RELAX_CREST_DB = 2.0
RELAX_CENTROID = 1.15
RELAX_ATTACK = 0.7

MAX_KEYS_PER_FILE = 3
MIN_SLICE_GAP_S = 1.0  # slices taken from one file must sit at least this far apart
FAMILY_TOLERANCE = 0.05

# Placed levels from the spec (sample-peak dBFS unless noted).
REELS_PEAK = {"glide_soft": -13.0, "whip_motion": -13.0, "low_dolly": -13.0,
              "rise_swell": -15.0, "shimmer_reveal": -15.0, "chime_payoff": -14.0}
REELS_TRANSIENT_PEAK = -18.0
REELS_DEFAULT_PEAK = -14.0
TV_PEAK = {"rise_swell": -22.0, "shimmer_reveal": -22.0}
TV_TRANSIENT_PEAK = -24.0
TV_DEFAULT_PEAK = -18.0
BED_RMS = {"reels": -38.0, "tv": -40.0}
TRANSIENT_ATTACK_MS = 10.0

# Splitting multi-hit files: a gap of at least SPLIT_GAP_S that sits SPLIT_DB below
# the file's loudest moment separates two hits.
SPLIT_MIN_FILE_S = 1.0
SPLIT_DB = 40.0
SPLIT_GAP_S = 0.15
SPLIT_MIN_HIT_S = 0.03
SPLIT_PRE_S = 0.02
SPLIT_POST_S = 0.08
SPLIT_MAX_HITS = 64

DEFAULT_TV_EXCLUDES = ["doorbell", "knock", "alarm", "phone", "ringtone", "buzzer", "beep",
                       "bell", "chime", "footstep", "cough", "sneeze", "breath", "voice"]
DEFAULT_BANNED_FOLDERS = ["Cartoon", "Weapons", "Explosions", "Sci-Fi", "Impacts"]


def db(x):
    return 20.0 * math.log10(max(float(x), 1e-12))


def ffmpeg_input(path):
    # Always hand ffmpeg an absolute "file:" URL. A relative path that starts with
    # a folder like "Work:Home" is otherwise read as a protocol name.
    return "file:" + os.path.abspath(path)


def decode(ffmpeg, path, sr=SR, channels=1):
    # -vn: some pack WAVs carry cover art as a video stream.
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-i", ffmpeg_input(path), "-vn",
           "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-"]
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
    x = np.frombuffer(out, dtype=np.float32)
    if channels > 1:
        x = x.reshape(-1, channels)
    return x


def envelope(x):
    frames = 1 + (len(x) - WIN) // HOP
    idx = np.arange(WIN)[None, :] + HOP * np.arange(frames)[:, None]
    env = np.sqrt(np.mean(x[idx] ** 2, axis=1) + 1e-20)
    t = (np.arange(frames) * HOP + WIN / 2) / SR
    return env, 20.0 * np.log10(env), t


def trim(x):
    """Sample range with head and tail more than TRIM_DB below the loudest frame removed."""
    _env, env_db, _t = envelope(x)
    keep = np.nonzero(env_db >= env_db.max() - TRIM_DB)[0]
    a = int(keep[0]) * HOP
    b = min(len(x), int(keep[-1]) * HOP + WIN)
    return a, b


def metrics(x, offset_s=0.0):
    """Acoustic fingerprint of one sound. The envelope peak is the sync point."""
    if len(x) < WIN or db(np.max(np.abs(x))) < SILENT_DB:
        return None
    a, b = trim(x)
    x = x[a:b]
    offset_s += a / SR
    n = len(x)
    if n < WIN:
        return None
    peak_db = db(np.max(np.abs(x)))
    env, env_db, t = envelope(x)
    ip = int(np.argmax(env_db))
    env_peak = float(env_db[ip])
    sync_s = float(t[ip])

    # Attack = rise time from onset (-20 dB) to within 3 dB of the peak. Measuring
    # to the exact peak is unstable on sounds with a flat, noisy plateau.
    onset = int(np.nonzero(env_db >= env_peak - 20.0)[0][0])
    top = int(np.nonzero(env_db >= env_peak - 3.0)[0][0])
    attack_ms = max(0.0, float(t[top] - t[onset]) * 1000.0)
    after = np.nonzero(env_db[ip:] >= env_peak - 30.0)[0]
    tail_ms = float(t[ip + after[-1]] - sync_s) * 1000.0 if len(after) else 0.0

    active = env_db >= env_peak - 40.0
    rms_db = db(np.sqrt(np.mean(env[active] ** 2)))

    # Energy-weighted spectral centroid.
    fft_n, fft_hop = 1024, 512
    if n >= fft_n:
        nf = 1 + (n - fft_n) // fft_hop
        fidx = np.arange(fft_n)[None, :] + fft_hop * np.arange(nf)[:, None]
        spec = np.abs(np.fft.rfft(x[fidx] * np.hanning(fft_n)[None, :], axis=1))
        freqs = np.fft.rfftfreq(fft_n, 1.0 / SR)
        cent = (spec * freqs[None, :]).sum(axis=1) / (spec.sum(axis=1) + 1e-12)
        energy = (spec ** 2).sum(axis=1)
        centroid_hz = float((cent * energy).sum() / (energy.sum() + 1e-12))
    else:
        centroid_hz = 0.0

    dur = n / SR
    return {
        "start_s": round(offset_s, 3),
        "end_s": round(offset_s + dur, 3),
        "dur_s": round(dur, 3),
        "sync_s": round(offset_s + sync_s, 3),
        "sync_frac": round(sync_s / dur, 3),
        "attack_ms": round(attack_ms, 1),
        "tail_ms": round(tail_ms, 1),
        "peak_db": round(peak_db, 2),
        "rms_db": round(rms_db, 2),
        "crest_db": round(peak_db - rms_db, 2),
        "centroid_hz": round(centroid_hz, 1),
    }


def find_hits(x):
    """(start, end) sample ranges of separate hits, or [] if the file is one sound."""
    if len(x) / SR < SPLIT_MIN_FILE_S:
        return []
    _env, env_db, t = envelope(x)
    active = env_db >= float(env_db.max()) - SPLIT_DB
    runs, start = [], None
    for i, on in enumerate(active):
        if on and start is None:
            start = i
        elif not on and start is not None:
            runs.append([start, i - 1])
            start = None
    if start is not None:
        runs.append([start, len(active) - 1])
    merged = []
    for r in runs:
        if merged and t[r[0]] - t[merged[-1][1]] < SPLIT_GAP_S:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    hits = [(t[a], t[b]) for a, b in merged if t[b] - t[a] >= SPLIT_MIN_HIT_S]
    if len(hits) < 2 or len(hits) > SPLIT_MAX_HITS:
        return []
    dur = len(x) / SR
    return [(int(max(0.0, a - SPLIT_PRE_S) * SR), int(min(dur, b + SPLIT_POST_S) * SR))
            for a, b in hits]


def measure(ffmpeg, path, split=True):
    """List of entries for one file: the whole file, or one entry per hit."""
    x = decode(ffmpeg, path)
    hits = find_hits(x) if split else []
    if not hits:
        m = metrics(x)
        return [dict(m, multi=False)] if m else []
    out = []
    for a, b in hits:
        m = metrics(x[a:b], offset_s=a / SR)
        if m:
            out.append(dict(m, multi=True))
    return out


def find_audio(library):
    for root, _dirs, files in os.walk(library):
        for f in sorted(files):
            if os.path.splitext(f)[1].lower() in AUDIO_EXTS and not f.startswith("._"):
                yield os.path.join(root, f)


def load_cache(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def measure_library(ffmpeg, libraries, cache_path, jobs, split=True):
    """Measure every audio file in the libraries. Returns path -> record."""
    if isinstance(libraries, str):
        libraries = [libraries]
    cache = load_cache(cache_path)
    todo, results, total = [], {}, 0
    for lib in libraries:
        for p in find_audio(lib):
            total += 1
            st = os.stat(p)
            stamp = f"v2:{st.st_size}:{int(st.st_mtime)}:{int(split)}"
            hit = cache.get(p)
            if hit and hit.get("stamp") == stamp and ("entries" in hit or "error" in hit):
                results[p] = dict(hit, library=os.path.abspath(lib))
            else:
                todo.append((p, stamp, os.path.abspath(lib)))

    def work(item):
        p, stamp, lib = item
        rec = {"stamp": stamp, "library": lib}
        try:
            entries = measure(ffmpeg, p, split)
        except subprocess.CalledProcessError as e:
            rec["error"] = e.stderr.decode(errors="replace")[:300]
            return p, rec
        if entries:
            rec["entries"] = entries
        else:
            rec["error"] = "silent or too short"
        return p, rec

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as ex:
        for i, (p, rec) in enumerate(ex.map(work, todo), 1):
            results[p] = rec
            if i % 100 == 0:
                print(f"  measured {i}/{len(todo)}", file=sys.stderr)

    with open(cache_path, "w") as fh:
        json.dump(results, fh, indent=1, sort_keys=True)
    print(f"{total} files ({len(todo)} newly measured)", file=sys.stderr)
    return results


def source_letter(library):
    """a = Apple library, e = Epidemic Sound downloads, p = any other pack."""
    if os.path.basename(os.path.normpath(library)) == APPLE_LIBRARY_NAME:
        return "a"
    if "epidemic" in library.lower():
        return "e"
    return "p"


def family_of(path):
    """Files from one family share a folder and a name apart from their numbers."""
    stem = os.path.splitext(os.path.basename(path))[0].lower()
    stem = re.sub(r"[\d_\-\s.]+", " ", stem).strip()
    return os.path.dirname(path), stem


Candidate = collections.namedtuple("Candidate", "cid path library rel hay source entry")


def candidates(measured):
    """Flatten records into Candidates. cid is unique per sound."""
    out = []
    for p, rec in measured.items():
        if "error" in rec:
            continue
        lib = rec["library"]
        rel = os.path.relpath(p, lib)
        hay = f"{os.path.basename(lib)}/{rel}".lower()
        for e in rec["entries"]:
            cid = f"{p}@{e['start_s']:.3f}" if e["multi"] else p
            out.append(Candidate(cid, p, lib, rel, hay, source_letter(lib), e))
    return out


def text_hits(needles, haystack):
    return [h for h in needles if h and h.lower() in haystack]


def passes_gates(role, m, relaxed=False):
    """Acoustic and shape gates. Relaxing loosens crest, centroid and attack by one step."""
    lo, hi = (role.get("duration_s") or [0, 1e9])[:2]
    if not lo <= m["dur_s"] <= hi:
        return False
    attack_min = (role.get("attack_ms_min") or 0) * (RELAX_ATTACK if relaxed else 1.0)
    if m["attack_ms"] < attack_min:
        return False
    cmax = (role.get("centroid_hz_max") or 1e9) * (RELAX_CENTROID if relaxed else 1.0)
    if m["centroid_hz"] > cmax:
        return False
    crest_max = (role.get("crest_db_max") or 1e9) + (RELAX_CREST_DB if relaxed else 0.0)
    if m["crest_db"] > crest_max:
        return False
    # Shape gates never relax.
    if "sync_frac" in role:
        f_lo, f_hi = role["sync_frac"]
        if not f_lo <= m["sync_frac"] <= f_hi:
            return False
    if m["centroid_hz"] < role.get("centroid_hz_min", 0):
        return False
    if m["tail_ms"] < role.get("tail_ms_min", 0):
        return False
    return True


def eligible(role, c, whole_library=False, banned=()):
    """Does this sound's name and folder qualify it for the role?

    Apple files must sit in one of the role's folders and match a name hint, unless the
    role may take any file in its folders (plain "Whoosh 07" names). Files from other
    libraries (packs, Epidemic) have no Apple folders, so they need a name hint.
    The whole-library fallback needs a hint and skips the banned folders.
    """
    if text_hits(role.get("exclude_hints", []), c.hay):
        return False
    hint = bool(text_hits(role.get("name_hints", []), c.hay))
    if whole_library:
        top = c.rel.split(os.sep)[0].lower()
        return hint and not any(b.lower() == top for b in banned)
    if c.source != "a":
        return hint
    in_folder = bool(text_hits(role.get("apple_categories", []), c.hay))
    return in_folder and (hint or role.get("folder_only_ok", False))


class Claims:
    """Tracks what has been taken: one role per sound, a few slices per file, no near-twins."""

    def __init__(self):
        self.used = set()
        self.per_file = collections.defaultdict(list)
        self.families = collections.defaultdict(list)

    def ok(self, c):
        if c.cid in self.used:
            return False
        taken = self.per_file[c.path]
        if len(taken) >= MAX_KEYS_PER_FILE:
            return False
        if any(abs(c.entry["sync_s"] - s) < MIN_SLICE_GAP_S for s in taken):
            return False
        for other in self.families[family_of(c.path)]:
            if other.path == c.path:
                continue
            m, o = c.entry, other.entry
            if (abs(m["dur_s"] - o["dur_s"]) <= FAMILY_TOLERANCE * max(o["dur_s"], 1e-6) and
                    abs(m["centroid_hz"] - o["centroid_hz"]) <= FAMILY_TOLERANCE * max(o["centroid_hz"], 1e-6)):
                return False
        return True

    def take(self, c):
        self.used.add(c.cid)
        self.per_file[c.path].append(c.entry["sync_s"])
        self.families[family_of(c.path)].append(c)


def assign(spec, measured):
    """Roles claim sounds in spec order. Returns role -> [(Candidate, relaxed)] and notes."""
    items = candidates(measured)
    banned = spec.get("fallback_banned_folders", DEFAULT_BANNED_FOLDERS)
    claims = Claims()
    picks = {}
    notes = collections.defaultdict(list)
    rank = lambda c: (c.entry["crest_db"], c.entry["centroid_hz"], c.cid)  # noqa: E731

    for role in spec["roles"]:
        name, target = role["role"], role["target_count"]
        got = []

        def fill(pool, relaxed):
            for c in sorted(pool, key=rank):
                if len(got) >= target:
                    return
                if claims.ok(c) and passes_gates(role, c.entry, relaxed):
                    claims.take(c)
                    got.append((c, relaxed))

        home = [c for c in items if eligible(role, c)]
        fill(home, False)
        if len(got) < target / 2:
            wide = [c for c in items if eligible(role, c, whole_library=True, banned=banned)]
            fill(wide, False)
            notes[name].append("searched the whole library")
        if len(got) < target:
            before = len(got)
            fill(home, True)
            if len(got) > before:
                notes[name].append(f"{len(got) - before} relaxed (reels only)")
        picks[name] = got
    return picks, notes


def placed_gain(role, m, tv=False):
    """Clip gain for the spec's placed level, never above the -10 dBFS ceiling."""
    if role == "room_bed":
        g = BED_RMS["tv" if tv else "reels"] - m["rms_db"]
    else:
        transient = m["attack_ms"] < TRANSIENT_ATTACK_MS
        if tv:
            target = TV_TRANSIENT_PEAK if transient else TV_PEAK.get(role, TV_DEFAULT_PEAK)
        else:
            target = REELS_TRANSIENT_PEAK if transient else REELS_PEAK.get(role, REELS_DEFAULT_PEAK)
        g = target - m["peak_db"]
    return round(min(g, PEAK_CEIL_DB - m["peak_db"]), 2)


def gain_for(m, role="", tv=False):
    return placed_gain(role, m, tv)


def write_preview(ffmpeg, picked, out_wav, gap_s=0.5, max_s=3.0, sr=44100):
    chunks = []
    silence = np.zeros(int(sr * gap_s), dtype=np.float32)
    decoded = {}
    for c, _relaxed, role in picked:
        e = c.entry
        if c.path not in decoded:
            decoded[c.path] = decode(ffmpeg, c.path, sr=sr)
        x = decoded[c.path][int(e["start_s"] * sr):int(e["end_s"] * sr)]
        lead = max(0.0, e["sync_s"] - e["start_s"] - 1.0)
        x = x[int(lead * sr):int((lead + max_s) * sr)]
        fade = min(len(x), int(0.05 * sr))
        if fade:
            x = x.copy()
            x[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
        chunks += [(x * (10 ** (placed_gain(role, e) / 20.0))).astype(np.float32), silence]
    if not chunks:
        return
    y = np.clip(np.concatenate(chunks), -1.0, 1.0)
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((y * 32767).astype("<i2").tobytes())


def write_outputs(spec, picks, notes, libraries, out):
    keys, role_keys, ordered = {}, {}, {}
    tv_excludes = [x.lower() for x in spec.get("tv_exclude_names", DEFAULT_TV_EXCLUDES)]
    for role in spec["roles"]:
        name = role["role"]
        role_keys[name] = []
        ordered[name] = []
        count = collections.Counter()
        for c, relaxed in sorted(picks[name], key=lambda z: (z[0].source, z[0].cid)):
            count[c.source] += 1
            k = f"{name}_{c.source}{count[c.source]:02d}"
            e = c.entry
            room_event = [x for x in tv_excludes if x in c.hay]
            keys[k] = {
                "path": os.path.abspath(c.path),
                "library": c.library,
                "rel": c.rel,
                "source": {"a": "apple", "e": "epidemic", "p": "pack"}[c.source],
                "role": name,
                "relaxed": relaxed,
                "calm_ok_for_tv": bool(role.get("calm_ok_for_tv")) and not relaxed and not room_event,
                "split_from_multi_hit_file": e["multi"],
                "start_s": e["start_s"],
                "end_s": e["end_s"],
                "sync_s": e["sync_s"],
                "sync_frac": e["sync_frac"],
                "dur_s": e["dur_s"],
                "attack_ms": e["attack_ms"],
                "tail_ms": e["tail_ms"],
                "peak_db": e["peak_db"],
                "rms_db": e["rms_db"],
                "crest_db": e["crest_db"],
                "centroid_hz": e["centroid_hz"],
                "gain_db": placed_gain(name, e),
                "gain_db_tv": placed_gain(name, e, tv=True),
            }
            role_keys[name].append(k)
            ordered[name].append((c, relaxed, name))

    palette = {
        "version": 3,
        "libraries": [os.path.abspath(x) for x in libraries],
        "peak_ceiling_db": PEAK_CEIL_DB,
        "roles": role_keys,
        "keys": keys,
        "tv_exclude_names": tv_excludes,
        "placement_rules": spec.get("placement_rules", []),
        "device_map": spec.get("device_map", []),
    }
    with open(os.path.join(out, "palette.json"), "w") as fh:
        json.dump(palette, fh, indent=1)

    lines = ["# SleepMD SFX palette report", "", "Libraries:", ""]
    lines += [f"- `{os.path.abspath(x)}`" for x in libraries]
    lines += ["", f"Total keys: **{len(keys)}** "
              f"(TV-safe: {sum(v['calm_ok_for_tv'] for v in keys.values())})", "",
              "| Role | Keys | Target | TV role | Note |", "|---|---:|---:|:---:|---|"]
    short = []
    for role in spec["roles"]:
        name = role["role"]
        got = len(role_keys[name])
        note = list(notes.get(name, []))
        if got < role["target_count"]:
            note.append(f"short by {role['target_count'] - got}")
            short.append(role)
        lines.append(f"| `{name}` | {got} | {role['target_count']} | "
                     f"{'yes' if role.get('calm_ok_for_tv') else 'no'} | {', '.join(note)} |")
    if short:
        lines += ["", "## Fill the gaps from Epidemic Sound", ""]
        for role in short:
            terms = ", ".join(f"\"{t}\"" for t in role.get("epidemic_search", []))
            lines.append(f"- `{role['role']}`: {terms}")
    lines += ["", "## Placement rules", ""] + [f"- {x}" for x in spec.get("placement_rules", [])]
    with open(os.path.join(out, "palette_report.md"), "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return palette, ordered


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--library", action="append",
                    help="a folder of real SFX; repeat for more (default: Apple FCP library)")
    ap.add_argument("--spec", default=os.path.join(here, "palette_spec.json"))
    ap.add_argument("--out", default=os.path.join(here, "out"))
    ap.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    ap.add_argument("--jobs", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    ap.add_argument("--no-split", action="store_true", help="treat multi-hit files as one sound")
    ap.add_argument("--previews", action="store_true", help="write one audition WAV per role")
    a = ap.parse_args(argv)

    libraries = a.library or [DEFAULT_LIBRARY]
    for lib in libraries:
        if not os.path.isdir(lib):
            sys.exit(f"library not found: {lib}")
    with open(a.spec) as fh:
        spec = json.load(fh)
    os.makedirs(a.out, exist_ok=True)

    measured = measure_library(a.ffmpeg, libraries, os.path.join(a.out, "measure_cache.json"),
                               a.jobs, split=not a.no_split)
    picks, notes = assign(spec, measured)
    palette, ordered = write_outputs(spec, picks, notes, libraries, a.out)

    if a.previews:
        pdir = os.path.join(a.out, "previews")
        os.makedirs(pdir, exist_ok=True)
        for role, picked in ordered.items():
            write_preview(a.ffmpeg, picked, os.path.join(pdir, f"{role}.wav"))

    print(f"{len(palette['keys'])} keys across {len(palette['roles'])} roles -> {a.out}")
    return palette


if __name__ == "__main__":
    main()
