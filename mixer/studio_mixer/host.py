"""Runs the mixing pipeline (program.Program) on its own GLib main-loop thread.

The API server runs on asyncio in another thread. Commands cross over with
GLib.idle_add; status and meters come back through callbacks, which the
server forwards to its own loop.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402

from .media import Encoder, Format, pick_encoder  # noqa: E402
from .program import Program  # noqa: E402

log = logging.getLogger(__name__)

STALL_SECONDS = 6


class Engine:
    def __init__(self, make_program: Callable[[Format, Encoder], Program], prefer_encoder: str | None = None,
                 on_rebuilt: Callable[[Program], None] | None = None) -> None:
        self.make_program = make_program
        self.on_rebuilt = on_rebuilt
        self.prefer_encoder = prefer_encoder
        self.loop: GLib.MainLoop | None = None
        self.program: Program | None = None
        self.encoder: Encoder | None = None
        self.error: str | None = None
        self.skip: set[str] = set()  # encoders that stalled
        self._thread: threading.Thread | None = None

    def start(self, fmt: Format) -> None:
        Gst.init(None)
        ready = threading.Event()

        def run() -> None:
            self.loop = GLib.MainLoop()
            GLib.idle_add(self._start_program, fmt, ready)
            GLib.timeout_add(1000, self._watch_encoder)
            self.loop.run()

        self._thread = threading.Thread(target=run, name="engine", daemon=True)
        self._thread.start()
        ready.wait(60)

    def _start_program(self, fmt: Format, ready: threading.Event) -> bool:
        try:
            if self.encoder is None:
                self.encoder = pick_encoder(self.prefer_encoder)
            self.program = self.make_program(fmt, self.encoder)
            self.program.start()
            self.error = None
        except Exception as exc:  # report, keep the API up
            log.exception("could not start the mixer")
            self.error = str(exc)
            self.program = None
        ready.set()
        return False

    def _watch_encoder(self) -> bool:
        # A hardware encoder can pass the short start-up test and still output nothing in the full
        # pipeline (two encoders at once, longer runs). Then the programme and the preview have no
        # video, so switch to the next encoder that works.
        p = self.program
        if p is not None and p.enc_stalled >= STALL_SECONDS and self.encoder and self.encoder.name != "x264enc":
            bad = self.encoder.name
            self.skip.add(bad)
            try:
                self.encoder = pick_encoder(None, skip=self.skip)
            except RuntimeError as exc:
                self.error = str(exc)
                return True
            log.error("%s took frames for %d s but encoded none; switching to %s", bad, p.enc_stalled, self.encoder.name)
            fmt = p.fmt
            p.stop()
            self.program = None
            self._start_program(fmt, threading.Event())
            if self.program is not None and self.on_rebuilt:
                self.on_rebuilt(self.program)
        return True

    def call(self, fn: Callable[[Program], object]) -> None:
        """Run fn(program) on the engine thread."""
        def run() -> bool:
            if self.program is not None:
                try:
                    fn(self.program)
                except Exception:
                    log.exception("engine command failed")
            return False

        GLib.idle_add(run)

    def restart(self, fmt: Format, then: Callable[[Program], None] | None = None) -> None:
        """Rebuild the pipeline, e.g. for a new programme resolution."""
        def run() -> bool:
            if self.program is not None:
                self.program.stop()
                self.program = None
            ev = threading.Event()
            self._start_program(fmt, ev)
            if then and self.program is not None:
                then(self.program)
            return False

        GLib.idle_add(run)

    def stop(self) -> None:
        if self.loop is None:
            return
        done = threading.Event()

        def run() -> bool:
            if self.program is not None:
                self.program.stop()
            self.loop.quit()
            done.set()
            return False

        GLib.idle_add(run)
        done.wait(10)
