"""In-memory event tracker for the live generation stream.

Single-user, single-process. Each job holds an append-only event log plus
an asyncio.Event used to wake SSE subscribers. SSE subscribers walk the
event log by index, so reconnects replay everything from the start.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import AsyncIterator

from ulid import ULID

TERMINAL_EVENTS = frozenset({"ready", "timeout"})


@dataclass
class Job:
    job_id: str
    events: list[dict] = field(default_factory=list)
    waiter: asyncio.Event = field(default_factory=asyncio.Event)
    terminated: bool = False


_jobs: dict[str, Job] = {}


def create_job() -> Job:
    job = Job(job_id=str(ULID()))
    _jobs[job.job_id] = job
    return job


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def emit(job: Job, event: dict) -> None:
    """Append an event and wake every waiting subscriber.

    Synchronous and atomic from the asyncio scheduler's perspective —
    no awaits — so callers don't need to coordinate.
    """
    job.events.append(event)
    if event.get("event") in TERMINAL_EVENTS:
        job.terminated = True
    old = job.waiter
    job.waiter = asyncio.Event()
    old.set()


async def sse_stream(job: Job) -> AsyncIterator[str]:
    """Yield SSE-formatted strings for a single subscriber.

    Walks `events` by index so any number of concurrent subscribers each
    see the full history then live updates. Terminates after a terminal
    event is yielded.
    """
    i = 0
    while True:
        # Capture waiter BEFORE the length check so an emit between the
        # check and the wait can't slip past us — the old waiter will
        # already be set.
        waiter = job.waiter
        if i < len(job.events):
            event = job.events[i]
            i += 1
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("event") in TERMINAL_EVENTS:
                return
            continue
        if job.terminated:
            return
        await waiter.wait()
