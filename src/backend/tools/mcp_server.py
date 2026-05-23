"""Builder tool MCP server (stdio).

Spawned by `agy` during a build via the global MCP registry at
`~/.gemini/antigravity-cli/mcp_config.json`. Exposes tools that produce
embeddable assets — each tool generates an artifact in memory, uploads
it to `<JOB_ID>/site/assets/<ulid>.<ext>` in Supabase Storage, and
returns the proxy URL the agent embeds in HTML.

Per-build context (JOB_ID, BUILD_DIR, BACKEND_BASE_URL) flows from the
FastAPI generation subprocess into agy's env, then through the
`tools/agy_mcp_wrapper.sh` launcher into this process's env. Supabase /
Places / Gemini creds come from `.env` sourced inside the wrapper (kept
out of agy's own env to avoid GCP keyring auth collisions).

Adding a future tool: write a pure function that takes args and returns
bytes; wrap it with @mcp.tool() and call _upload_asset to publish.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP, Image
from ulid import ULID

from supabase_client import get_client
from tools.images import make_image
from tools.photos import fetch_place_photo
from tools.qr import make_qr_svg
from tools.screenshot import capture as capture_screenshot
from tools.validate import validate_card_html

BUCKET = "generations"

mcp = FastMCP("assets")


def _upload_asset(data: bytes, ext: str, content_type: str) -> str:
    job_id = os.environ["JOB_ID"]
    base_url = os.environ.get("BACKEND_BASE_URL", "http://localhost:8000").rstrip("/")
    name = f"{ULID()}.{ext}"
    path = f"{job_id}/site/assets/{name}"
    get_client().storage.from_(BUCKET).upload(
        path,
        data,
        file_options={"content-type": content_type, "cache-control": "public, max-age=3600"},
    )
    return f"{base_url}/api/asset/{job_id}/{name}"


@mcp.tool()
def qr_code(text: str) -> str:
    """Generate a QR code for the given text or URL.

    Returns a URL to an SVG image. Embed via `<img src="URL">`.
    """
    return _upload_asset(make_qr_svg(text), "svg", "image/svg+xml")


@mcp.tool()
def place_photo(index: int = 0) -> str:
    """Pull a real photo of the business from Google Places by index.

    The brief lists `photos_available` so you know the valid range
    (0 to photos_available-1). Index 0 is usually the primary photo —
    often the exterior or a signature dish.

    Returns a URL to a JPEG. Embed via `<img src="URL">`. Prefer this
    over generated imagery — the photos are authentic to the actual
    venue.
    """
    job_id = os.environ["JOB_ID"]
    raw = get_client().storage.from_(BUCKET).download(
        f"{job_id}/context/places.json"
    )
    photos = json.loads(raw).get("photos", [])
    if not photos:
        raise RuntimeError("no photos available for this business")
    if index < 0 or index >= len(photos):
        raise RuntimeError(
            f"index {index} out of range (have {len(photos)} photos)"
        )
    data, content_type = fetch_place_photo(photos[index]["name"])
    ext = "jpg" if "jpeg" in content_type else content_type.split("/")[-1]
    return _upload_asset(data, ext, content_type)


@mcp.tool()
def generate_image(prompt: str, aspect_ratio: str = "1:1") -> str:
    """Generate an image from a text prompt via Imagen.

    aspect_ratio: one of '1:1', '3:4', '4:3', '9:16', '16:9'.
    Returns a URL to a PNG. Embed via `<img src="URL">`.

    DEPRECATED for now: prefer `place_photo()` which returns real
    photography of the business. This tool is intentionally NOT in the
    builder's allowlist; left here for future re-enablement.
    """
    return _upload_asset(make_image(prompt, aspect_ratio), "png", "image/png")


@mcp.tool()
def screenshot_card() -> Image:
    """Render the current `./index.html` and return a 1920x1080 PNG.

    Use ONCE after editing to visually inspect the card — overflowing
    text, overlapping elements, broken alignment that the lint cannot
    catch. Always full frame, no cropping. Do not call repeatedly in a
    loop; one screenshot per fix attempt is the limit.
    """
    build_dir = Path(os.environ["BUILD_DIR"])
    path = build_dir / "index.html"
    if not path.exists():
        raise RuntimeError("index.html does not exist yet — Write it first.")
    return Image(data=capture_screenshot(path), format="png")


@mcp.tool()
def validate_card() -> str:
    """Lint the `./index.html` file in the build directory.

    Takes no arguments — reads the file the builder just wrote directly
    from disk, so you don't have to round-trip the HTML through the
    conversation.

    Checks: palette meta present + 3 hex codes, no off-palette colors,
    `overflow: hidden` + viewport units (no scrolling), no <script>,
    no external stylesheets, bg/fg contrast ≥ 4.5 (WCAG AA).

    Returns 'OK: no issues.' when clean, otherwise one issue per line.
    """
    build_dir = Path(os.environ["BUILD_DIR"])
    path = build_dir / "index.html"
    if not path.exists():
        return "ERROR: index.html does not exist yet — Write it first."
    return validate_card_html(path.read_text())


if __name__ == "__main__":
    mcp.run()
