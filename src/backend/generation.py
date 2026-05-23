"""Director/builder loop pipeline.

Two public entry points:

- `run_generation(job_id)` — synchronous, blocks until the row is inserted.
  Used by `POST /api/generation`.
- `run_slice_three_streaming(job_id, context, on_draft)` — async, streams
  partial drafts by watching the builder's tempdir for `index.html`
  changes. Used by the live `/api/jobs` pipeline.

Both pull slice-1 context from Supabase Storage (`<job_id>/context/`),
build in a `tempfile.TemporaryDirectory()`, and upload the final HTML to
`<job_id>/site/index.html`. The DB row insert is the commit point.

**Runner.** We currently delegate to `claude` for the agentic loop —
Gemini 3.5 Flash (the model agy ships with at IO 2026) reliably spirals
into planner loops on this workload and never produces a build. The
agy-side wiring is still in place and ready to re-enable when Antigravity
exposes a stronger model:
  - `tools/agy_mcp_wrapper.sh` — MCP server launcher that sources .env
  - `~/.gemini/antigravity-cli/mcp_config.json` — global `assets` entry
The MCP server itself (`tools/mcp_server.py`) is runner-agnostic; both
agy and claude speak MCP over stdio.

**Loop.** Round 0: prompter writes the brief, builder produces v1.
Rounds 1..MAX_ROUNDS-1: critic reviews — if `APPROVE` we ship the
latest HTML, otherwise builder revises against the critique.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import HTTPException

from supabase_client import get_client

BACKEND_DIR = Path(__file__).resolve().parent
PROMPTS_DIR = BACKEND_DIR / "prompts"

BUCKET = "generations"
CONTEXT_KEY = "{job_id}/context/{name}"
SITE_KEY = "{job_id}/site/index.html"
SIGNED_URL_TTL_SECONDS = 60 * 60

PROMPTER_TIMEOUT_S = 60
BUILDER_TIMEOUT_S = 300
CRITIC_TIMEOUT_S = 90

# Single opus build, no critic loop. Bumping this to 2+ reintroduces the
# director/builder back-and-forth (the critic+revise cycle costs ~60-90s
# per round and tends to converge on trivial edits — pushed us over the
# 2-min wall budget).
MAX_ROUNDS = 1
APPROVE_TOKEN = "APPROVE"

# Opus 4.7 for every step. Speed comes from prompts (anti-planning,
# parallel-fetch directives), not from downgrading the model — Haiku and
# Sonnet both got slower on this workload, not faster.
MODEL = "claude-opus-4-7"

WATCH_INTERVAL_S = 0.25

BUILDER_ALLOWED_TOOLS = (
    "Write,Read,Edit,"
    "mcp__assets__qr_code,"
    "mcp__assets__place_photo,"
    "mcp__assets__validate_card,"
    "mcp__assets__screenshot_card"
)

# Critic only needs to look at the rendered card — no writes, no asset gen.
CRITIC_ALLOWED_TOOLS = "mcp__assets__screenshot_card"


def _load_prompt(name: str) -> str:
    """Read a system prompt from prompts/<name>.md at call time.

    Re-read on every invocation so prompt edits take effect without
    restarting uvicorn.
    """
    return (PROMPTS_DIR / f"{name}.md").read_text().strip()


logger = logging.getLogger(__name__)


def compact_context(places: dict, distilled: dict) -> dict:
    """Trim context to the essentials the builder actually needs."""
    reviews = []
    for r in places.get("reviews", [])[:2]:
        text = (r.get("text") or {}).get("text", "")
        if not text:
            continue
        reviews.append({
            "text": text[:200],
            "author": (r.get("authorAttribution") or {}).get("displayName"),
            "rating": r.get("rating"),
        })
    return {
        "name": (places.get("displayName") or {}).get("text"),
        "address": places.get("formattedAddress"),
        "types": places.get("types", [])[:3],
        "editorial_summary": (places.get("editorialSummary") or {}).get("text"),
        "reviews": reviews,
        "rating": places.get("rating"),
        "user_rating_count": places.get("userRatingCount"),
        "contact": {
            "website": places.get("websiteUri"),
            "maps": places.get("googleMapsUri"),
            "phone": places.get("internationalPhoneNumber"),
        },
        "distilled": {
            "tagline": distilled.get("tagline"),
            "description": distilled.get("description"),
            "tone": distilled.get("tone"),
            "vibe_tags": distilled.get("vibe_tags", []),
        },
        "website_uri": places.get("websiteUri"),
        "photos_available": len(places.get("photos", [])),
    }


def _runner_or_die() -> str:
    """Resolve the LLM runner binary. See module docstring for the agy story."""
    path = shutil.which("claude")
    if not path:
        raise HTTPException(status_code=502, detail="LLM runner not found on PATH")
    return path


def _write_mcp_config(build_dir: Path, job_id: str) -> Path:
    """Write per-build `.mcp.json` into the builder's tempdir.

    Same `assets` MCP server registration as the agy global config — same
    Python module, same wrapper script — but inlined per-build so claude's
    --mcp-config flag picks it up and so JOB_ID / BUILD_DIR get injected
    into the spawned MCP server's env without polluting the launcher's env.
    """
    config = {
        "mcpServers": {
            "assets": {
                "type": "stdio",
                "command": "uv",
                "args": [
                    "run",
                    "--directory",
                    str(BACKEND_DIR),
                    "python",
                    "-m",
                    "tools.mcp_server",
                ],
                "env": {
                    "JOB_ID": job_id,
                    "BUILD_DIR": str(build_dir),
                    "BACKEND_BASE_URL": os.environ.get(
                        "BACKEND_BASE_URL", "http://localhost:8000"
                    ),
                    "SUPABASE_URL": os.environ["SUPABASE_URL"],
                    "SUPABASE_SERVICE_ROLE_KEY": os.environ[
                        "SUPABASE_SERVICE_ROLE_KEY"
                    ],
                    "PLACES_API": os.environ["PLACES_API"],
                    "GEMINI_API_KEY": os.environ["GEMINI_API_KEY"],
                },
            }
        }
    }
    path = build_dir / ".mcp.json"
    path.write_text(json.dumps(config))
    return path


def _run_prompter(runner: str, context: dict, job_id: str) -> str:
    """Round 0: turn the compacted context into a creative brief."""
    proc = subprocess.Popen(
        [
            runner, "-p",
            "--model", MODEL,
            "--system-prompt", _load_prompt("prompter"),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        stdout, stderr = proc.communicate(
            input=json.dumps(context).encode("utf-8"),
            timeout=PROMPTER_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.communicate(timeout=5)
        except Exception:
            pass
        raise HTTPException(status_code=502, detail="generation timed out") from None
    if proc.returncode != 0:
        logger.warning(
            "prompter failed for %s (exit=%d): %s",
            job_id, proc.returncode, (stderr or b"").decode(errors="replace"),
        )
        raise HTTPException(status_code=502, detail="prompter failed")
    brief = (stdout or b"").decode(errors="replace").strip()
    if not brief:
        raise HTTPException(status_code=502, detail="prompter produced no output")
    return brief


def _builder_input(brief: str, critiques: list[str]) -> str:
    """Builder gets brief alone on round 0; brief + latest critique after."""
    if not critiques:
        return brief
    return f"{brief}\n\n---\n\nREVISE\n{critiques[-1]}"


def _builder_argv(runner: str, mcp_config: Path) -> list[str]:
    return [
        runner, "-p",
        "--model", MODEL,
        "--mcp-config", str(mcp_config),
        "--allowedTools", BUILDER_ALLOWED_TOOLS,
        "--dangerously-skip-permissions",
        "--system-prompt", _load_prompt("builder"),
    ]


def _critic_argv(runner: str, mcp_config: Path) -> list[str]:
    return [
        runner, "-p",
        "--model", MODEL,
        "--mcp-config", str(mcp_config),
        "--allowedTools", CRITIC_ALLOWED_TOOLS,
        "--dangerously-skip-permissions",
        "--system-prompt", _load_prompt("critic"),
    ]


def _run_builder(
    runner: str, brief: str, critiques: list[str],
    build_dir: Path, mcp_config: Path, job_id: str,
) -> str:
    proc = subprocess.Popen(
        _builder_argv(runner, mcp_config),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(build_dir),
    )
    try:
        _, stderr = proc.communicate(
            input=_builder_input(brief, critiques).encode("utf-8"),
            timeout=BUILDER_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.communicate(timeout=5)
        except Exception:
            pass
        raise HTTPException(status_code=502, detail="generation timed out") from None
    if proc.returncode != 0:
        logger.warning(
            "builder failed for %s (exit=%d): %s",
            job_id, proc.returncode, (stderr or b"").decode(errors="replace"),
        )
        raise HTTPException(status_code=502, detail="builder failed")
    index = build_dir / "index.html"
    if not index.exists():
        raise HTTPException(status_code=502, detail="builder produced no output")
    return index.read_text()


def _run_critic(
    runner: str, brief: str, build_dir: Path, mcp_config: Path, job_id: str
) -> str:
    """Run the critic round. Returns its verdict (starts with APPROVE or REVISE).

    The critic calls `screenshot_card()` itself; we pass it the brief so
    it can compare intent against the rendered output. Failures and
    timeouts collapse to APPROVE — better to ship the latest draft than
    block the user.
    """
    proc = subprocess.Popen(
        _critic_argv(runner, mcp_config),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(build_dir),
    )
    try:
        stdout, stderr = proc.communicate(
            input=brief.encode("utf-8"),
            timeout=CRITIC_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.communicate(timeout=5)
        except Exception:
            pass
        logger.warning("critic timed out for %s — treating as APPROVE", job_id)
        return APPROVE_TOKEN
    if proc.returncode != 0:
        logger.warning(
            "critic failed for %s (exit=%d): %s — treating as APPROVE",
            job_id, proc.returncode, (stderr or b"").decode(errors="replace"),
        )
        return APPROVE_TOKEN
    return (stdout or b"").decode(errors="replace").strip()


def _download_context(job_id: str, name: str) -> bytes | None:
    """Download a slice-1 context blob from Storage. None if missing."""
    try:
        return get_client().storage.from_(BUCKET).download(
            CONTEXT_KEY.format(job_id=job_id, name=name)
        )
    except Exception:
        return None


def _upload_site(job_id: str, html: str) -> None:
    """Upload (or replace) the site HTML at <job_id>/site/index.html."""
    path = SITE_KEY.format(job_id=job_id)
    get_client().storage.from_(BUCKET).upload(
        path,
        html.encode("utf-8"),
        file_options={
            "content-type": "text/html",
            "cache-control": "no-store",
            "upsert": "true",
        },
    )


def _insert_generation_row(job_id: str, website_uri: str | None) -> None:
    """Upsert by id — re-running a job replaces its row instead of 409-ing."""
    get_client().table("generations").upsert(
        {"id": job_id, "url": website_uri}
    ).execute()


def run_pipeline(job_id: str) -> tuple[str, str | None]:
    """Run the director/builder loop. Returns (html, website_uri_from_places)."""
    places_bytes = _download_context(job_id, "places.json")
    if places_bytes is None:
        raise HTTPException(status_code=404, detail="job not found")
    places = json.loads(places_bytes)

    distilled_bytes = _download_context(job_id, "site-distilled.json")
    distilled = json.loads(distilled_bytes) if distilled_bytes else None
    context = compact_context(places, distilled or {})

    runner = _runner_or_die()
    with tempfile.TemporaryDirectory(prefix=f"build-{job_id}-") as build_dir_str:
        build_dir = Path(build_dir_str)
        mcp_config = _write_mcp_config(build_dir, job_id)
        brief = _run_prompter(runner, context, job_id)
        critiques: list[str] = []
        html = ""
        for round_num in range(MAX_ROUNDS):
            html = _run_builder(runner, brief, critiques, build_dir, mcp_config, job_id)
            if round_num == MAX_ROUNDS - 1:
                break  # no critic after the last round — ship what we have
            verdict = _run_critic(runner, brief, build_dir, mcp_config, job_id)
            logger.info(
                "round %d critic verdict for %s: %s",
                round_num, job_id, verdict.splitlines()[0] if verdict else "<empty>",
            )
            if verdict.startswith(APPROVE_TOKEN):
                break
            critiques.append(verdict)
    return html, context["website_uri"]


def run_generation(job_id: str) -> str:
    """Generate a card for the given slice-1 job_id. Returns the same job_id.

    Order: upload first, then insert. The DB row is the commit point — if
    the upload fails we never claim the generation exists. If the row insert
    fails after a successful upload the orphan object is harmless.
    """
    html, website_uri = run_pipeline(job_id)
    _upload_site(job_id, html)
    _insert_generation_row(job_id, website_uri)
    return job_id


def signed_preview_url(job_id: str) -> str:
    path = SITE_KEY.format(job_id=job_id)
    res = get_client().storage.from_(BUCKET).create_signed_url(
        path, SIGNED_URL_TTL_SECONDS
    )
    return res["signedURL"]


# ---------------------------------------------------------------------------
# Streaming variant: spawns the builder as an async subprocess and watches
# its tempdir for `index.html` changes, pushing each partial to Storage.
# ---------------------------------------------------------------------------


async def _watch_partial_writes(
    build_dir: Path,
    job_id: str,
    on_draft: Callable[[int], Awaitable[None]],
    revision_counter: list[int],
) -> None:
    """Poll `build_dir/index.html`; upload + emit on each mtime change.

    `revision_counter` is a single-element list used as a mutable box so
    the caller can read the final revision after cancellation.
    """
    index = build_dir / "index.html"
    last_mtime: float | None = None
    while True:
        await asyncio.sleep(WATCH_INTERVAL_S)
        try:
            mtime = index.stat().st_mtime
        except FileNotFoundError:
            continue
        if mtime == last_mtime:
            continue
        last_mtime = mtime
        try:
            html = index.read_text()
        except Exception:
            logger.exception("partial read failed for %s", job_id)
            continue
        if not html.strip():
            continue
        try:
            await asyncio.to_thread(_upload_site, job_id, html)
        except Exception:
            logger.exception("partial upload failed for %s", job_id)
            continue
        revision_counter[0] += 1
        try:
            await on_draft(revision_counter[0])
        except Exception:
            logger.exception("on_draft callback failed for %s", job_id)


async def _run_builder_streaming(
    runner: str,
    brief: str,
    critiques: list[str],
    build_dir: Path,
    mcp_config: Path,
    job_id: str,
    on_draft: Callable[[int], Awaitable[None]],
    revision_counter: list[int],
) -> str | None:
    """Spawn builder as an async subprocess with a concurrent file watcher.

    Returns the final HTML or None if the builder failed / produced no
    output / timed out. Errors are logged but never raised — the calling
    pipeline decides how to communicate failure to the user.
    """
    proc = await asyncio.create_subprocess_exec(
        *_builder_argv(runner, mcp_config),
        cwd=str(build_dir),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    watcher = asyncio.create_task(
        _watch_partial_writes(build_dir, job_id, on_draft, revision_counter)
    )
    try:
        try:
            _, stderr = await asyncio.wait_for(
                proc.communicate(input=_builder_input(brief, critiques).encode("utf-8")),
                timeout=BUILDER_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            logger.warning("builder timed out for %s", job_id)
            proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                pass
            return None
    finally:
        watcher.cancel()
        try:
            await watcher
        except asyncio.CancelledError:
            pass

    if proc.returncode != 0:
        logger.warning(
            "builder failed for %s (exit=%d): %s",
            job_id, proc.returncode, (stderr or b"").decode(errors="replace"),
        )
        return None
    index = build_dir / "index.html"
    if not index.exists():
        logger.warning("builder produced no index.html for %s", job_id)
        return None
    return index.read_text()


async def _run_critic_async(
    runner: str, brief: str, build_dir: Path, mcp_config: Path, job_id: str
) -> str:
    return await asyncio.to_thread(
        _run_critic, runner, brief, build_dir, mcp_config, job_id
    )


async def run_slice_three_streaming(
    job_id: str,
    context: dict,
    on_draft: Callable[[int], Awaitable[None]],
) -> int | None:
    """Streaming variant of `run_generation`.

    Takes the already-compacted slice-1 context in memory (no Storage
    round-trip), runs the prompter, then runs the director/builder loop
    with a tempdir watcher that calls `on_draft(revision)` each time
    `index.html` is written/edited. Performs one final upload after the
    loop exits, calls `on_draft` for that revision, inserts the row,
    and returns the final revision number.

    Returns None on failure (prompter/builder failure, timeout, etc.).
    Never raises.
    """
    try:
        runner = _runner_or_die()
    except HTTPException:
        return None

    revision_counter = [0]
    with tempfile.TemporaryDirectory(prefix=f"build-{job_id}-") as build_dir_str:
        build_dir = Path(build_dir_str)
        mcp_config = _write_mcp_config(build_dir, job_id)
        try:
            brief = await asyncio.to_thread(_run_prompter, runner, context, job_id)
        except HTTPException as e:
            logger.warning("prompter failed for %s: %s", job_id, e.detail)
            return None
        critiques: list[str] = []
        html: str | None = None
        for round_num in range(MAX_ROUNDS):
            html = await _run_builder_streaming(
                runner, brief, critiques, build_dir, mcp_config, job_id,
                on_draft, revision_counter,
            )
            if html is None:
                return None
            if round_num == MAX_ROUNDS - 1:
                break
            verdict = await _run_critic_async(
                runner, brief, build_dir, mcp_config, job_id
            )
            logger.info(
                "round %d critic verdict for %s: %s",
                round_num, job_id, verdict.splitlines()[0] if verdict else "<empty>",
            )
            if verdict.startswith(APPROVE_TOKEN):
                break
            critiques.append(verdict)
        # Final upload catches any Edit that landed between the last
        # watcher poll and builder exit.
        try:
            await asyncio.to_thread(_upload_site, job_id, html)
        except Exception:
            logger.exception("final upload failed for %s", job_id)
            return None

    revision_counter[0] += 1
    try:
        await on_draft(revision_counter[0])
    except Exception:
        logger.exception("final on_draft failed for %s", job_id)

    try:
        await asyncio.to_thread(
            _insert_generation_row, job_id, context.get("website_uri")
        )
    except Exception:
        logger.exception("row insert failed for %s", job_id)
        # Storage upload succeeded — the card is viewable via /api/preview.
        # The row insert failure means it won't show in history. Soft success.

    return revision_counter[0]
