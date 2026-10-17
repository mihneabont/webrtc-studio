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


class Engine:
    def __init__(self, make_program: Callable[[Format, Encoder], Program], prefer_encoder: str | None = None) -> None:
        self.make_program = make_program
        self.prefer_encoder = prefer_encoder
        self.loop: GLib.MainLoop | None = None
        self.program: Program | None = None
        self.encoder: Encoder | None = None
        self.error: str | None = None
        self._thread: threading.Thread | None = None

    def start(self, fmt: Format) -> None:
        Gst.init(None)
        ready = threading.Event()

        def run() -> None:
            self.loop = GLib.MainLoop()
            GLib.idle_add(self._start_program, fmt, ready)
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
