"""Fetch a real photo from the Google Places Photo API.

Pure function. The MCP wrapper in mcp_server.py picks which photo by
index (from the places.json we stored in slice 1), passes its `name`
here, and uploads the returned bytes as a card asset.

Places Photo API: GET /v1/{photo.name}/media — returns binary image,
following a 302 to a CDN URL. We let httpx follow the redirect.
"""

from __future__ import annotations

import os

import httpx

PHOTO_API = "https://places.googleapis.com/v1/{name}/media"
DEFAULT_MAX_WIDTH = 1600
DEFAULT_MAX_HEIGHT = 1200


def fetch_place_photo(
    photo_name: str,
    max_width: int = DEFAULT_MAX_WIDTH,
    max_height: int = DEFAULT_MAX_HEIGHT,
) -> tuple[bytes, str]:
    api_key = os.environ["PLACES_API"]
    resp = httpx.get(
        PHOTO_API.format(name=photo_name),
        params={
            "maxWidthPx": max_width,
            "maxHeightPx": max_height,
            "key": api_key,
        },
        follow_redirects=True,
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.content, resp.headers.get("content-type", "image/jpeg")
