# Project

A self-generating digital business card. User types a business name; the app produces a one-off micro-site that reflects that brand's identity (palette, type, copy, imagery).

Single-user app for now — no auth, no concurrency, no multi-tenancy.

## Slices

| Slice | Status | What |
| --- | --- | --- |
| 1. Context enrichment | building | name → Places lookup + website fetch + Gemini distillation → `BusinessContext`; artifacts uploaded to Supabase Storage |
| 2. Sandbox + generation API | done | DB schema, Storage layout, `/api/generation*` routes, `/sandbox` page that iframes the rendered card |
| 3. Two-CLI builder | building | `run_generation` shells out to a prompter Claude + a builder Claude that produce the real `index.html` |
| 4+. Polish | not started | history list UI, sharing, etc. |

## Repo layout

```
src/backend/      FastAPI app (uv-managed, Python 3.12)
src/frontend/     Next.js 16 app (bun-managed)
supabase/         migrations + config.toml; project is hosted, CLI is linked
```

`job_id` is a ULID minted by `POST /api/search`. It keys the `generations` row + all Storage prefixes (`<job_id>/context/` for slice-1 artifacts, `<job_id>/site/` for the rendered card). Nothing about a job persists on local disk.

## Dev commands

Supabase is **hosted** (no local Docker stack). The project ref lives in `supabase/.temp/project-ref`; the CLI is already linked.

```bash
# Schema changes — apply to hosted DB
supabase migration new <name>                   # scaffold a new SQL file
# ...edit the SQL...
SUPABASE_DB_PASSWORD=<db-pw> supabase db push   # apply pending migrations

# Backend
cd src/backend && uv sync                       # install deps
cd src/backend && uv run uvicorn main:app --reload   # serve on :8000

# Frontend
cd src/frontend && bun install
cd src/frontend && bun dev                      # serve on :3000
```

Schema state on hosted is canonical. `supabase db pull` if you need to introspect remote. There is no `supabase db reset` workflow against hosted — destructive.

## Environment

`.env` at the repo root (loaded by `python-dotenv` from `src/backend/main.py`):

- `PLACES_API` — Google Places API (New) key
- `GEMINI_API_KEY` — Google AI Studio key (slice 1 distillation)
- `SUPABASE_URL` — hosted project URL (`https://<ref>.supabase.co`); from Dashboard → Settings → API
- `SUPABASE_SERVICE_ROLE_KEY` — secret key (`sb_secret_…`); service role bypasses RLS, backend-only, never ship to the frontend

Backend fails fast if `PLACES_API` or `GEMINI_API_KEY` is missing. Supabase env is lazy — only fails when a Supabase-touching route is hit without it.

## Backend

`src/backend/main.py` routes:
- `GET /health`
- `POST /api/search {query}` → `BusinessContext`. Places lookup + site fetch + Gemini distillation. Uploads `places.json`, `raw-html.html`, `site-distilled.json` to Storage at `<job_id>/context/`.
- `POST /api/generation {job_id}` → `{job_id}`. Downloads slice-1 context from Storage, runs the two-CLI builder in a tempdir, uploads `<job_id>/site/index.html`, inserts the row.
- `GET /api/generation/current` → latest row + 1-hour signed `preview_url`, or 204.
- `GET /api/generation/{job_id}` → same shape for any past row, or 404.
- `GET /api/generations?limit=N` → list newest first.

`src/backend/generation.py` owns the two-CLI subprocess plumbing. The builder writes to a `tempfile.TemporaryDirectory()`; the HTML is read out before the dir is cleaned up.

The Supabase Python client is sync — wrap calls in `asyncio.to_thread` (see existing patterns in `main.py`).

CORS is open to `http://localhost:3000` only.

## Frontend

Next.js 16 + React 19 + Tailwind 4 + bun. See `src/frontend/AGENTS.md` for the "read the bundled docs first" rule. Routes:

- `/` — search form, calls `/api/search`, then `router.push('/sandbox?job_id=<id>')`
- `/sandbox` — server page unwraps `?job_id=`, hands it to `SandboxClient`; client island fetches `/api/generation/current`, auto-triggers a generation if `?job_id=` is present, full-bleed iframes the `preview_url` with `sandbox="allow-scripts"`

## Data model

`public.generations`: `id text pk, url text, created_at timestamptz`. RLS enabled with no policies — backend uses the service-role key. Rows are immutable; "current" = latest row. Past rows stay addressable by `job_id`.

Storage bucket `generations` (private). Keys:
- `<job_id>/context/places.json` — slice 1
- `<job_id>/context/raw-html.html` — slice 1 (audit trail; nothing reads it back yet)
- `<job_id>/context/site-distilled.json` — slice 1
- `<job_id>/site/index.html` — slice 3 (the rendered card)

## Gotchas

- **Two LLMs in play.** Slice 1 uses Gemini for distillation; slice 3 uses Claude for the two-CLI builder. Don't unify them — they serve different roles.
- **No local state per job.** Everything keyed to a `job_id` lives in Supabase. The builder's working dir is a `tempfile.TemporaryDirectory()`, cleaned up after upload. Don't reintroduce `./workspace/`.
- **The iframe expects single-file HTML.** When the builder emits multi-file bundles, we'll either flip the bucket to public-read or add a backend proxy route.
- **Don't add `status` / `retracted` / `is_current` columns to `generations`.** "Current" is a query; rows are immutable. Deliberate.
- **Next.js 16 isn't your training data.** Frontend changes must consult `src/frontend/node_modules/next/dist/docs/`.
