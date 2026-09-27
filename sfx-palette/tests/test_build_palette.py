"""Tests for build_palette.py and palette.py.

The fixture libraries are made of throwaway test tones written to a temp folder
and deleted afterwards. They only exercise the measuring and sorting logic; they
are never part of the palette.

Run:  python3 -m unittest discover -s sfx-palette/tests -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import build_palette as bp  # noqa: E402
from palette import Palette  # noqa: E402


def find_ffmpeg():
    exe = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


FFMPEG = find_ffmpeg()

# Library 1 mimics the Apple layout, including a "Work:Home" folder.
APPLE = {
    "Motions & Transitions/Whoosh Soft 01.caf":
        "anoisesrc=d=2.0:c=pink:a=0.5:r=44100,lowpass=f=1500,afade=t=in:d=1.2,afade=t=out:st=1.4:d=0.6",
    "Motions & Transitions/Whoosh Hard 02.caf":
        "anoisesrc=d=0.6:c=white:a=0.9:r=44100,highpass=f=2500,afade=t=in:d=0.005,afade=t=out:st=0.08:d=0.5",
    "Work:Home/Pencil Click.caf":
        "sine=f=3000:d=0.06:r=44100,afade=t=out:st=0.01:d=0.05",
    "Work:Home/Mouse Click 2.caf":
        "sine=f=2500:d=0.05:r=44100,afade=t=out:st=0.01:d=0.04",
    "Ambience/Room Tone Low.caf":
        "sine=f=180:d=1.5:r=44100,volume=0.3",
    "Ambience/Silence.caf":
        "anullsrc=r=44100:cl=mono:d=1.0",
}
# Library 2 is a downloaded pack with one multi-hit file: 4 beeps, 0.1 s each, 0.6 s apart.
PACK = {
    "Clicks Row.wav":
        "sine=f=2000:d=2.2:r=44100,volume='if(lt(mod(t,0.6),0.1),1,0)':eval=frame",
}

SPEC = {
    "roles": [
        {"role": "glide_soft", "use_for": "object racks in", "calm_ok_for_tv": True,
         "apple_categories": ["Motions & Transitions"], "name_hints": ["whoosh"],
         "exclude_hints": ["hard"], "duration_s": [0.8, 4.0], "attack_ms_min": 150,
         "centroid_hz_max": 4000, "crest_db_max": 20, "target_count": 5,
         "epidemic_search": ["soft whoosh"]},
        {"role": "tick_soft", "use_for": "checkmark", "calm_ok_for_tv": True,
         "apple_categories": ["Work:Home"], "name_hints": ["click"],
         "exclude_hints": [], "duration_s": [0.01, 0.5], "attack_ms_min": 0,
         "centroid_hz_max": 8000, "crest_db_max": 30, "target_count": 10,
         "epidemic_search": ["soft click"]},
        {"role": "bed_low", "use_for": "room tone", "calm_ok_for_tv": False,
         "apple_categories": ["Ambience"], "name_hints": ["room tone"],
         "exclude_hints": [], "duration_s": [0.5, 60], "attack_ms_min": 0,
         "centroid_hz_max": 1000, "crest_db_max": 20, "target_count": 3,
         "epidemic_search": ["room tone"]},
    ],
    "placement_rules": ["never repeat a key inside one video"],
    "device_map": [{"device": "checkmark", "roles": ["tick_soft", "glide_soft"]}],
}


def make_library(root, files):
    for rel, graph in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", graph,
                        "-ac", "1", "-c:a", "pcm_s16le", bp.ffmpeg_input(path)], check=True)


@unittest.skipUnless(FFMPEG, "ffmpeg not available")
class BuildPaletteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="sfx-fixtures-")
        cls.apple = os.path.join(cls.tmp, "Final Cut Pro Sound Effects")
        cls.pack = os.path.join(cls.tmp, "Jordan SFX")
        make_library(cls.apple, APPLE)
        make_library(cls.pack, PACK)
        cls.spec_path = os.path.join(cls.tmp, "spec.json")
        with open(cls.spec_path, "w") as fh:
            json.dump(SPEC, fh)
        cls.out = os.path.join(cls.tmp, "out")
        cls.palette = bp.main(["--library", cls.apple, "--library", cls.pack,
                               "--spec", cls.spec_path, "--out", cls.out,
                               "--ffmpeg", FFMPEG, "--jobs", "2", "--previews"])
        with open(os.path.join(cls.out, "measure_cache.json")) as fh:
            cls.cache = json.load(fh)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def rec(self, lib, rel):
        return self.cache[os.path.join(lib, rel)]

    def m(self, rel):
        return self.rec(self.apple, rel)["entries"][0]

    def rels(self, role):
        return [self.palette["keys"][k]["rel"] for k in self.palette["roles"][role]]

    def test_soft_swell_has_slow_attack_and_hard_whoosh_is_fast(self):
        soft = self.m("Motions & Transitions/Whoosh Soft 01.caf")
        hard = self.m("Motions & Transitions/Whoosh Hard 02.caf")
        self.assertGreater(soft["attack_ms"], 300)
        self.assertLess(hard["attack_ms"], 50)
        self.assertLess(soft["centroid_hz"], hard["centroid_hz"])

    def test_single_sounds_are_not_split(self):
        rec = self.rec(self.apple, "Motions & Transitions/Whoosh Soft 01.caf")
        self.assertEqual(len(rec["entries"]), 1)
        self.assertFalse(rec["entries"][0]["multi"])

    def test_centroid_tracks_pitch(self):
        self.assertAlmostEqual(self.m("Ambience/Room Tone Low.caf")["centroid_hz"], 180, delta=40)

    def test_colon_folder_is_decoded(self):
        click = self.m("Work:Home/Pencil Click.caf")
        self.assertLess(click["dur_s"], 0.1)

    def test_silent_file_is_skipped(self):
        self.assertIn("error", self.rec(self.apple, "Ambience/Silence.caf"))

    def test_multi_hit_file_is_split_into_hits(self):
        entries = self.rec(self.pack, "Clicks Row.wav")["entries"]
        self.assertEqual(len(entries), 4)
        for i, e in enumerate(entries):
            self.assertTrue(e["multi"])
            # a flat beep has no single loudest moment: sync lands somewhere inside it
            self.assertGreaterEqual(e["sync_s"], 0.6 * i)
            self.assertLessEqual(e["sync_s"], 0.6 * i + 0.1 + 0.01)
            self.assertLess(e["start_s"], e["sync_s"])
            self.assertLess(e["sync_s"], e["end_s"])
            self.assertLess(e["dur_s"], 0.3)

    def test_roles_get_the_right_files(self):
        self.assertEqual(self.rels("glide_soft"), ["Motions & Transitions/Whoosh Soft 01.caf"])
        ticks = self.rels("tick_soft")
        self.assertEqual(len(ticks), 6)                      # 2 Apple clicks + 4 split hits
        self.assertEqual(ticks.count("Clicks Row.wav"), 4)
        self.assertEqual(sum(r.startswith("Work:Home/") for r in ticks), 2)
        self.assertEqual(self.rels("bed_low"), ["Ambience/Room Tone Low.caf"])

    def test_split_hits_keep_their_in_and_out_points(self):
        split = [v for v in self.palette["keys"].values() if v["split_from_multi_hit_file"]]
        self.assertEqual(len(split), 4)
        self.assertEqual(len({v["start_s"] for v in split}), 4)
        self.assertTrue(all(v["library"].endswith("Jordan SFX") for v in split))

    def test_no_sound_is_used_twice(self):
        ids = [(v["path"], v["start_s"]) for v in self.palette["keys"].values()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_gain_never_exceeds_ceiling(self):
        for k, v in self.palette["keys"].items():
            self.assertLessEqual(v["peak_db"] + v["gain_db"], bp.PEAK_CEIL_DB + 1e-6, k)

    def test_report_flags_shortfalls(self):
        with open(os.path.join(self.out, "palette_report.md")) as fh:
            report = fh.read()
        self.assertIn("short by 4", report)          # glide_soft wanted 5, got 1
        self.assertIn("\"soft whoosh\"", report)
        self.assertIn("Jordan SFX", report)

    def test_previews_written(self):
        for role in ("glide_soft", "tick_soft"):
            self.assertGreater(os.path.getsize(os.path.join(self.out, "previews", f"{role}.wav")), 1000)

    def test_picker_never_repeats_within_a_video(self):
        pal = Palette(os.path.join(self.out, "palette.json"))
        got = {pal.pick("tick_soft", video="N21") for _ in range(6)}
        self.assertEqual(len(got), 6)
        with self.assertRaises(LookupError):
            pal.pick("tick_soft", video="N21")
        # device map falls through to the next role once tick_soft is used up
        self.assertIn(pal.pick_for_device("checkmark", video="N21"), pal.roles["glide_soft"])
        # tv=True skips roles that are not calm enough for the clinic TV
        with self.assertRaises(KeyError):
            pal.pick("bed_low", video="TV", tv=True)

    def test_picks_are_deterministic_per_video(self):
        a, b = Palette(os.path.join(self.out, "palette.json")), Palette(os.path.join(self.out, "palette.json"))
        self.assertEqual([a.pick("tick_soft", "N30") for _ in range(3)],
                         [b.pick("tick_soft", "N30") for _ in range(3)])

    def test_cache_is_reused(self):
        cache = os.path.join(self.out, "measure_cache.json")
        measured = bp.measure_library(FFMPEG, [self.apple, self.pack], cache, 2)
        self.assertEqual(len(measured), len(APPLE) + len(PACK))


if __name__ == "__main__":
    unittest.main()
