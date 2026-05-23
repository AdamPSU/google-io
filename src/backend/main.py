import asyncio
import json
import logging
import os
import re
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from google import genai
from pydantic import BaseModel
from ulid import ULID

import jobs
from generation import (
    BUILDER_TIMEOUT_S,
    PROMPTER_TIMEOUT_S,
    compact_context,
    run_generation,
    run_slice_three_streaming,
    signed_preview_url,
)
from supabase_client import get_client

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")

PLACES_API_KEY = os.environ.get("PLACES_API")
if not PLACES_API_KEY:
    raise RuntimeError("PLACES_API is not set in .env")

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY is not set in .env")

PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PLACES_DETAILS_URL = "https://places.googleapis.com/v1/places/{place_id}"
SEARCH_FIELD_MASK = "places.id"
DETAILS_FIELD_MASK = (
    "id,displayName,formattedAddress,rating,userRatingCount,reviews,"
    "regularOpeningHours,priceLevel,types,editorialSummary,"
    "websiteUri,photos,internationalPhoneNumber,googleMapsUri"
)
HTML_BYTE_CEILING = 200_000
STORAGE_BUCKET = "generations"

GEMINI_MODEL = "gemini-3.5-flash"
DISTILL_PROMPT = """You receive the raw HTML of a small business's homepage.

Extract concise, structured signal that captures how the business communicates — \
tagline, value props, voice, vibe, visual cues referenced in the copy. \
Do not invent details. If a field cannot be supported by the HTML, leave it \
empty or use a generic value.

HTML:

"""

logger = logging.getLogger(__name__)

app = FastAPI(title="google-io backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

gemini = genai.Client(api_key=GEMINI_API_KEY)


class SearchRequest(BaseModel):
    query: str


class Review(BaseModel):
    author: str | None = None
    rating: int | None = None
    text: str | None = None
    publish_time: str | None = None


class Photo(BaseModel):
    name: str
    width_px: int | None = None
    height_px: int | None = None


class SiteDistilled(BaseModel):
    tagline: str | None
    description: str
    tone: str
    vibe_tags: list[str]
    key_phrases: list[str]
    visual_cues: list[str]
    site_summary: str


class BusinessContext(BaseModel):
    job_id: str
    place_id: str
    name: str
    address: str
    rating: float | None
    user_rating_count: int | None
    types: list[str]
    price_level: str | None
    regular_opening_hours: dict | None
    editorial_summary: str | None
    website_uri: str | None
    international_phone_number: str | None
    google_maps_uri: str | None
    email: str | None
    reviews: list[Review]
    photos: list[Photo]
    raw_html_bytes: int
    site_distilled: SiteDistilled | None


def _nested(d: dict | None, *keys, default=None):
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
        if cur is None:
            return default
    return cur


async def places_search(http: httpx.AsyncClient, query: str) -> str | None:
    resp = await http.post(
        PLACES_SEARCH_URL,
        headers={
            "X-Goog-Api-Key": PLACES_API_KEY,
            "X-Goog-FieldMask": SEARCH_FIELD_MASK,
            "Content-Type": "application/json",
        },
        json={"textQuery": query},
    )
    if resp.is_error:
        raise HTTPException(status_code=502, detail="places search failed")
    places = resp.json().get("places", [])
    return places[0]["id"] if places else None


async def places_details(http: httpx.AsyncClient, place_id: str) -> dict:
    resp = await http.get(
        PLACES_DETAILS_URL.format(place_id=place_id),
        headers={
            "X-Goog-Api-Key": PLACES_API_KEY,
            "X-Goog-FieldMask": DETAILS_FIELD_MASK,
        },
    )
    if resp.is_error:
        raise HTTPException(status_code=502, detail="places details failed")
    return resp.json()


async def fetch_html(http: httpx.AsyncClient, url: str) -> str:
    try:
        resp = await http.get(url, follow_redirects=True, timeout=10.0)
    except Exception as e:
        logger.warning("website fetch failed for %s: %s", url, e)
        raise HTTPException(status_code=502, detail="website fetch failed") from e
    if resp.is_error:
        logger.warning("website fetch returned %d for %s", resp.status_code, url)
        raise HTTPException(status_code=502, detail="website fetch failed")
    return resp.text


# Try mailto: links first — they're the most reliable signal of a real
# contact address. Plain @-pattern matching is the fallback; filter out
# obvious junk (image/asset references, common placeholder domains).
_MAILTO_RE = re.compile(
    r'href\s*=\s*["\']mailto:([^"\'?\s>]+@[^"\'?\s>]+)', re.IGNORECASE
)
_PLAIN_EMAIL_RE = re.compile(
    r'\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,24}\b', re.IGNORECASE
)
_EMAIL_NOISE = ("@2x.", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp",
                "example.", "sentry.io", "wixpress.com", "your-email")


def _extract_email(html: str) -> str | None:
    m = _MAILTO_RE.search(html)
    if m:
        return m.group(1).strip().lower()
    for match in _PLAIN_EMAIL_RE.finditer(html):
        candidate = match.group(0).lower()
        if any(noise in candidate for noise in _EMAIL_NOISE):
            continue
        return candidate
    return None


async def distill_html(html: str) -> SiteDistilled:
    try:
        response = await asyncio.to_thread(
            gemini.models.generate_content,
            model=GEMINI_MODEL,
            contents=DISTILL_PROMPT + html[:HTML_BYTE_CEILING],
            config={
                "response_mime_type": "application/json",
                "response_schema": SiteDistilled,
            },
        )
    except Exception as e:
        logger.warning("gemini distill failed: %s", e)
        raise HTTPException(status_code=502, detail="site distillation failed") from e
    parsed = response.parsed
    if not isinstance(parsed, SiteDistilled):
        logger.warning("gemini returned non-SiteDistilled output: %r", parsed)
        raise HTTPException(status_code=502, detail="site distillation failed")
    return parsed


def _map_reviews(raw: list[dict] | None) -> list[Review]:
    return [
        Review(
            author=_nested(r, "authorAttribution", "displayName"),
            rating=r.get("rating"),
            text=_nested(r, "text", "text"),
            publish_time=r.get("publishTime"),
        )
        for r in (raw or [])
    ]


def _map_photos(raw: list[dict] | None) -> list[Photo]:
    return [
        Photo(name=p["name"], width_px=p.get("widthPx"), height_px=p.get("heightPx"))
        for p in (raw or [])
        if p.get("name")
    ]


def _upload_context(job_id: str, name: str, data: bytes, content_type: str) -> None:
    get_client().storage.from_(STORAGE_BUCKET).upload(
        f"{job_id}/context/{name}",
        data,
        file_options={"content-type": content_type},
    )


# Slice-1 audit uploads are fire-and-forget — nothing reads raw-html.html
# back, places.json and site-distilled.json are kept in memory and passed
# directly to slice 3. Keeping a strong reference set so tasks don't get
# GC'd mid-flight (asyncio only holds weak refs).
_pending_uploads: set[asyncio.Task] = set()


def _schedule_upload(
    job_id: str, name: str, data: bytes, content_type: str
) -> None:
    async def _run() -> None:
        try:
            await asyncio.to_thread(_upload_context, job_id, name, data, content_type)
        except Exception:
            logger.exception("background upload %s for %s failed", name, job_id)

    task = asyncio.create_task(_run())
    _pending_uploads.add(task)
    task.add_done_callback(_pending_uploads.discard)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/search", response_model=BusinessContext)
async def search(req: SearchRequest) -> BusinessContext:
    job_id = str(ULID())

    async with httpx.AsyncClient(timeout=10.0) as http:
        place_id = await places_search(http, req.query)
        if not place_id:
            raise HTTPException(status_code=404, detail="no results")
        details = await places_details(http, place_id)

        await asyncio.to_thread(
            _upload_context,
            job_id,
            "places.json",
            json.dumps(details, indent=2).encode("utf-8"),
            "application/json",
        )

        website_uri = details.get("websiteUri")
        raw_html: str | None = None
        if website_uri:
            raw_html = await fetch_html(http, website_uri)
            await asyncio.to_thread(
                _upload_context,
                job_id,
                "raw-html.html",
                raw_html.encode("utf-8"),
                "text/html; charset=utf-8",
            )

    site_distilled: SiteDistilled | None = None
    if raw_html:
        site_distilled = await distill_html(raw_html)
        await asyncio.to_thread(
            _upload_context,
            job_id,
            "site-distilled.json",
            site_distilled.model_dump_json(indent=2).encode("utf-8"),
            "application/json",
        )

    email = _extract_email(raw_html) if raw_html else None
    if email:
        await asyncio.to_thread(
            _upload_context,
            job_id,
            "email.txt",
            email.encode("utf-8"),
            "text/plain; charset=utf-8",
        )

    return BusinessContext(
        job_id=job_id,
        place_id=details["id"],
        name=_nested(details, "displayName", "text", default=""),
        address=details.get("formattedAddress", ""),
        rating=details.get("rating"),
        user_rating_count=details.get("userRatingCount"),
        types=details.get("types", []),
        price_level=details.get("priceLevel"),
        regular_opening_hours=details.get("regularOpeningHours"),
        editorial_summary=_nested(details, "editorialSummary", "text"),
        website_uri=website_uri,
        international_phone_number=details.get("internationalPhoneNumber"),
        google_maps_uri=details.get("googleMapsUri"),
        email=email,
        reviews=_map_reviews(details.get("reviews")),
        photos=_map_photos(details.get("photos")),
        raw_html_bytes=len(raw_html.encode("utf-8")) if raw_html else 0,
        site_distilled=site_distilled,
    )


class GenerationRequest(BaseModel):
    job_id: str


class GenerationView(BaseModel):
    job_id: str
    url: str
    created_at: str
    preview_url: str


class GenerationListItem(BaseModel):
    job_id: str
    url: str
    created_at: str


def _row_to_view(row: dict, base_url: str) -> GenerationView:
    # Proxy URL (served by /api/preview) instead of a Supabase signed URL —
    # Supabase Storage coerces text/html to text/plain, breaking iframe render.
    return GenerationView(
        job_id=row["id"],
        url=row["url"],
        created_at=row["created_at"],
        preview_url=f"{base_url}api/preview/{row['id']}",
    )


@app.post("/api/generation")
async def create_generation(req: GenerationRequest) -> dict[str, str]:
    job_id = await asyncio.to_thread(run_generation, req.job_id)
    return {"job_id": job_id}


@app.get("/api/generation/current", response_model=GenerationView)
async def get_current_generation(request: Request) -> GenerationView | Response:
    def _fetch() -> dict | None:
        res = (
            get_client()
            .table("generations")
            .select("id,url,created_at")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        return res.data[0] if res.data else None

    row = await asyncio.to_thread(_fetch)
    if row is None:
        return Response(status_code=204)
    return _row_to_view(row, str(request.base_url))


@app.get("/api/generation/{job_id}", response_model=GenerationView)
async def get_generation(job_id: str, request: Request) -> GenerationView:
    def _fetch() -> dict | None:
        res = (
            get_client()
            .table("generations")
            .select("id,url,created_at")
            .eq("id", job_id)
            .limit(1)
            .execute()
        )
        return res.data[0] if res.data else None

    row = await asyncio.to_thread(_fetch)
    if row is None:
        raise HTTPException(status_code=404, detail="generation not found")
    return _row_to_view(row, str(request.base_url))


WAITING_HTML = b"""<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100vh;width:100vw;background:transparent;
display:grid;place-items:center;overflow:hidden;}
.morph{width:56px;height:56px;background:#FFFDF6;
animation:smoothMorph 3s ease-in-out infinite;}
@keyframes smoothMorph{
0%{transform:scale(1) rotate(0deg);border-radius:50%;}
20%{transform:scale(.9) rotate(72deg);border-radius:35%;}
40%{transform:scale(1.1) rotate(144deg);border-radius:15%;}
60%{transform:scale(.85) rotate(216deg);border-radius:8%;}
80%{transform:scale(1.05) rotate(288deg);border-radius:25%;}
100%{transform:scale(1) rotate(360deg);border-radius:50%;}
}
@media (prefers-reduced-motion:reduce){.morph{animation:none;}}
</style></head><body><div class="morph" aria-hidden></div></body></html>"""


@app.get("/api/preview/{job_id}")
async def get_preview(job_id: str) -> Response:
    """Serve the latest HTML for `job_id` from Storage.

    If nothing's been uploaded yet (builder hasn't written its first
    draft), return a tasteful waiting card so the iframe always has
    *something* to show. The frontend keeps the iframe mounted for the
    whole job — when the builder writes, the next preview fetch picks
    up the new content.
    """
    def _download() -> bytes | None:
        try:
            return get_client().storage.from_(STORAGE_BUCKET).download(
                f"{job_id}/site/index.html"
            )
        except Exception:
            return None

    html = await asyncio.to_thread(_download)
    if html is None:
        return Response(
            content=WAITING_HTML,
            media_type="text/html; charset=utf-8",
            headers={"Cache-Control": "no-store"},
        )
    return Response(
        content=html,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


_PALETTE_META_RE = re.compile(
    r'<meta\s+name=["\']palette["\']\s+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
_HEX_RE = re.compile(r"^#(?:[0-9a-f]{3}|[0-9a-f]{6})$", re.IGNORECASE)


def _extract_palette(html: str) -> list[str]:
    m = _PALETTE_META_RE.search(html)
    if not m:
        return []
    return [t.strip() for t in m.group(1).split(",") if _HEX_RE.match(t.strip())][:3]


_ASSET_CONTENT_TYPES = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
}


@app.get("/api/asset/{job_id}/{name}")
async def get_asset(job_id: str, name: str) -> Response:
    if "/" in name or ".." in name:
        raise HTTPException(status_code=400, detail="invalid asset name")
    content_type = _ASSET_CONTENT_TYPES.get(
        Path(name).suffix.lower(), "application/octet-stream"
    )

    def _download() -> bytes:
        return get_client().storage.from_(STORAGE_BUCKET).download(
            f"{job_id}/site/assets/{name}"
        )

    try:
        data = await asyncio.to_thread(_download)
    except Exception as e:
        logger.warning("asset download failed for %s/%s: %s", job_id, name, e)
        raise HTTPException(status_code=404, detail="asset not found") from e
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/api/context/{job_id}", response_model=BusinessContext)
async def get_context(job_id: str) -> BusinessContext:
    """Reconstruct the slice-1 BusinessContext for an existing job_id.

    Reads `places.json` + `site-distilled.json` from Storage and returns
    the same shape `/api/search` does. Lets the sandbox surface rich
    editorial data (rating, reviews, type, address, maps link) after the
    fact, without re-running the Places lookup.
    """

    def _download(name: str) -> bytes | None:
        try:
            return get_client().storage.from_(STORAGE_BUCKET).download(
                f"{job_id}/context/{name}"
            )
        except Exception:
            return None

    places_bytes = await asyncio.to_thread(_download, "places.json")
    if places_bytes is None:
        raise HTTPException(status_code=404, detail="context not found")
    details = json.loads(places_bytes)

    distilled_bytes = await asyncio.to_thread(_download, "site-distilled.json")
    site_distilled: SiteDistilled | None = None
    if distilled_bytes:
        try:
            site_distilled = SiteDistilled.model_validate_json(distilled_bytes)
        except Exception:
            logger.exception("site-distilled.json parse failed for %s", job_id)

    email_bytes = await asyncio.to_thread(_download, "email.txt")
    email = email_bytes.decode("utf-8", errors="replace").strip() if email_bytes else None

    return BusinessContext(
        job_id=job_id,
        place_id=details.get("id", ""),
        name=_nested(details, "displayName", "text", default=""),
        address=details.get("formattedAddress", ""),
        rating=details.get("rating"),
        user_rating_count=details.get("userRatingCount"),
        types=details.get("types", []),
        price_level=details.get("priceLevel"),
        regular_opening_hours=details.get("regularOpeningHours"),
        editorial_summary=_nested(details, "editorialSummary", "text"),
        website_uri=details.get("websiteUri"),
        international_phone_number=details.get("internationalPhoneNumber"),
        google_maps_uri=details.get("googleMapsUri"),
        email=email,
        reviews=_map_reviews(details.get("reviews")),
        photos=_map_photos(details.get("photos")),
        raw_html_bytes=0,
        site_distilled=site_distilled,
    )


@app.get("/api/generation/{job_id}/palette")
async def get_palette(job_id: str) -> dict[str, list[str]]:
    def _download() -> bytes:
        return get_client().storage.from_(STORAGE_BUCKET).download(
            f"{job_id}/site/index.html"
        )

    try:
        html_bytes = await asyncio.to_thread(_download)
    except Exception as e:
        logger.warning("palette download failed for %s: %s", job_id, e)
        raise HTTPException(status_code=404, detail="palette not found") from e
    return {"palette": _extract_palette(html_bytes.decode("utf-8", errors="replace"))}


@app.get("/api/generations", response_model=list[GenerationListItem])
async def list_generations(limit: int = 20) -> list[GenerationListItem]:
    limit = max(1, min(limit, 100))

    def _fetch() -> list[dict]:
        res = (
            get_client()
            .table("generations")
            .select("id,url,created_at")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return res.data or []

    rows = await asyncio.to_thread(_fetch)
    return [
        GenerationListItem(job_id=r["id"], url=r["url"], created_at=r["created_at"])
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Live generation: POST /api/jobs spawns a background pipeline, SSE streams
# events to the sandbox. Errors are caught silently — the user never sees
# them; if everything fails the stream emits a single `timeout` event.
# ---------------------------------------------------------------------------


# Total wall-clock budget for the whole pipeline (slice 1 + prompter + builder
# + grace for uploads). Anything past this and we give up and emit timeout.
PIPELINE_TIMEOUT_S = PROMPTER_TIMEOUT_S + BUILDER_TIMEOUT_S + 30


async def _run_slice_one_streaming(
    job: jobs.Job, query: str
) -> dict | None:
    """Run slice 1 (Places + HTML + Gemini distill), emit a `context` event,
    and return the compacted context dict ready for the builder.

    Audit uploads (places.json, raw-html.html, site-distilled.json) are
    scheduled as background tasks — slice 3 reads its input from the
    dict we return, not from Storage. Returns None on a fatal failure
    (no Places result, Places API down). Website-fetch and distill
    failures are non-fatal — we proceed without them.
    """
    distilled_obj: SiteDistilled | None = None
    try:
        async with httpx.AsyncClient(timeout=10.0) as http:
            place_id = await places_search(http, query)
            if not place_id:
                logger.info("no places result for query=%r", query)
                return None
            details = await places_details(http, place_id)

            _schedule_upload(
                job.job_id,
                "places.json",
                json.dumps(details, indent=2).encode("utf-8"),
                "application/json",
            )

            website_uri = details.get("websiteUri")
            raw_html: str | None = None
            if website_uri:
                try:
                    raw_html = await fetch_html(http, website_uri)
                    _schedule_upload(
                        job.job_id,
                        "raw-html.html",
                        raw_html.encode("utf-8"),
                        "text/html; charset=utf-8",
                    )
                except HTTPException:
                    pass  # website fetch failure is non-fatal
    except HTTPException as e:
        logger.warning("slice 1 places failed: %s", e.detail)
        return None
    except Exception:
        logger.exception("slice 1 unexpected failure for %s", job.job_id)
        return None

    if raw_html:
        try:
            distilled_obj = await distill_html(raw_html)
            _schedule_upload(
                job.job_id,
                "site-distilled.json",
                distilled_obj.model_dump_json(indent=2).encode("utf-8"),
                "application/json",
            )
        except Exception:
            logger.exception("distill failed for %s", job.job_id)

        email = _extract_email(raw_html)
        if email:
            _schedule_upload(
                job.job_id,
                "email.txt",
                email.encode("utf-8"),
                "text/plain; charset=utf-8",
            )

    display_name = _nested(details, "displayName", "text", default=query)
    jobs.emit(job, {"event": "context", "name": display_name})

    distilled_dict = distilled_obj.model_dump() if distilled_obj else {}
    return compact_context(details, distilled_dict)


async def run_pipeline_streaming(job: jobs.Job, query: str) -> None:
    """Background task: slice 1 → prompter → streaming builder.

    Every failure is logged and swallowed; the only user-visible outcomes
    are `context` / `draft` / `ready` / `timeout` events on the SSE
    stream. Never raises.
    """
    try:
        # No primer emit here — the landing page holds the spinning border
        # until slice 1's real `context` event arrives. Emitting an early
        # placeholder would cause the landing to navigate before ingestion
        # finishes, defeating the wait.
        context = await _run_slice_one_streaming(job, query)
        if context is None:
            jobs.emit(job, {"event": "timeout"})
            return

        async def on_draft(revision: int) -> None:
            jobs.emit(job, {"event": "draft", "revision": revision})

        final_rev = await asyncio.wait_for(
            run_slice_three_streaming(job.job_id, context, on_draft),
            timeout=PIPELINE_TIMEOUT_S,
        )
        if final_rev is None:
            jobs.emit(job, {"event": "timeout"})
            return
        jobs.emit(job, {"event": "ready", "revision": final_rev})
    except asyncio.TimeoutError:
        logger.warning("pipeline timed out for %s", job.job_id)
        jobs.emit(job, {"event": "timeout"})
    except Exception:
        logger.exception("pipeline failed for %s", job.job_id)
        jobs.emit(job, {"event": "timeout"})


@app.post("/api/jobs")
async def create_job(req: SearchRequest) -> dict[str, str]:
    """Spawn the live generation pipeline. Returns immediately."""
    job = jobs.create_job()
    asyncio.create_task(run_pipeline_streaming(job, req.query.strip()))
    return {"job_id": job.job_id}


@app.get("/api/jobs/{job_id}/events")
async def stream_job_events(job_id: str) -> StreamingResponse:
    """SSE stream of generation events for a job.

    If `job_id` is unknown (server restart, typo), we emit a single
    `timeout` event and close — keeps the frontend's UX consistent
    instead of leaving it hanging on a 404 reconnect loop.
    """
    job = jobs.get_job(job_id)
    if job is None:
        async def missing():
            yield f"data: {json.dumps({'event': 'timeout'})}\n\n"
        return StreamingResponse(missing(), media_type="text/event-stream")
    return StreamingResponse(
        jobs.sse_stream(job),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable proxy buffering
        },
    )
