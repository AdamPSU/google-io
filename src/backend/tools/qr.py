"""QR code generator. Pure function — no I/O, no side effects."""

from __future__ import annotations

import io

import segno


def make_qr_svg(text: str) -> bytes:
    qr = segno.make(text, error="m")
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=8, border=2, xmldecl=False, svgns=True)
    return buf.getvalue()
