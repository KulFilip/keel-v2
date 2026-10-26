"""The event sender sleeps while there is nothing to send, and an event emitted from a worker thread wakes it.

Before, it woke 4 times a second forever (asyncio.wait_for with a 0.25 s timeout), also on an idle keel.
"""

import asyncio
import threading

from keel_engine.events import EventBus


async def test_an_idle_sender_does_not_wake_up(monkeypatch):
    monkeypatch.setenv("KEEL_API_URL", "http://api.test")
    bus = EventBus()
    sends = []

    async def fake_send(client=None, timeout=5.0):
        sends.append(len(bus._pending))
        bus._pending.clear()
        return True

    monkeypatch.setattr(bus, "_send_once", fake_send)
    bus.start()
    try:
        await asyncio.sleep(1.2)
        assert sends == []                      # the old loop had tried about 5 times by now

        # emit() from a worker thread (asyncio.to_thread, the stack setup): the sender wakes at once
        await asyncio.to_thread(bus.emit, "index.done", "", "p1")
        for _ in range(50):
            if sends:
                break
            await asyncio.sleep(0.01)
        assert sends == [1]

        # and from the loop itself
        bus.emit("thread.started", "t1", "p1")
        for _ in range(50):
            if len(sends) == 2:
                break
            await asyncio.sleep(0.01)
        assert sends == [1, 1]
    finally:
        bus._task.cancel()
        try:
            await bus._task
        except asyncio.CancelledError:
            pass
        bus._task = None


async def test_a_failed_send_is_retried_without_a_new_event(monkeypatch):
    monkeypatch.setenv("KEEL_API_URL", "http://api.test")
    bus = EventBus()
    calls = []

    async def flaky(client=None, timeout=5.0):
        calls.append(1)
        if len(calls) == 1:
            return False                        # the api is down: the event stays pending
        bus._pending.clear()
        return True

    monkeypatch.setattr(bus, "_send_once", flaky)
    bus.start()
    try:
        bus.emit("thread.started", "t1", "p1")
        for _ in range(300):                    # the retry waits 1 s (the back-off), then sends
            if len(calls) >= 2:
                break
            await asyncio.sleep(0.01)
        assert len(calls) == 2 and not bus._pending
    finally:
        bus._task.cancel()
        try:
            await bus._task
        except asyncio.CancelledError:
            pass
        bus._task = None


def test_emit_from_a_thread_after_the_loop_closed_does_not_raise():
    bus = EventBus()

    async def run():
        bus.start()
        bus._task.cancel()
        try:
            await bus._task
        except asyncio.CancelledError:
            pass

    asyncio.run(run())
    t = threading.Thread(target=bus.emit, args=("thread.started", "t1", "p1"))
    t.start()
    t.join()
    assert len(bus._pending) == 1
