"""Live text while an agent writes it: `emit("delta", chunk)` from a runner, sent on as few events as is useful.

A runner that streams (Claude's stream-json partial messages, the API runner's astream, the fake runner) calls
`emit("delta", chunk)` for each piece of text as the model writes it. The step that follows (`text`, `answer`) is still
the whole message and stays the record: deltas are never stored, only shown (helper.delta, agent.delta).

DeltaThrottle gathers the chunks and sends the text of the current block so far at most every `interval` seconds
(80 ms): a client that misses one event still shows the right text with the next. A non-delta step ends the block
(`reset`): its own text is the message.
"""

from __future__ import annotations

import time
from typing import Callable

INTERVAL = 0.08
MAX_CHARS = 20_000


class DeltaThrottle:
    def __init__(self, send: Callable[[dict], None], interval: float = INTERVAL, clock: Callable[[], float] = time.monotonic):
        self.send, self.interval, self.clock = send, interval, clock
        self.text = ""
        self.block = 0
        self.n = 0
        self.last = 0.0
        self.sent = 0                      # how much of `text` the last event carried

    def add(self, chunk: str) -> None:
        if not chunk:
            return
        self.text = (self.text + str(chunk))[-MAX_CHARS:]
        if self.clock() - self.last >= self.interval:
            self.flush()

    def flush(self) -> None:
        if not self.text or self.sent == len(self.text):
            return
        self.n += 1
        self.last = self.clock()
        self.sent = len(self.text)
        self.send({"n": self.n, "block": self.block, "text": self.text})

    def reset(self) -> None:
        """A whole step arrived: send what is left of this block, then start the next one."""
        self.flush()
        if self.text:
            self.block += 1
        self.text, self.sent = "", 0
