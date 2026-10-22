"""Shared set-up for the e2e suites: a free port and unique names for each run, and a clean-up of only those names.

Two suites (or two runs of one suite, or a suite and a test script) used to share fixed ports (8096, 8097, 8099) and the
names keel-lab / keel-lab-data, so one run could remove the other's container and volume. Now each run asks this module:

    import lib                                   (e2e/lib.py; the suites put e2e/ on sys.path)
    E = lib.Env.make("core")                     # keel-e2e-core-<random>, volume <name>-data, a free port
    NAME, VOLUME, PORT = E.name, E.volume, E.port

    with lib.Env.make("core") as E: ...          # the same as a context manager: clean-up when the block ends

An Env removes its own container(s) and volume(s) when the block ends, or (without `with`) when the process exits,
unless `E.keep = True` (--keep). It refuses a person's keel: the ports 8088, 8188, 8390 and the names keel-v2 and
keel-data (also as a name given by hand: KEEL_NAME, --name, --port).
"""
from __future__ import annotations

import atexit
import secrets
import socket
import subprocess

PROTECTED_PORTS = frozenset({8088, 8188, 8390})
PROTECTED_NAMES = frozenset({"keel-v2", "keel-data"})


def free_port() -> int:
    """A port nobody listens on now (picked by the system), never a protected one."""
    while True:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in PROTECTED_PORTS:
            return port


def guard(name: str | None = None, volume: str | None = None, port: int | None = None) -> None:
    """Exit when a name or port is a person's keel."""
    for n in (name, volume):
        if n in PROTECTED_NAMES:
            raise SystemExit(f"{n} is a person's keel (or its data): the e2e never uses it")
    if port in PROTECTED_PORTS:
        raise SystemExit(f"port {port} is a person's keel (or its catalog): the e2e never uses it")


def _docker(*a: str) -> None:
    subprocess.run(["docker", *a], capture_output=True, text=True, check=False)


class Env:
    """One run's container name, volume and port; removes only those at the end."""

    def __init__(self, name: str, volume: str, port: int):
        guard(name, volume, port)
        self.name, self.volume, self.port = name, volume, port
        self.containers = [name]
        self.volumes = [volume]
        self.keep = False
        self._done = False
        atexit.register(self.cleanup)

    @classmethod
    def make(cls, suite: str, name: str | None = None, volume: str | None = None, port: int | None = None) -> "Env":
        """Unique names keel-e2e-<suite>-<random> and a free port; a name, volume or port given by hand is kept (and checked)."""
        name = name or f"keel-e2e-{suite}-{secrets.token_hex(3)}"
        return cls(name, volume or f"{name}-data", port or free_port())

    def retarget(self, name: str | None, volume: str | None, port: int | None) -> None:
        """Use a name, volume or port chosen by hand (--name, --port) instead of the generated ones (checked)."""
        name = name or self.name
        volume = volume or (f"{name}-data" if name != self.name else self.volume)
        port = port or self.port
        guard(name, volume, port)
        self.name, self.volume, self.port = name, volume, port
        self.containers, self.volumes = [name], [volume]

    def also(self, container: str | None = None, volume: str | None = None) -> None:
        """Another container or volume of this run to remove at the end (it must not be a protected name)."""
        guard(container, volume)
        if container:
            self.containers.append(container)
        if volume:
            self.volumes.append(volume)

    def cleanup(self) -> None:
        if self._done or self.keep:
            return
        self._done = True
        for c in self.containers:
            _docker("rm", "-f", c)
        for v in self.volumes:
            _docker("volume", "rm", v)

    def __enter__(self) -> "Env":
        return self

    def __exit__(self, *exc: object) -> None:
        self.cleanup()
