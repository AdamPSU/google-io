"""Lazy singleton for the Supabase service-role client.

Slice 1 stub — wired but unused. Slice 2+ will call this from the
ingestion pipeline to persist `generations` rows and upload artifacts
to the `generations` storage bucket.
"""

from __future__ import annotations

import os
from functools import lru_cache

from supabase import Client, create_client


@lru_cache(maxsize=1)
def get_client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"
        )
    return create_client(url, key)
