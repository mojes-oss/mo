"""Pick SleepMD SFX keys from palette.json without repeating a sound inside one video.

    from palette import Palette
    pal = Palette("out/palette.json")
    key = pal.pick("glide_soft", video="N21", tv=False)
    info = pal.keys[key]          # path, sync_s, gain_db, ...

Rules it enforces:
  - a key is never reused within the same video (no "machine-gun" repeats)
  - tv=True only returns keys whose role is calm enough for SleepMD TV
  - picks are deterministic for a given video, so re-renders get the same sounds
"""

import hashlib
import json


class Palette:
    def __init__(self, path):
        with open(path) as fh:
            data = json.load(fh)
        self.roles = data["roles"]
        self.keys = data["keys"]
        self.device_map = {d["device"]: d["roles"] for d in data.get("device_map", [])}
        self._used = {}

    def pick(self, role, video, tv=False):
        pool = [k for k in self.roles.get(role, []) if not tv or self.keys[k]["calm_ok_for_tv"]]
        if not pool:
            raise KeyError(f"no keys for role {role!r} (tv={tv})")
        used = self._used.setdefault(video, set())
        free = [k for k in pool if k not in used]
        if not free:
            raise LookupError(f"role {role!r} has no unused keys left in video {video!r}; "
                              f"use another role or grow the palette")
        # Rotate from a per-video starting point so different videos open on different sounds.
        start = int(hashlib.sha1(f"{video}:{role}".encode()).hexdigest(), 16) % len(free)
        key = free[start]
        used.add(key)
        return key

    def pick_for_device(self, device, video, tv=False):
        """Try each role mapped to a scene device, in order, until one has a free key."""
        for role in self.device_map.get(device, []):
            try:
                return self.pick(role, video, tv)
            except (KeyError, LookupError):
                continue
        raise LookupError(f"no free key for device {device!r} in video {video!r}")

    def reset(self, video=None):
        if video is None:
            self._used.clear()
        else:
            self._used.pop(video, None)
