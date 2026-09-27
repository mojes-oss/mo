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

SOFT_WHOOSH = "anoisesrc=d=2.0:c=pink:a=0.5:r=44100,lowpass=f=1500,afade=t=in:d=0.9,afade=t=out:st=1.1:d=0.9"  # peaks mid-way
CLICK = "sine=f=2500:d=0.05:r=44100,afade=t=out:st=0.01:d=0.04"

# Library 1 mimics the Apple layout (same folder name), including a "Work:Home" folder.
APPLE = {
    "Motions & Transitions/Whoosh Soft 01.caf": SOFT_WHOOSH,
    "Motions & Transitions/Whoosh Hard 02.caf":
        "anoisesrc=d=0.6:c=white:a=0.9:r=44100,highpass=f=2500,afade=t=in:d=0.005,afade=t=out:st=0.08:d=0.5",
    # peaks at its very end: a reverse swell, not a gentle transition
    "Motions & Transitions/Air Reverse Burst 1.caf":
        "anoisesrc=d=3.0:c=pink:a=0.6:r=44100,lowpass=f=2000,afade=t=in:curve=exp:d=2.95",
    # a plain-named file in the transitions folder, allowed by folder alone for glide roles
    "Motions & Transitions/Title Airy 3.caf":
        "anoisesrc=d=1.6:c=pink:a=0.4:r=44100,lowpass=f=1200,afade=t=in:d=0.8,afade=t=out:st=0.8:d=0.8",
    "Work:Home/Pencil Click.caf": "sine=f=3000:d=0.06:r=44100,afade=t=out:st=0.01:d=0.05",
    "Work:Home/Mouse Click 2.caf": CLICK,
    "Work:Home/Mouse Click 3.caf": CLICK,          # near-twin of Mouse Click 2
    "Work:Home/Phone Button Click.caf": "sine=f=2200:d=0.05:r=44100,afade=t=out:st=0.01:d=0.04",
    "Ambience/Room Tone Low.caf": "sine=f=180:d=1.5:r=44100,volume=0.3",
    "Ambience/Silence.caf": "anullsrc=r=44100:cl=mono:d=1.0",
    "Foley/Pill Bottle Shake.caf": "anoisesrc=d=0.8:c=white:a=0.4:r=44100,lowpass=f=5000,afade=t=in:d=0.02,afade=t=out:st=0.3:d=0.5",
    "Impacts/Pill Crunch.caf": "anoisesrc=d=0.5:c=white:a=0.4:r=44100,lowpass=f=5000,afade=t=out:st=0.1:d=0.4",
}
# Library 2 is a downloaded pack: one multi-hit file with 5 beeps, 1.1 s apart.
PACK = {
    "Clicks Row.wav": "sine=f=2000:d=5.4:r=44100,volume='if(lt(mod(t,1.1),0.1),1,0)':eval=frame",
}

SPEC = {
    "roles": [
        {"role": "rise_swell", "calm_ok_for_tv": True, "folder_only_ok": True,
         "apple_categories": ["Motions & Transitions"], "name_hints": ["reverse"],
         "exclude_hints": [], "duration_s": [0.8, 4.0], "attack_ms_min": 300,
         "centroid_hz_max": 5000, "crest_db_max": 30, "sync_frac": [0.7, 1.0], "target_count": 4,
         "epidemic_search": ["reverse swell"]},
        {"role": "glide_soft", "calm_ok_for_tv": True, "folder_only_ok": True,
         "apple_categories": ["Motions & Transitions"], "name_hints": ["whoosh"],
         "exclude_hints": ["hard"], "duration_s": [0.8, 4.0], "attack_ms_min": 150,
         "centroid_hz_max": 4000, "crest_db_max": 20, "sync_frac": [0.2, 0.8], "target_count": 5,
         "epidemic_search": ["soft whoosh"]},
        {"role": "pill_rattle", "calm_ok_for_tv": True,
         "apple_categories": ["Work:Home"], "name_hints": ["pill"],
         "exclude_hints": [], "duration_s": [0.2, 3.5], "attack_ms_min": 0,
         "centroid_hz_max": 8000, "crest_db_max": 30, "target_count": 2,
         "epidemic_search": ["pill bottle"]},
        {"role": "tick_soft", "calm_ok_for_tv": True,
         "apple_categories": ["Work:Home"], "name_hints": ["click"],
         "exclude_hints": [], "duration_s": [0.01, 0.5], "attack_ms_min": 0,
         "centroid_hz_max": 8000, "crest_db_max": 30, "target_count": 10,
         "epidemic_search": ["soft click"]},
        {"role": "room_bed", "calm_ok_for_tv": False,
         "apple_categories": ["Ambience"], "name_hints": ["room tone"],
         "exclude_hints": [], "duration_s": [0.5, 60], "attack_ms_min": 0,
         "centroid_hz_max": 1000, "crest_db_max": 20, "target_count": 3,
         "epidemic_search": ["room tone"]},
    ],
    "tv_exclude_names": ["phone", "doorbell"],
    "fallback_banned_folders": ["Impacts"],
    "placement_rules": ["never repeat a key inside one video"],
    "device_map": [{"device": "checkmark", "roles": ["tick_soft", "glide_soft"]}],
}


def make_library(root, files):
    for rel, graph in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", graph,
                        "-ac", "1", "-c:a", "pcm_s16le", bp.ffmpeg_input(path)], check=True)


class GateTest(unittest.TestCase):
    """Pure-logic checks that need no audio."""

    ROLE = {"duration_s": [0.5, 3.0], "attack_ms_min": 200, "centroid_hz_max": 3000,
            "crest_db_max": 18, "sync_frac": [0.2, 0.8]}
    OK = {"dur_s": 1.5, "attack_ms": 250, "centroid_hz": 2500, "crest_db": 16, "sync_frac": 0.5,
          "tail_ms": 500}

    def test_passes_when_inside_every_gate(self):
        self.assertTrue(bp.passes_gates(self.ROLE, self.OK))

    def test_relax_loosens_crest_centroid_and_attack_by_one_step(self):
        m = dict(self.OK, crest_db=19.5, centroid_hz=3300, attack_ms=150)
        self.assertFalse(bp.passes_gates(self.ROLE, m))
        self.assertTrue(bp.passes_gates(self.ROLE, m, relaxed=True))
        self.assertFalse(bp.passes_gates(self.ROLE, dict(m, crest_db=20.5), relaxed=True))

    def test_duration_and_shape_never_relax(self):
        self.assertFalse(bp.passes_gates(self.ROLE, dict(self.OK, dur_s=3.2), relaxed=True))
        self.assertFalse(bp.passes_gates(self.ROLE, dict(self.OK, sync_frac=0.9), relaxed=True))
        self.assertFalse(bp.passes_gates(dict(self.ROLE, tail_ms_min=1000), self.OK, relaxed=True))
        self.assertFalse(bp.passes_gates(dict(self.ROLE, centroid_hz_min=2600), self.OK, relaxed=True))

    def test_family_strips_numbers(self):
        self.assertEqual(bp.family_of("/x/Whoosh 07.caf"), bp.family_of("/x/Whoosh 12.caf"))
        self.assertNotEqual(bp.family_of("/x/Whoosh 07.caf"), bp.family_of("/y/Whoosh 07.caf"))

    def test_source_letters(self):
        self.assertEqual(bp.source_letter("/Library/Audio/Apple Loops/Apple/Final Cut Pro Sound Effects"), "a")
        self.assertEqual(bp.source_letter("/Users/m/SFX/packs/Epidemic Sound"), "e")
        self.assertEqual(bp.source_letter("/Users/m/SFX/packs/Jordan SFX"), "p")

    def test_placed_gain_never_exceeds_ceiling(self):
        for role in ("glide_soft", "rise_swell", "tick_soft", "room_bed"):
            for tv in (False, True):
                m = dict(self.OK, peak_db=-30.0, rms_db=-60.0, attack_ms=2)
                self.assertLessEqual(m["peak_db"] + bp.placed_gain(role, m, tv), bp.PEAK_CEIL_DB + 1e-9)


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
        with open(os.path.join(cls.out, "palette_report.md")) as fh:
            cls.report = fh.read()

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

    def test_silence_is_trimmed_before_measuring(self):
        e = self.rec(self.pack, "Clicks Row.wav")["entries"][0]
        self.assertLess(e["dur_s"], 0.25)            # a 0.1 s beep plus padding, not the gap

    def test_reverse_swell_peaks_late(self):
        self.assertGreater(self.m("Motions & Transitions/Air Reverse Burst 1.caf")["sync_frac"], 0.85)

    def test_shape_gates_route_the_late_peak_to_rise_swell(self):
        self.assertEqual(self.rels("rise_swell"), ["Motions & Transitions/Air Reverse Burst 1.caf"])
        self.assertNotIn("Motions & Transitions/Air Reverse Burst 1.caf", self.rels("glide_soft"))

    def test_folder_only_roles_take_plain_names_in_their_folder(self):
        glide = self.rels("glide_soft")
        self.assertIn("Motions & Transitions/Whoosh Soft 01.caf", glide)
        self.assertIn("Motions & Transitions/Title Airy 3.caf", glide)
        self.assertNotIn("Motions & Transitions/Whoosh Hard 02.caf", glide)   # excluded by name

    def test_colon_folder_is_decoded(self):
        self.assertLess(self.m("Work:Home/Pencil Click.caf")["dur_s"], 0.1)

    def test_silent_file_is_skipped(self):
        self.assertIn("error", self.rec(self.apple, "Ambience/Silence.caf"))

    def test_multi_hit_file_is_split_into_hits(self):
        entries = self.rec(self.pack, "Clicks Row.wav")["entries"]
        self.assertEqual(len(entries), 5)
        for i, e in enumerate(entries):
            self.assertTrue(e["multi"])
            self.assertGreaterEqual(e["sync_s"], 1.1 * i)
            self.assertLessEqual(e["sync_s"], 1.1 * i + 0.11)

    def test_at_most_three_keys_per_source_file(self):
        self.assertEqual(self.rels("tick_soft").count("Clicks Row.wav"), 3)

    def test_near_twin_files_are_not_both_picked(self):
        ticks = self.rels("tick_soft")
        self.assertEqual(sum(r in ("Work:Home/Mouse Click 2.caf", "Work:Home/Mouse Click 3.caf")
                             for r in ticks), 1)

    def test_whole_library_fallback_skips_banned_folders(self):
        self.assertEqual(self.rels("pill_rattle"), ["Foley/Pill Bottle Shake.caf"])
        self.assertIn("searched the whole library", self.report)

    def test_key_names_show_the_source(self):
        keys = self.palette["roles"]["tick_soft"]
        self.assertTrue(any(k.startswith("tick_soft_a") for k in keys))
        self.assertTrue(any(k.startswith("tick_soft_p") for k in keys))

    def test_room_event_names_are_not_tv_safe(self):
        phone = [v for v in self.palette["keys"].values() if v["rel"] == "Work:Home/Phone Button Click.caf"]
        self.assertEqual(len(phone), 1)
        self.assertFalse(phone[0]["calm_ok_for_tv"])

    def test_no_sound_is_used_twice(self):
        ids = [(v["path"], v["start_s"]) for v in self.palette["keys"].values()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_gains_never_exceed_ceiling(self):
        for k, v in self.palette["keys"].items():
            for g in (v["gain_db"], v["gain_db_tv"]):
                self.assertLessEqual(v["peak_db"] + g, bp.PEAK_CEIL_DB + 1e-6, k)

    def test_report_flags_shortfalls(self):
        self.assertIn("short by", self.report)
        self.assertIn("\"reverse swell\"", self.report)

    def test_previews_written(self):
        for role in ("glide_soft", "tick_soft"):
            self.assertGreater(os.path.getsize(os.path.join(self.out, "previews", f"{role}.wav")), 1000)

    def test_cache_is_reused(self):
        cache = os.path.join(self.out, "measure_cache.json")
        measured = bp.measure_library(FFMPEG, [self.apple, self.pack], cache, 2)
        self.assertEqual(len(measured), len(APPLE) + len(PACK))

    # --- picker ---

    def palette_obj(self, log=None):
        return Palette(os.path.join(self.out, "palette.json"), usage_log=log)

    def test_key_is_locked_to_its_first_scene(self):
        pal = self.palette_obj()
        a = pal.pick("tick_soft", video="N21", scene="S1")
        b = pal.pick("tick_soft", video="N21", scene="S2")
        self.assertNotEqual(a, b)

    def test_repeat_reuses_the_scene_key_at_most_three_times(self):
        pal = self.palette_obj()
        first = pal.pick("tick_soft", video="N21", scene="S1")
        self.assertEqual(pal.pick("tick_soft", video="N21", scene="S1", repeat=True), first)
        self.assertEqual(pal.pick("tick_soft", video="N21", scene="S1", repeat=True), first)
        self.assertNotEqual(pal.pick("tick_soft", video="N21", scene="S1", repeat=True), first)

    def test_runs_out_then_device_map_falls_through(self):
        pal = self.palette_obj()
        n = len(pal.roles["tick_soft"])
        got = {pal.pick("tick_soft", video="N21", scene=f"S{i}") for i in range(n)}
        self.assertEqual(len(got), n)
        with self.assertRaises(LookupError):
            pal.pick("tick_soft", video="N21", scene="S99")
        self.assertIn(pal.pick_for_device("checkmark", video="N21", scene="S99"), pal.roles["glide_soft"])

    def test_tv_filter(self):
        pal = self.palette_obj()
        with self.assertRaises(KeyError):
            pal.pick("room_bed", video="TV", tv=True)          # role not calm enough
        picks = {pal.pick("tick_soft", video="TV", scene=f"T{i}", tv=True) for i in range(4)}
        self.assertTrue(all(pal.keys[k]["calm_ok_for_tv"] for k in picks))

    def test_least_recently_used_across_videos(self):
        log = os.path.join(self.tmp, "usage_log.json")
        pal = self.palette_obj(log)
        first = pal.pick("glide_soft", video="V1", scene="S1")
        pal.finish_video("V1")
        pal2 = self.palette_obj(log)                      # a later session reads the log
        self.assertNotEqual(pal2.pick("glide_soft", video="V2", scene="S1"), first)
        with open(log) as fh:
            self.assertEqual(json.load(fh)["videos"][0]["keys"], [first])


if __name__ == "__main__":
    unittest.main()
