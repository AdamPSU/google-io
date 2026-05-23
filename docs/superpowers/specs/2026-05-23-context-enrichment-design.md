# Context Enrichment (Spec A)

**Date:** 2026-05-23
**Status:** Draft for review
**Predecessor:** MVP `/search` endpoint (Places `searchText`, returns `{place_id, name, address}`)

## Context

The product is a self-generating digital business card: paste/pick a business → app generates a one-off micro-site reflecting brand identity. Everything downstream of "pick a business" depends on having rich context about that business. We're in the **context-building phase**.

The MVP `/search` proves we can locate a business, but a single call to Places `searchText` with a narrow field mask is far too thin to feed any generator — it gives us only the place ID, display name, and formatted address.

This spec defines the full context-building pipeline that replaces the MVP `/search`:

1. **Tier 1** — full Places details (reviews, photos, hours, types, price, editorial summary, website URI, contact)
2. **Tier 2** — fetch raw HTML of the business's own website *and* distill it via Gemini into structured signal

Tier 3 (Instagram, menu, press) is explicitly **out of scope** — not deferred, dropped.
Tier 4 (derived signals like color palette / sentiment) is also out of scope.

Tier 1 and Tier 2 are tightly coupled: Places returns the `websiteUri` that Tier 2 fetches. They are one slice.

### Decisions locked in

- **Backend-only.** Frontend stays as-is; it'll ignore the new response fields.
- **Synchronous endpoint.** No queue. Budget ~5–10s per call (two Places calls + HTML fetch + Gemini call).
- **No photo bytes downloaded.** Places photo `media` requires API-key auth; store metadata only and defer byte fetch to a generation slice.
- **Python deps via `uv`.**
- **LLM:** Gemini `gemini-3.5-flash` via Google AI Studio, using the official `google-genai` SDK with **Pydantic-based structured output** (BaseModel as `response_schema`).

---

## Design

### Pipeline (single request, synchronous)

`POST /search {"query": str}`:

1. Generate ULID → `job_id`.
2. `mkdir workspace/{job_id}/` at repo root.
3. `places:searchText` (narrow mask, just `places.id`) → first `place_id`. If `places` is empty → `404`, no workspace persisted.
4. `places:get/{place_id}` with **full field mask** → details JSON.
5. Write `workspace/{job_id}/places.json` (raw response, pretty-printed).
6. If details has `websiteUri`:
   - `httpx.get(websiteUri, follow_redirects=True, timeout=10s)`
   - On 2xx: write `workspace/{job_id}/raw-html.html`. Continue to step 7.
   - On any failure: `502 {"detail":"website fetch failed"}`. (No fallthrough.)
7. If we have raw HTML, distill it via Gemini → `SiteDistilled`. Write `workspace/{job_id}/site-distilled.json`. On any failure (exception, non-conforming output): `502 {"detail":"site distillation failed"}`.
8. Return the business context JSON inline (including `site_distilled`).

### Places field mask (Tier 1)

```
id,displayName,formattedAddress,rating,userRatingCount,reviews,
regularOpeningHours,priceLevel,types,editorialSummary,
websiteUri,photos,internationalPhoneNumber,googleMapsUri
```

### Gemini distillation (Tier 2)

**Input:** the fetched raw HTML, truncated to a safe ceiling (e.g. ~200 KB / ~50k chars) before sending. No parsing — just feed the bytes.

**Prompt (system + user, drafted in implementation):**
> You receive the raw HTML of a small business's homepage. Extract concise, structured signal that captures *how the business communicates* — tagline, value props, voice, vibe, visual cues referenced in the copy. Do not invent details. If a field cannot be supported by the HTML, leave it empty or use a generic value.

**Output schema (`SiteDistilled` BaseModel):**

```python
class SiteDistilled(BaseModel):
    tagline: str | None         # short hero line if present
    description: str             # 1-2 sentence what-they-do
    tone: str                    # e.g. "warm", "minimalist", "punky"
    vibe_tags: list[str]         # short adjectival tags
    key_phrases: list[str]       # verbatim phrases that capture brand voice
    visual_cues: list[str]       # imagery / color cues mentioned in copy
    site_summary: str            # 1-paragraph natural-language summary
```

This is the "structured fields + blob" shape — structured fields for downstream consumers, `site_summary` for human/audit review.

**Wiring:** `google-genai` SDK, passing the Pydantic class as `response_schema` with `response_mime_type="application/json"`. The SDK returns a parsed instance via `response.parsed`.

### Response shape (`/search`)

```json
{
  "job_id": "01HX...",
  "place_id": "ChIJ...",
  "name": "string",
  "address": "string",
  "rating": 4.5,
  "user_rating_count": 123,
  "types": ["pizza_restaurant", "restaurant"],
  "price_level": "PRICE_LEVEL_MODERATE",
  "regular_opening_hours": { /* Google's shape */ },
  "editorial_summary": "string",
  "website_uri": "https://...",
  "international_phone_number": "+...",
  "google_maps_uri": "https://maps.google.com/...",
  "reviews": [
    { "author": "string", "rating": 5, "text": "string", "publish_time": "ISO8601" }
  ],
  "photos": [
    { "name": "places/{id}/photos/{ref}", "width_px": 4032, "height_px": 3024 }
  ],
  "raw_html_bytes": 12345,
  "site_distilled": {
    "tagline": "string | null",
    "description": "string",
    "tone": "string",
    "vibe_tags": ["..."],
    "key_phrases": ["..."],
    "visual_cues": ["..."],
    "site_summary": "string"
  }
}
```

All scalar Places fields default to `null` if absent. Arrays default to `[]`. `raw_html_bytes` is `0` when no fetch happened. `site_distilled` is `null` when there was no HTML to distill OR the Gemini call failed.

### Storage layout

```
workspace/
  {ulid}/
    places.json         # raw places:get response
    raw-html.html       # raw bytes from websiteUri (absent on failure)
    site-distilled.json # SiteDistilled output (absent if no raw HTML)
```

- `workspace/` at repo root.
- Added to `.gitignore`.
- Each job is independent — no cross-job state.

### Error handling

| Failure | Behavior |
|---|---|
| `searchText` returns empty | `404 {"detail":"no results"}`. No workspace. |
| `searchText` HTTP error | `502 {"detail":"places search failed"}`. |
| `places:get` HTTP error | `502 {"detail":"places details failed"}`. |
| Missing `websiteUri` in details | **One allowed degradation.** Skip fetch + distill. `raw_html_bytes: 0`, `site_distilled: null`. |
| `httpx.get(websiteUri)` failure | `502 {"detail":"website fetch failed"}`. |
| Gemini call fails or returns non-conforming output | `502 {"detail":"site distillation failed"}`. |

The context is either complete (Places + optional site signal if a website exists and both steps succeed) or the request fails outright. The only acceptable partial context is the "no website at all" case — that's a missing input at the source, not a broken pipeline. Failed jobs leave behind partial `workspace/{job_id}/` dirs for debugging.

### Dependencies

- `uv add python-ulid` — ULID job IDs
- `uv add google-genai` — Gemini SDK
- `httpx`, `fastapi`, `pydantic`, `python-dotenv` already present

### Env vars

| Var | Required | Source |
|---|---|---|
| `PLACES_API` | yes | Already in `.env` |
| `GEMINI_API_KEY` | yes | **New** — user adds to `.env` from Google AI Studio |

Fail loudly at module import if either is missing (existing pattern for `PLACES_API`).

### File changes

| File | Change |
|---|---|
| `src/backend/main.py` | Rewrite `/search`: ULID, two Places calls, conditional HTML fetch, Gemini distill, file writes, richer response model. |
| `src/backend/pyproject.toml` + `uv.lock` | `uv add python-ulid google-genai` |
| `.gitignore` | Add `workspace/` |
| `.env` | User adds `GEMINI_API_KEY=...` |
| `CLAUDE.md` | Reconcile with reality — drop the "No web server in this slice. No frontend. CLI only: `python ingest.py <url>`" block. Replace with the actual surface: FastAPI `/search` endpoint, Next.js frontend, query-driven entry instead of URL-driven. Add `GEMINI_API_KEY` to the env vars list. |

**No frontend changes.** Existing frontend ignores extra response fields.

### Modularity

Estimated final `main.py`: ~200 lines. Acceptable per CLAUDE.md ("keep files in the hundreds of lines, not thousands"). If it grows past ~250, split into `schemas.py` (Pydantic models), `distill.py` (Gemini call + prompt), `places.py` (two Places calls). Don't preempt.

### Out of scope (explicit)

- **Tier 3** (Instagram, menu, press) — dropped, not deferred.
- **Tier 4** derived signals (palette extraction, sentiment) — dropped.
- **Frontend context-display UI** — deferred.
- **Photo byte download** — deferred until generation slice.
- **`brief.json` schema population from all sources** — deferred. `SiteDistilled` is the from-HTML subset; the unified `brief.json` belongs to a later spec when the generator is being built.
- **Async / job queue / status endpoint** — YAGNI at current latency.
- **Caching / idempotency by query hash** — every call creates a fresh ULID. CLAUDE.md's "re-running same `job_id` returns immediately" rule applies only when an *explicit* job_id is reused, which we don't expose yet.

### Verification

1. `uv add python-ulid google-genai`; user adds `GEMINI_API_KEY` to `.env`; restart uvicorn.
2. `curl -sS -X POST http://localhost:8000/search -H 'Content-Type: application/json' -d '{"query":"Seu Pizza Lisboa"}' | jq` — response includes `job_id`, `reviews[]`, `photos[]`, `website_uri`, `site_distilled.tone`, etc.
3. `ls workspace/{job_id}/` — three artifacts present (or two if site failed, or one if no website).
4. `jq . workspace/{job_id}/site-distilled.json` — valid SiteDistilled object.
5. Junk query → `404`, no workspace dir.
6. Two back-to-back queries → two distinct ULID dirs.
7. Business with no website → `website_uri: null`, `raw_html_bytes: 0`, `site_distilled: null`, only `places.json` on disk.
8. Sabotage test: point a known good `websiteUri` to a deliberately broken URL (or 502-ing site) → `502 {"detail":"website fetch failed"}`.
9. Sabotage test: set `GEMINI_API_KEY=invalid_xxx` and rerun a good query → `502 {"detail":"site distillation failed"}`. `places.json` + `raw-html.html` still present on disk for debugging.
