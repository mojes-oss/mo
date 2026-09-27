"""Pick SleepMD SFX keys from palette.json following the spec's variety rules.

    from palette import Palette
    pal = Palette("out/palette.json", usage_log="out/usage_log.json")
    key = pal.pick("glide_soft", video="N21", scene="S3")
    key = pal.pick("tick_soft", video="N21", scene="S4", repeat=True)  # same motion again
    info = pal.keys[key]          # path, start_s, end_s, sync_s, gain_db, gain_db_tv, ...
    pal.finish_video("N21")       # remember what N21 used, for the next videos

Rules it enforces:
  - a key belongs to the first scene that uses it and is locked for the rest of the video
  - inside its scene a key may repeat for an identical motion, at most MAX_REPEATS times
  - new picks prefer the least recently used key across the last LOG_VIDEOS videos
  - tv=True only returns keys marked calm_ok_for_tv (which already leaves out relaxed
    keys, reels-only roles and room-event names like doorbell, phone or cough)
  - picks are deterministic for a given usage log, so re-renders get the same sounds
"""

import json
import os

MAX_REPEATS = 3
LOG_VIDEOS = 10


class Palette:
    def __init__(self, path, usage_log=None):
        with open(path) as fh:
            data = json.load(fh)
        self.roles = data["roles"]
        self.keys = data["keys"]
        self.device_map = {d["device"]: d["roles"] for d in data.get("device_map", [])}
        self.usage_log = usage_log
        self._history = self._load_log()
        self._owner = {}   # video -> {key: scene}
        self._uses = {}    # video -> {key: count}
        self._last = {}    # (video, scene, role) -> key

    def _load_log(self):
        if not self.usage_log or not os.path.exists(self.usage_log):
            return []
        with open(self.usage_log) as fh:
            return json.load(fh).get("videos", [])

    def _recency(self, key):
        """0 = never used in the logged videos; higher = used more recently."""
        for i, v in enumerate(reversed(self._history)):
            if key in v["keys"]:
                return LOG_VIDEOS + 1 - i
        return 0

    def pick(self, role, video, scene=None, tv=False, repeat=False):
        scene = scene if scene is not None else "_"
        owner = self._owner.setdefault(video, {})
        uses = self._uses.setdefault(video, {})

        if repeat:
            prev = self._last.get((video, scene, role))
            if prev and uses[prev] < MAX_REPEATS:
                uses[prev] += 1
                return prev

        pool = [k for k in self.roles.get(role, []) if not tv or self.keys[k]["calm_ok_for_tv"]]
        if not pool:
            raise KeyError(f"no keys for role {role!r} (tv={tv})")
        free = [k for k in pool if k not in owner]
        if not free:
            raise LookupError(f"role {role!r} has no unused keys left in video {video!r}; "
                              f"use another role or grow the palette")
        key = min(free, key=lambda k: (self._recency(k), k))
        owner[key] = scene
        uses[key] = 1
        self._last[(video, scene, role)] = key
        return key

    def pick_for_device(self, device, video, scene=None, tv=False):
        """Try each role mapped to a scene device, in order, until one has a free key."""
        for role in self.device_map.get(device, []):
            try:
                return self.pick(role, video, scene, tv)
            except (KeyError, LookupError):
                continue
        raise LookupError(f"no free key for device {device!r} in video {video!r}")

    def finish_video(self, video):
        """Record the video's keys in the usage log (keeps the last LOG_VIDEOS videos)."""
        used = sorted(self._owner.pop(video, {}))
        self._uses.pop(video, None)
        self._last = {k: v for k, v in self._last.items() if k[0] != video}
        self._history = [v for v in self._history if v["video"] != video]
        self._history.append({"video": video, "keys": used})
        self._history = self._history[-LOG_VIDEOS:]
        if self.usage_log:
            with open(self.usage_log, "w") as fh:
                json.dump({"videos": self._history}, fh, indent=1)
        return used
