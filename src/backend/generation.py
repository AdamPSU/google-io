"""Slice 2: sandbox generation pipeline (stub).

`run_generation` is the seam where the future two-CLI Claude Code pipeline
(prompter + builder) will plug in. For now it just uploads a hardcoded
placeholder HTML to Storage and inserts a row. Each generation gets its
own immutable ULID job_id; nothing is ever overwritten.
"""

from __future__ import annotations

from ulid import ULID

from supabase_client import get_client

BUCKET = "generations"
SITE_KEY = "{job_id}/site/index.html"
SIGNED_URL_TTL_SECONDS = 60 * 60  # 1 hour

STUB_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>generated card</title>
<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; background: #18181b; color: #fafafa; }
  main { text-align: center; padding: 2rem; }
  h1 { font-size: 2rem; margin: 0 0 0.5rem; font-weight: 600; }
  p { color: #a1a1aa; margin: 0; }
  code { font-family: ui-monospace, monospace; color: #fafafa; }
</style>
</head>
<body>
<main>
  <h1>generated card placeholder</h1>
  <p>the two-CLI builder will replace this with a real site.</p>
  <p>source: <code>{url}</code></p>
</main>
</body>
</html>
"""


def run_generation(url: str) -> str:
    """Generate a card for `url`. Returns the new job_id.

    Order: upload first, then insert. The DB row is the commit point —
    if the upload fails we never claim the generation exists. If the row
    insert fails after a successful upload the orphan object is harmless
    (no row points at it) and gets ignored by /current.
    """
    job_id = str(ULID())
    client = get_client()

    html = STUB_HTML.format(url=url).encode("utf-8")
    path = SITE_KEY.format(job_id=job_id)
    client.storage.from_(BUCKET).upload(
        path,
        html,
        file_options={"content-type": "text/html", "cache-control": "no-store"},
    )

    client.table("generations").insert({"id": job_id, "url": url}).execute()
    return job_id


def signed_preview_url(job_id: str) -> str:
    path = SITE_KEY.format(job_id=job_id)
    res = get_client().storage.from_(BUCKET).create_signed_url(
        path, SIGNED_URL_TTL_SECONDS
    )
    return res["signedURL"]
