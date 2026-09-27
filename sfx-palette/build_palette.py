#!/usr/bin/env python3
"""Build the SleepMD SFX palette from REAL recorded sound libraries.

This script never creates sound. It measures every file in one or more existing
libraries (by default Apple's Final Cut Pro Sound Effects, installed on the Mac)
and sorts the sounds into the palette roles defined in palette_spec.json, using
acoustic criteria (duration, attack, spectral centroid, crest factor) plus
filename and folder hints. Files that hold a row of separate hits (a pack's
"Clicks.wav" with 20 clicks in it) are split into one entry per hit.

The result is a much larger set of distinct keys, so every scene in a reel can
get its own sound instead of repeating the same whoosh.

Outputs (in --out):
  palette.json        role -> keys, key -> path, in/out points, sync point, levels, gain
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
import concurrent.futures
import json
import math
import os
import shutil
import subprocess
import sys
import wave

import numpy as np

DEFAULT_LIBRARY = "/Library/Audio/Apple Loops/Apple/Final Cut Pro Sound Effects"
AUDIO_EXTS = {".caf", ".wav", ".aif", ".aiff", ".mp3", ".m4a", ".flac", ".ogg"}
SR = 22050             # analysis sample rate
WIN = int(SR * 0.010)  # 10 ms envelope window
HOP = int(SR * 0.005)  # 5 ms hop
SILENT_DB = -80.0
PEAK_TARGET_DB = -12.0  # suggested placed peak
PEAK_CEIL_DB = -10.0    # placed SFX must never peak above this
RELAX = 1.25            # threshold relaxation for roles that fall short

# Splitting multi-hit files: a gap of at least SPLIT_GAP_S that sits SPLIT_DB below
# the file's loudest moment separates two hits.
SPLIT_MIN_FILE_S = 1.0
SPLIT_DB = 40.0
SPLIT_GAP_S = 0.15
SPLIT_MIN_HIT_S = 0.03
SPLIT_PRE_S = 0.02
SPLIT_POST_S = 0.08
SPLIT_MAX_HITS = 64


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


def metrics(x, offset_s=0.0):
    """Acoustic fingerprint of one sound. The envelope peak is the sync point."""
    n = len(x)
    if n < WIN:
        return None
    peak_db = db(np.max(np.abs(x)))
    if peak_db < SILENT_DB:
        return None
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

    return {
        "start_s": round(offset_s, 3),
        "end_s": round(offset_s + n / SR, 3),
        "dur_s": round(n / SR, 3),
        "sync_s": round(offset_s + sync_s, 3),
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
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        elif not a and start is not None:
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
            stamp = f"{st.st_size}:{int(st.st_mtime)}:{int(split)}"
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


def candidates(measured):
    """Flatten records into (cid, path, library, rel, entry). cid is unique per sound."""
    out = []
    for p, rec in measured.items():
        if "error" in rec:
            continue
        lib = rec["library"]
        rel = os.path.relpath(p, lib)
        for e in rec["entries"]:
            cid = f"{p}@{e['start_s']:.3f}" if e["multi"] else p
            out.append((cid, p, lib, rel, e))
    return out


def text_hits(needles, haystack):
    return [h for h in needles if h and h.lower() in haystack]


def score_file(role, hay, m, relax=1.0):
    """Return a score if the sound fits the role, else None. Higher is better.

    hay is the lowercased "<library folder>/<path inside the library>".
    """
    if text_hits(role.get("exclude_hints", []), hay):
        return None
    lo, hi = (role.get("duration_s") or [0, 1e9])[:2]
    if not (lo / relax <= m["dur_s"] <= hi * relax):
        return None
    attack_min = role.get("attack_ms_min") or 0
    if m["attack_ms"] < attack_min / relax:
        return None
    cmax = role.get("centroid_hz_max") or 1e9
    if m["centroid_hz"] > cmax * relax:
        return None
    crest_max = role.get("crest_db_max") or 1e9
    if m["crest_db"] > crest_max * relax:
        return None

    hint = bool(text_hits(role.get("name_hints", []), hay))
    cats = role.get("apple_categories", [])
    cat = bool(text_hits(cats, hay)) if cats else False
    if not (hint or cat):
        return None
    # Prefer a filename hint, then the right folder, then softer / warmer sounds.
    s = 2.0 * hint + 1.0 * cat
    s += 0.5 * (1.0 - min(m["centroid_hz"] / cmax, 1.0)) if cmax < 1e9 else 0.0
    s += 0.5 * (1.0 - min(m["crest_db"] / crest_max, 1.0)) if crest_max < 1e9 else 0.0
    return s


def assign(spec, measured):
    """Give each sound to the one role it fits best, up to each role's target."""
    roles = spec["roles"]
    items = candidates(measured)
    used = set()
    picks = {r["role"]: [] for r in roles}
    relaxed = set()
    target = {r["role"]: r["target_count"] for r in roles}

    for relax in (1.0, RELAX):
        pairs = []
        for r in roles:
            if len(picks[r["role"]]) >= target[r["role"]]:
                continue
            for item in items:
                cid, _p, lib, rel, e = item
                if cid in used:
                    continue
                hay = f"{os.path.basename(lib)}/{rel}".lower()
                s = score_file(r, hay, e, relax)
                if s is not None:
                    pairs.append((s, cid, r["role"], item))
        pairs.sort(key=lambda z: (-z[0], z[1]))
        for s, cid, role, item in pairs:
            if cid in used or len(picks[role]) >= target[role]:
                continue
            picks[role].append(item)
            used.add(cid)
            if relax > 1.0:
                relaxed.add(role)
    return picks, relaxed


def gain_for(m):
    """Gain that puts the sound's peak at PEAK_TARGET_DB (never above the ceiling)."""
    g = PEAK_TARGET_DB - m["peak_db"]
    return round(min(g, PEAK_CEIL_DB - m["peak_db"]), 2)


def write_preview(ffmpeg, items, out_wav, gap_s=0.5, max_s=3.0, sr=44100):
    chunks = []
    silence = np.zeros(int(sr * gap_s), dtype=np.float32)
    decoded = {}
    for _cid, p, _lib, _rel, e in items:
        if p not in decoded:
            decoded[p] = decode(ffmpeg, p, sr=sr)
        x = decoded[p][int(e["start_s"] * sr):int(e["end_s"] * sr)]
        lead = max(0.0, e["sync_s"] - e["start_s"] - 1.0)
        x = x[int(lead * sr):int((lead + max_s) * sr)]
        fade = min(len(x), int(0.05 * sr))
        if fade:
            x = x.copy()
            x[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
        chunks += [(x * (10 ** (gain_for(e) / 20.0))).astype(np.float32), silence]
    if not chunks:
        return
    y = np.clip(np.concatenate(chunks), -1.0, 1.0)
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((y * 32767).astype("<i2").tobytes())


def write_outputs(spec, picks, relaxed, libraries, out):
    keys, role_keys = {}, {}
    for r in spec["roles"]:
        role = r["role"]
        role_keys[role] = []
        for i, (cid, p, lib, rel, e) in enumerate(sorted(picks[role], key=lambda z: z[0]), 1):
            k = f"sm_{role}_{i:02d}"
            keys[k] = {
                "path": os.path.abspath(p),
                "library": lib,
                "rel": rel,
                "role": role,
                "calm_ok_for_tv": bool(r.get("calm_ok_for_tv")),
                "split_from_multi_hit_file": e["multi"],
                "start_s": e["start_s"],
                "end_s": e["end_s"],
                "sync_s": e["sync_s"],
                "dur_s": e["dur_s"],
                "attack_ms": e["attack_ms"],
                "tail_ms": e["tail_ms"],
                "peak_db": e["peak_db"],
                "rms_db": e["rms_db"],
                "crest_db": e["crest_db"],
                "centroid_hz": e["centroid_hz"],
                "gain_db": gain_for(e),
            }
            role_keys[role].append(k)

    palette = {
        "version": 2,
        "libraries": [os.path.abspath(x) for x in libraries],
        "peak_target_db": PEAK_TARGET_DB,
        "peak_ceiling_db": PEAK_CEIL_DB,
        "roles": role_keys,
        "keys": keys,
        "placement_rules": spec.get("placement_rules", []),
        "device_map": spec.get("device_map", []),
    }
    with open(os.path.join(out, "palette.json"), "w") as fh:
        json.dump(palette, fh, indent=1)

    lines = ["# SleepMD SFX palette report", "", "Libraries:", ""]
    lines += [f"- `{os.path.abspath(x)}`" for x in libraries]
    lines += ["", f"Total keys: **{len(keys)}**", "",
              "| Role | Keys | Target | TV-safe | Note |", "|---|---:|---:|:---:|---|"]
    short = []
    for r in spec["roles"]:
        role = r["role"]
        got = len(role_keys[role])
        note = []
        if role in relaxed:
            note.append(f"thresholds relaxed x{RELAX}")
        if got < r["target_count"]:
            note.append(f"short by {r['target_count'] - got}")
            short.append(r)
        lines.append(f"| `{role}` | {got} | {r['target_count']} | "
                     f"{'yes' if r.get('calm_ok_for_tv') else 'no'} | {', '.join(note)} |")
    if short:
        lines += ["", "## Fill the gaps from Epidemic Sound", ""]
        for r in short:
            terms = ", ".join(f"\"{t}\"" for t in r.get("epidemic_search", []))
            lines.append(f"- `{r['role']}` ({r.get('use_for', '')}): {terms}")
    lines += ["", "## Placement rules", ""] + [f"- {x}" for x in spec.get("placement_rules", [])]
    with open(os.path.join(out, "palette_report.md"), "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return palette


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
    picks, relaxed = assign(spec, measured)
    palette = write_outputs(spec, picks, relaxed, libraries, a.out)

    if a.previews:
        pdir = os.path.join(a.out, "previews")
        os.makedirs(pdir, exist_ok=True)
        for role, items in picks.items():
            write_preview(a.ffmpeg, sorted(items, key=lambda z: z[0]), os.path.join(pdir, f"{role}.wav"))

    print(f"{len(palette['keys'])} keys across {len(palette['roles'])} roles -> {a.out}")
    return palette


if __name__ == "__main__":
    main()
