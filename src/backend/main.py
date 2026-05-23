import asyncio
import json
import logging
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from pydantic import BaseModel
from ulid import ULID

from generation import run_generation, signed_preview_url
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
WORKSPACE_DIR = REPO_ROOT / "workspace"
HTML_BYTE_CEILING = 200_000

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

        job_dir = WORKSPACE_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "places.json").write_text(json.dumps(details, indent=2))

        website_uri = details.get("websiteUri")
        raw_html: str | None = None
        if website_uri:
            raw_html = await fetch_html(http, website_uri)
            (job_dir / "raw-html.html").write_text(raw_html)

    site_distilled: SiteDistilled | None = None
    if raw_html:
        site_distilled = await distill_html(raw_html)
        (job_dir / "site-distilled.json").write_text(
            site_distilled.model_dump_json(indent=2)
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
        reviews=_map_reviews(details.get("reviews")),
        photos=_map_photos(details.get("photos")),
        raw_html_bytes=len(raw_html.encode("utf-8")) if raw_html else 0,
        site_distilled=site_distilled,
    )


class GenerationRequest(BaseModel):
    url: str


class GenerationView(BaseModel):
    job_id: str
    url: str
    created_at: str
    preview_url: str


class GenerationListItem(BaseModel):
    job_id: str
    url: str
    created_at: str


def _row_to_view(row: dict) -> GenerationView:
    return GenerationView(
        job_id=row["id"],
        url=row["url"],
        created_at=row["created_at"],
        preview_url=signed_preview_url(row["id"]),
    )


@app.post("/api/generation")
async def create_generation(req: GenerationRequest) -> dict[str, str]:
    job_id = await asyncio.to_thread(run_generation, req.url)
    return {"job_id": job_id}


@app.get("/api/generation/current", response_model=GenerationView)
async def get_current_generation() -> GenerationView | Response:
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
    return await asyncio.to_thread(_row_to_view, row)


@app.get("/api/generation/{job_id}", response_model=GenerationView)
async def get_generation(job_id: str) -> GenerationView:
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
    return await asyncio.to_thread(_row_to_view, row)


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
