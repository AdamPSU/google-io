"""Screenshot the in-progress card via headless Chromium.

Pure function — no orchestration, no MCP. The MCP wrapper in
mcp_server.py handles tool registration and constrains usage to one
shot per check via the prompt.

The browser is launched once per MCP-server process (one build) and
reused across calls. First screenshot pays ~1.5s of Chromium startup;
subsequent screenshots ~400-600ms.

Fixed render size: 1920×1080. No cropping — always the full viewport,
which matches the card's `100vw × 100vh` composition.
"""

from __future__ import annotations

import atexit
from pathlib import Path

from playwright.sync_api import Browser, Playwright, sync_playwright

RENDER_WIDTH = 1920
RENDER_HEIGHT = 1080

_pw: Playwright | None = None
_browser: Browser | None = None


def _get_browser() -> Browser:
    global _pw, _browser
    if _browser is None:
        _pw = sync_playwright().start()
        _browser = _pw.chromium.launch()
        atexit.register(_shutdown)
    return _browser


def _shutdown() -> None:
    global _pw, _browser
    try:
        if _browser is not None:
            _browser.close()
    finally:
        if _pw is not None:
            _pw.stop()
        _browser = None
        _pw = None


def capture(html_path: Path) -> bytes:
    """Render the local HTML file and return a PNG of the full viewport.

    Waits for network-idle so any QR/image assets referenced via the
    backend's `/api/asset/...` proxy have time to load before the shot.
    """
    browser = _get_browser()
    ctx = browser.new_context(
        viewport={"width": RENDER_WIDTH, "height": RENDER_HEIGHT}
    )
    try:
        page = ctx.new_page()
        page.goto(html_path.resolve().as_uri(), wait_until="networkidle", timeout=15_000)
        return page.screenshot(full_page=False, type="png")
    finally:
        ctx.close()
