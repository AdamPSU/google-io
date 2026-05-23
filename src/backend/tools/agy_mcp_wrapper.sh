#!/usr/bin/env bash
# Spawned by agy as the `assets` MCP server (registered in
# ~/.gemini/antigravity-cli/mcp_config.json). Sources secrets from the
# project's .env at startup so agy itself never sees GEMINI_API_KEY /
# SUPABASE_* (GEMINI_API_KEY in agy's env breaks GCP keyring auth).
#
# JOB_ID and BUILD_DIR are NOT in .env — they're per-build and flow
# through agy's spawned-subprocess env from the FastAPI generation
# subprocess. See `_spawn_agy` in generation.py.
set -euo pipefail
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$BACKEND_DIR/../.." && pwd)"
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi
exec uv run --directory "$BACKEND_DIR" python -m tools.mcp_server
