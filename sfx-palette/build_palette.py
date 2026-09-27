#!/usr/bin/env python3
"""Build the SleepMD SFX palette from a REAL recorded sound library.

This script never creates sound. It measures every file in an existing library
(by default Apple's Final Cut Pro Sound Effects, installed on the Mac) and sorts
the files into the palette roles defined in palette_spec.json, using acoustic
criteria (duration, attack, spectral centroid, crest factor) plus filename and
folder hints. The result is a much larger set of distinct keys, so every scene
in a reel can get its own sound instead of repeating the same whoosh.

Outputs (in --out):
  palette.json        role -> keys, key -> path, sync point, levels, gain
  palette_report.md   counts per role vs target, shortfalls, Epidemic search terms
  measure_cache.json  per-file measurements (reused on the next run)
  previews/<role>.wav one audition file per role (only with --previews)

Usage:
  python3 build_palette.py
  python3 build_palette.py --library "/Library/Audio/Apple Loops/Apple/Final Cut Pro Sound Effects" \
      --spec palette_spec.json --out out --previews

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
SR = 22050            # analysis sample rate
WIN = int(SR * 0.010)  # 10 ms envelope window
HOP = int(SR * 0.005)  # 5 ms hop
SILENT_DB = -80.0
PEAK_TARGET_DB = -12.0  # suggested placed peak
PEAK_CEIL_DB = -10.0    # placed SFX must never peak above this
RELAX = 1.25            # threshold relaxation for roles that fall short


def db(x):
    return 20.0 * math.log10(max(float(x), 1e-12))


def ffmpeg_input(path):
    # Always hand ffmpeg an absolute "file:" URL. A relative path that starts with
    # a folder like "Work:Home" is otherwise read as a protocol name.
    return "file:" + os.path.abspath(path)


def decode(ffmpeg, path, sr=SR, channels=1):
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-i", ffmpeg_input(path),
           "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-"]
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
    x = np.frombuffer(out, dtype=np.float32)
    if channels > 1:
        x = x.reshape(-1, channels)
    return x


def measure(ffmpeg, path):
    """Acoustic fingerprint of one file. The envelope peak is the sync point."""
    x = decode(ffmpeg, path)
    n = len(x)
    if n < WIN:
        return None
    dur = n / SR
    peak_db = db(np.max(np.abs(x)))
    if peak_db < SILENT_DB:
        return None

    frames = 1 + (n - WIN) // HOP
    idx = np.arange(WIN)[None, :] + HOP * np.arange(frames)[:, None]
    env = np.sqrt(np.mean(x[idx] ** 2, axis=1) + 1e-20)
    env_db = 20.0 * np.log10(env)
    ip = int(np.argmax(env_db))
    env_peak = float(env_db[ip])
    t = (np.arange(frames) * HOP + WIN / 2) / SR
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
    crest_db = peak_db - rms_db

    # Energy-weighted spectral centroid over the active part of the file.
    fft_n, fft_hop = 1024, 512
    if n >= fft_n:
        nf = 1 + (n - fft_n) // fft_hop
        fidx = np.arange(fft_n)[None, :] + fft_hop * np.arange(nf)[:, None]
        spec = np.abs(np.fft.rfft(x[fidx] * np.hanning(fft_n)[None, :], axis=1))
        freqs = np.fft.rfftfreq(fft_n, 1.0 / SR)
        mag_sum = spec.sum(axis=1) + 1e-12
        cent = (spec * freqs[None, :]).sum(axis=1) / mag_sum
        energy = (spec ** 2).sum(axis=1)
        centroid_hz = float((cent * energy).sum() / (energy.sum() + 1e-12))
    else:
        centroid_hz = 0.0

    return {
        "dur_s": round(dur, 3),
        "sync_s": round(sync_s, 3),
        "attack_ms": round(attack_ms, 1),
        "tail_ms": round(tail_ms, 1),
        "peak_db": round(peak_db, 2),
        "rms_db": round(rms_db, 2),
        "crest_db": round(crest_db, 2),
        "centroid_hz": round(centroid_hz, 1),
    }


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


def measure_library(ffmpeg, library, cache_path, jobs):
    cache = load_cache(cache_path)
    files = list(find_audio(library))
    todo = []
    results = {}
    for p in files:
        st = os.stat(p)
        stamp = f"{st.st_size}:{int(st.st_mtime)}"
        hit = cache.get(p)
        if hit and hit.get("stamp") == stamp:
            results[p] = hit
        else:
            todo.append((p, stamp))

    def work(item):
        p, stamp = item
        try:
            m = measure(ffmpeg, p)
        except subprocess.CalledProcessError as e:
            return p, {"stamp": stamp, "error": e.stderr.decode(errors="replace")[:300]}
        if m is None:
            return p, {"stamp": stamp, "error": "silent or too short"}
        m["stamp"] = stamp
        return p, m

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as ex:
        for i, (p, m) in enumerate(ex.map(work, todo), 1):
            results[p] = m
            if i % 100 == 0:
                print(f"  measured {i}/{len(todo)}", file=sys.stderr)

    with open(cache_path, "w") as fh:
        json.dump(results, fh, indent=1, sort_keys=True)
    print(f"{len(files)} files ({len(todo)} newly measured)", file=sys.stderr)
    return results


def text_hits(needles, haystack):
    return [h for h in needles if h and h.lower() in haystack]


def score_file(role, rel, m, relax=1.0):
    """Return a score if the file fits the role, else None. Higher is better."""
    hay = rel.lower()
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
    # Prefer a filename hint, then the right folder, then softer / warmer files.
    s = 2.0 * hint + 1.0 * cat
    s += 0.5 * (1.0 - min(m["centroid_hz"] / cmax, 1.0)) if cmax < 1e9 else 0.0
    s += 0.5 * (1.0 - min(m["crest_db"] / crest_max, 1.0)) if crest_max < 1e9 else 0.0
    return s


def assign(spec, measured, library):
    roles = spec["roles"]
    items = [(p, m) for p, m in measured.items() if "error" not in m]
    used = set()
    picks = {r["role"]: [] for r in roles}
    relaxed = set()

    for relax in (1.0, RELAX):
        pairs = []
        for r in roles:
            if len(picks[r["role"]]) >= r["target_count"]:
                continue
            for p, m in items:
                if p in used:
                    continue
                s = score_file(r, os.path.relpath(p, library), m, relax)
                if s is not None:
                    pairs.append((s, p, r["role"]))
        pairs.sort(key=lambda t: (-t[0], t[1]))
        target = {r["role"]: r["target_count"] for r in roles}
        for s, p, role in pairs:
            if p in used or len(picks[role]) >= target[role]:
                continue
            picks[role].append(p)
            used.add(p)
            if relax > 1.0:
                relaxed.add(role)
    return picks, relaxed


def gain_for(m):
    """Gain that puts the file's peak at PEAK_TARGET_DB (never above the ceiling)."""
    g = PEAK_TARGET_DB - m["peak_db"]
    return round(min(g, PEAK_CEIL_DB - m["peak_db"]), 2)


def write_preview(ffmpeg, paths, measured, out_wav, gap_s=0.5, max_s=3.0, sr=44100):
    chunks = []
    silence = np.zeros(int(sr * gap_s), dtype=np.float32)
    for p in paths:
        x = decode(ffmpeg, p, sr=sr)
        m = measured[p]
        start = max(0, int((m["sync_s"] - 1.0) * sr))
        x = x[start:start + int(max_s * sr)]
        fade = min(len(x), int(0.05 * sr))
        if fade:
            x = x.copy()
            x[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
        x = x * (10 ** (gain_for(m) / 20.0))
        chunks += [x.astype(np.float32), silence]
    if not chunks:
        return
    y = np.clip(np.concatenate(chunks), -1.0, 1.0)
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((y * 32767).astype("<i2").tobytes())


def write_outputs(spec, picks, relaxed, measured, library, out):
    keys = {}
    role_keys = {}
    for r in spec["roles"]:
        role = r["role"]
        role_keys[role] = []
        for i, p in enumerate(sorted(picks[role]), 1):
            k = f"sm_{role}_{i:02d}"
            m = measured[p]
            keys[k] = {
                "path": os.path.abspath(p),
                "rel": os.path.relpath(p, library),
                "role": role,
                "calm_ok_for_tv": bool(r.get("calm_ok_for_tv")),
                "sync_s": m["sync_s"],
                "dur_s": m["dur_s"],
                "attack_ms": m["attack_ms"],
                "tail_ms": m["tail_ms"],
                "peak_db": m["peak_db"],
                "rms_db": m["rms_db"],
                "crest_db": m["crest_db"],
                "centroid_hz": m["centroid_hz"],
                "gain_db": gain_for(m),
            }
            role_keys[role].append(k)

    palette = {
        "version": 1,
        "library": os.path.abspath(library),
        "peak_target_db": PEAK_TARGET_DB,
        "peak_ceiling_db": PEAK_CEIL_DB,
        "roles": role_keys,
        "keys": keys,
        "placement_rules": spec.get("placement_rules", []),
        "device_map": spec.get("device_map", []),
    }
    with open(os.path.join(out, "palette.json"), "w") as fh:
        json.dump(palette, fh, indent=1)

    lines = ["# SleepMD SFX palette report", "",
             f"Library: `{os.path.abspath(library)}`", "",
             f"Total keys: **{len(keys)}**", "",
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
    ap.add_argument("--library", default=DEFAULT_LIBRARY)
    ap.add_argument("--spec", default=os.path.join(here, "palette_spec.json"))
    ap.add_argument("--out", default=os.path.join(here, "out"))
    ap.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    ap.add_argument("--jobs", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    ap.add_argument("--previews", action="store_true", help="write one audition WAV per role")
    a = ap.parse_args(argv)

    if not os.path.isdir(a.library):
        sys.exit(f"library not found: {a.library}")
    with open(a.spec) as fh:
        spec = json.load(fh)
    os.makedirs(a.out, exist_ok=True)

    measured = measure_library(a.ffmpeg, a.library, os.path.join(a.out, "measure_cache.json"), a.jobs)
    picks, relaxed = assign(spec, measured, a.library)
    palette = write_outputs(spec, picks, relaxed, measured, a.library, a.out)

    if a.previews:
        pdir = os.path.join(a.out, "previews")
        os.makedirs(pdir, exist_ok=True)
        for role, paths in picks.items():
            write_preview(a.ffmpeg, sorted(paths), measured, os.path.join(pdir, f"{role}.wav"))

    print(f"{len(palette['keys'])} keys across {len(palette['roles'])} roles -> {a.out}")
    return palette


if __name__ == "__main__":
    main()
