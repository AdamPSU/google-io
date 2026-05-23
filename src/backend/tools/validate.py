"""Lint a generated business card HTML.

Pure function. Checks the constraints the builder is supposed to honor
(no scrolling, palette adherence, no JS, decent contrast). Returns a
short text report — `OK: no issues.` when clean, otherwise one issue
per line so the agent can read and act on it.
"""

from __future__ import annotations

import re

_PALETTE_META_RE = re.compile(
    r'<meta\s+name=["\']palette["\']\s+content=["\']([^"\']+)["\']',
    re.IGNORECASE,
)
_HEX_RE = re.compile(r"#[0-9a-f]{6}\b|#[0-9a-f]{3}\b", re.IGNORECASE)
_HEX_FULL_RE = re.compile(r"^#(?:[0-9a-f]{6}|[0-9a-f]{3})$", re.IGNORECASE)
_SCRIPT_RE = re.compile(r"<script\b", re.IGNORECASE)
_EXTERNAL_LINK_RE = re.compile(r'<link[^>]+href=["\']([^"\']+)["\']', re.IGNORECASE)
_OVERFLOW_RE = re.compile(r"overflow(?:-[xy])?\s*:\s*hidden", re.IGNORECASE)
_VIEWPORT_UNITS_RE = re.compile(r"\b\d+(?:\.\d+)?(?:vh|vw|vmin|vmax)\b", re.IGNORECASE)


def _norm_hex(h: str) -> str:
    h = h.lstrip("#").lower()
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return "#" + h


def _luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))

    def channel(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def _contrast(c1: str, c2: str) -> float:
    l1, l2 = _luminance(c1), _luminance(c2)
    lighter, darker = max(l1, l2), min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


def validate_card_html(html: str) -> str:
    issues: list[str] = []

    # Palette meta + extraction (preserve order; the prompt convention is
    # bg, fg, accent — used for the contrast check below).
    palette_ordered: list[str] = []
    palette_match = _PALETTE_META_RE.search(html)
    if not palette_match:
        issues.append(
            'ERROR: missing `<meta name="palette" content="#x,#y,#z">` in <head>'
        )
    else:
        for token in palette_match.group(1).split(","):
            token = token.strip()
            if _HEX_FULL_RE.match(token):
                palette_ordered.append(_norm_hex(token))
        if len(palette_ordered) != 3:
            issues.append(
                f"ERROR: palette meta lists {len(palette_ordered)} valid hex "
                "codes; expected 3"
            )

    # Off-palette hex codes anywhere in the HTML.
    palette_set = set(palette_ordered)
    if palette_set:
        used = {_norm_hex(m.group(0)) for m in _HEX_RE.finditer(html)}
        off = sorted(used - palette_set)
        if off:
            issues.append(f"WARN: off-palette colors used: {', '.join(off)}")

    # No-scroll guards.
    if not _OVERFLOW_RE.search(html):
        issues.append(
            "WARN: no `overflow: hidden` rule found — card may scroll"
        )
    if not _VIEWPORT_UNITS_RE.search(html):
        issues.append(
            "WARN: no viewport units (vh/vw/vmin/vmax) — layout may not fill "
            "the frame"
        )

    # No JS, no external stylesheets.
    if _SCRIPT_RE.search(html):
        issues.append("WARN: <script> tag present — no JS allowed")
    for m in _EXTERNAL_LINK_RE.finditer(html):
        href = m.group(1)
        if href.startswith(("http://", "https://")) and "/api/asset/" not in href:
            issues.append(f"WARN: external link/stylesheet: {href}")

    # WCAG AA contrast between background and foreground (palette[0] vs [1]).
    if len(palette_ordered) >= 2:
        bg, fg = palette_ordered[0], palette_ordered[1]
        ratio = _contrast(bg, fg)
        if ratio < 4.5:
            issues.append(
                f"WARN: bg/fg contrast {bg} vs {fg} = {ratio:.2f}; WCAG AA "
                "wants ≥ 4.5"
            )

    return "OK: no issues." if not issues else "\n".join(issues)
