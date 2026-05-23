# Project

A self-generating digital business card. User pastes a URL, the app generates a one-off micro-site that reflects that brand's identity through generated assets (palette, type, imagery, copy, etc.).

The full system has multiple parts:

- **Slice 1 — Ingestion (this build):** URL → `brief.json`
- **Slice 2 — Generation:** two-agent CLI pipeline (prompter + builder) that consumes `brief.json` and emits a site bundle
- **Slice 3+ —** Playground UI, history, sharing, etc.

**Do not build slice 2 or later. Build only slice 1.** Design slice 1 so its output (`brief.json`) is the sole contract slice 2 will consume.

# Scope of this build (slice 1)

Take a URL. Return a structured `brief.json` describing the brand. That's it.

## Pipeline

```
input: url
```

1. **Fetch the URL**
   - Plain HTTP via `httpx`
   - Save raw HTML to workspace

2. **Google Places API (New) lookup**
   - `POST https://places.googleapis.com/v1/places:searchText` with `textQuery = business name + locality`
   - Take first result → `place_id`
   - `GET https://places.googleapis.com/v1/places/{place_id}` with field mask covering: `displayName`, `rating`, `userRatingCount`, `reviews`, `formattedAddress`, `regularOpeningHours`, `priceLevel`, `types`, `editorialSummary`, `websiteUri`, `photos`
   - Reviews are capped at 5 by the API; that is expected
   - Save raw response to workspace as `places.json`

3. **LLM call (Claude via API)**
   - Input: raw page text + Places response + reviews
   - Output: `brief.json`, schema-constrained
   - Use tool use / structured output to enforce the schema

```
output: workspace/<job_id>/ containing:
  - brief.json        (the contract)
  - raw-html.html     (audit trail)
  - places.json       (audit trail)
```

## `brief.json` schema

```json
{
  "name": "string",
  "url": "string",
  "category": "string",
  "location": "string | null",
  "tagline": "string | null",
  "description": "string",
  "vibe_tags": ["string"],
  "tone": "string",
  "key_phrases": ["string"],
  "visual_cues": ["string"],
  "brand_image_path": "string | null",
  "reviews_summary": "string | null"
}
```

Missing source data → set to `null`. The LLM infers vibe, tone, visual cues from whatever signal is present.

# Tech choices

- **Language:** Python 3.11+, managed with `uv`
- **HTTP fetch:** `httpx`
- **LLM:** Google AI Studio, `gemini-3.5-flash`, structured output via Pydantic `response_schema`
- **Storage:** local filesystem, one directory per job, keyed by ULID

FastAPI backend in `src/backend/` exposes `POST /search {"query": str}`. Next.js frontend in `src/frontend/` posts the query and renders the result. Entry is query-based (e.g. "Seu Pizza Lisboa") rather than URL-based — Places provides the `websiteUri` which the backend then fetches.

Each `/search` call writes to `./workspace/<job_id>/`, keyed by ULID.

# Configuration

Environment variables (`.env`, loaded via `python-dotenv`):

- `PLACES_API`
- `GEMINI_API_KEY`

Fail loudly at startup if any is missing.

# Constraints

- **Determinism:** Same URL should produce a near-identical brief. Set LLM temperature low (0.2). No randomness in scraping/parsing logic.
- **Graceful degradation:** Any step except step 3 may produce partial data. Step 3's LLM call must handle nulls everywhere.
- **No shared state across runs:** Each job gets its own workspace directory. Never read from another job's workspace.
- **Idempotency:** If a workspace already exists with completed `brief.json`, re-running the same `job_id` is a no-op (return the existing brief).

# Acceptance criteria

- `python ingest.py https://seupizza.com` completes without errors
- Workspace contains all three artifacts
- `brief.json` matches the schema
- Re-running with the same `job_id` returns immediately
- Running against a URL with no Places match produces a valid `brief.json` with `location: null`, `reviews_summary: null`
