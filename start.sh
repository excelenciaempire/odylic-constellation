#!/usr/bin/env bash
# Start Odylic Constellation on one port (API + web app): http://127.0.0.1:8777
#   ./start.sh          run in this terminal (Ctrl+C to stop)
#   ./start.sh --open   also open the browser once the server is up
set -euo pipefail
cd "$(dirname "$0")"

HOST="${ODYLIC_HOST:-127.0.0.1}"
PORT="${ODYLIC_PORT:-8777}"

# The API has no login: anything that can reach it can read your ad data and
# use your Meta token. So it listens on this Mac only, unless you insist.
case "$HOST" in
  127.*|localhost|::1|"[::1]") CHECK_HOST="$HOST" ;;
  *)
    if [ "${ODYLIC_ALLOW_LAN:-0}" != "1" ]; then
      echo "  Refusing to listen on $HOST: anyone on your network could read your ad data and use your" >&2
      echo "  Meta token. Set ODYLIC_ALLOW_LAN=1 to do it anyway." >&2
      exit 1
    fi
    echo "  WARNING: listening on $HOST. Anyone who can reach it can read your ad data and use your Meta token." >&2
    echo "  Requests must name an address listed in ODYLIC_HOST or ODYLIC_ALLOWED_HOSTS." >&2
    CHECK_HOST="127.0.0.1"
    ;;
esac
case "$CHECK_HOST" in *:*) CHECK_HOST="[${CHECK_HOST#[}"; CHECK_HOST="${CHECK_HOST%]}]" ;; esac
URL="http://$CHECK_HOST:$PORT"

if [ ! -x .venv/bin/python ]; then
  echo "  The Python environment is missing. Run ./install.sh first." >&2
  exit 1
fi
if [ ! -f web/dist/index.html ]; then
  echo "  Note: the web app is not built yet (cd web && npm ci && npm run build). The API still runs."
fi

open_browser() { open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true; }

# Only a server that proves it is this install's own counts as running (see
# api/healthcheck.py); an older build of it is stopped and replaced.
STATE="$(.venv/bin/python -m api.healthcheck "$URL" --stop-stale 2>/dev/null || echo down)"
case "$STATE" in
  ours)
    echo "  Odylic Constellation is already running at $URL"
    [ "${1:-}" = "--open" ] && open_browser
    exit 0
    ;;
  foreign)
    echo "  Port $PORT is in use by another program. Quit it, or start on another port: ODYLIC_PORT=8778 $0" >&2
    exit 1
    ;;
  stale)
    echo "  An older version of the app is running on port $PORT and could not be stopped. Quit it, then try again." >&2
    exit 1
    ;;
esac

ARCH=""
if [ "$(uname -s)" = "Darwin" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arch -arm64"
fi

if [ "${1:-}" = "--open" ]; then
  (
    for _ in $(seq 1 60); do
      if [ "$(.venv/bin/python -m api.healthcheck "$URL" 2>/dev/null)" = "ours" ]; then
        open_browser
        break
      fi
      sleep 0.25
    done
  ) &
fi

echo "  Odylic Constellation: $URL  (Ctrl+C to stop)"
exec $ARCH .venv/bin/python -m uvicorn api.main:app --host "$HOST" --port "$PORT" --log-level warning
