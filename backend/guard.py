"""
Load protection for the small Render instance (0.5 CPU, 512 MB).

Heavy work (loading a field's images, a new-field job, the parallax tracker, archival frames) runs
in at most SLOTS places at once. Background warm-up only runs when nothing else is waiting. Before
heavy work starts, memory is checked: cached images are dropped first, and if memory is still too
high the request is answered with "busy" (HTTP 503 + Retry-After, which the page retries by
itself) instead of letting the server run out of memory and restart.

Parts of this file were written with the assistance of an AI coding assistant
(Claude, Anthropic) and reviewed by the team. See README "Use of AI".
"""
from __future__ import annotations

import ctypes
import gc
import os
import subprocess
import sys
import threading
import time
from contextlib import contextmanager

SLOTS = int(os.environ.get("HEAVY_SLOTS", "2"))
SOFT_MB = float(os.environ.get("MEM_SOFT_MB", "360"))     # above this: drop cached images first
HARD_MB = float(os.environ.get("MEM_HARD_MB", "440"))     # still above this: answer "busy"
MAX_JOBS = int(os.environ.get("MAX_QUEUED_JOBS", "6"))   # new-field jobs running + waiting

_cv = threading.Condition()
_active = 0
_waiting = 0


class Busy(Exception):
    """The server is at its limit right now; the client should retry in a few seconds."""

    def __init__(self, message="The server is busy right now. Retrying in a few seconds…", retry_after=4):
        super().__init__(message)
        self.retry_after = retry_after


def _libc():
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.mallopt(-8, 2)            # M_ARENA_MAX = 2: glibc would otherwise give every thread its own heap
        return libc
    except (OSError, AttributeError):
        return None


LIBC = _libc()


def release_memory():
    """Give freed memory back to the system (glibc keeps it otherwise)."""
    gc.collect()
    if LIBC is not None:
        try:
            LIBC.malloc_trim(0)
        except AttributeError:
            pass


def mem_mb() -> float:
    """Resident memory of this process in MB."""
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 2**20
    except OSError:
        try:                            # macOS (local runs)
            return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())])) / 1024
        except Exception:
            return 0.0


def relieve():
    """Drop cached images (oldest first) until memory is below SOFT_MB."""
    import pipeline as pl
    if mem_mb() <= SOFT_MB:
        return
    while pl.evict_oldest_cutouts():
        release_memory()
        if mem_mb() <= SOFT_MB:
            return
    release_memory()


def status() -> dict:
    with _cv:
        return {"active": _active, "waiting": _waiting, "slots": SLOTS, "mem_mb": round(mem_mb())}


@contextmanager
def heavy(wait: float | None = 20.0, background: bool = False):
    """Run a block of heavy work in one of the SLOTS. Raises Busy when no slot frees up within `wait`
    seconds (None = wait as long as needed) or when memory stays too high. Background work only starts
    when no other heavy work is running or waiting."""
    global _active, _waiting
    deadline = None if wait is None else time.monotonic() + wait
    with _cv:
        if not background:
            _waiting += 1
        try:
            while _active >= SLOTS or (background and (_active or _waiting)):
                left = None if deadline is None else deadline - time.monotonic()
                if left is not None and left <= 0:
                    raise Busy()
                _cv.wait(left if left is not None else 5.0)
        finally:
            if not background:
                _waiting -= 1
        _active += 1
    try:
        relieve()
        if mem_mb() > HARD_MB:
            raise Busy("The server is low on memory right now. Retrying in a few seconds…", retry_after=6)
        yield
    finally:
        with _cv:
            _active -= 1
            _cv.notify_all()


# Short GIL switch interval: with download threads busy, the web thread still gets its turn quickly,
# so Render's 5-second health check is always answered.
sys.setswitchinterval(0.002)
