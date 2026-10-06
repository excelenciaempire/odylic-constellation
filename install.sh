#!/usr/bin/env bash
# Odylic Constellation: one-line installer for macOS (Linux works too).
#
#   curl -fsSL https://raw.githubusercontent.com/peterquads/odylic-constellation/main/install.sh | bash
#
# Clones (or updates) the app in ~/odylic-constellation, creates a Python
# virtual environment, builds the web app and, on macOS, adds
# "Odylic Constellation" to Applications. Nothing secret is created: you
# connect your Meta account inside the app.
set -euo pipefail

REPO="${ODYLIC_CONSTELLATION_REPO:-peterquads/odylic-constellation}"
INSTALL_DIR="${ODYLIC_CONSTELLATION_DIR:-$HOME/odylic-constellation}"
PORT="${ODYLIC_PORT:-8777}"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n  * %s\n' "$*"; }
fail() { printf '\n  Error: %s\n\n' "$*" >&2; exit 1; }

printf '\n  Installing Odylic Constellation\n'

# 1) Prerequisites ------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "Git is required. On a Mac run: xcode-select --install"

PYTHON="${ODYLIC_CONSTELLATION_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      PYTHON="$(command -v "$c")"; break
    fi
  done
fi
[ -n "$PYTHON" ] || fail "Python 3.10 or newer is required. Get it from https://www.python.org/downloads"

NODE_NEED="Node.js 20.19 or newer (or 22.12 or newer) is required"
command -v node >/dev/null 2>&1 || fail "$NODE_NEED. Get it from https://nodejs.org"
command -v npm  >/dev/null 2>&1 || fail "npm is required (it ships with Node.js)."
# The web build (Vite 8) needs ^20.19.0 or >=22.12.0; older Node fails mid-build with a cryptic error.
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)' \
  || fail "$NODE_NEED (found $(node -v)). Get it from https://nodejs.org"

# Apple Silicon: force arm64 so every wheel matches the hardware, even when
# the shell was started under Rosetta. sysctl reports the real CPU.
ARCH=""
if [ "$(uname -s)" = "Darwin" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  ARCH="arch -arm64"
fi

# 2) Stop this install's running server, so the update never swaps code and
#    packages under a live process (it is started again at the end) --------
WAS_RUNNING=0
if [ -x "$INSTALL_DIR/.venv/bin/python" ] && [ -f "$INSTALL_DIR/api/healthcheck.py" ]; then
  if [ "$(cd "$INSTALL_DIR" && .venv/bin/python -m api.healthcheck "http://127.0.0.1:$PORT" --stop-ours 2>/dev/null)" = "stopped" ]; then
    WAS_RUNNING=1
    step "Stopped the running app server for the update"
  fi
fi

# 3) Get the code -------------------------------------------------------------
if [ "${ODYLIC_CONSTELLATION_SKIP_GIT:-0}" = "1" ]; then
  step "Using the code already in $INSTALL_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  step "Updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only --quiet || fail "Could not update. Local edits? Run: git -C \"$INSTALL_DIR\" status"
elif [ -e "$INSTALL_DIR" ]; then
  fail "$INSTALL_DIR exists but is not a git checkout. Move it away or set ODYLIC_CONSTELLATION_DIR."
else
  step "Downloading into $INSTALL_DIR"
  git clone --quiet --depth 1 "https://github.com/$REPO.git" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# 4) Python ------------------------------------------------------------------
step "Setting up Python ($("$PYTHON" -c 'import platform; print(platform.python_version())'))"
if [ ! -x .venv/bin/python ]; then
  $ARCH "$PYTHON" -m venv .venv
fi
# Exact versions (constraints.txt): every install gets the packages the app was tested with.
$ARCH .venv/bin/python -m pip install --quiet --disable-pip-version-check "pip==26.2.1"
$ARCH .venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt -c constraints.txt

# 5) Web app -----------------------------------------------------------------
step "Building the web app (about a minute the first time)"
(
  cd web
  if [ -f package-lock.json ]; then
    npm ci --silent --no-fund --no-audit
  else
    npm install --silent --no-fund --no-audit
  fi
  npm run build --silent
)
[ -f web/dist/index.html ] || fail "The web build did not produce web/dist/index.html."

chmod +x start.sh scripts/make-app.sh

# 6) Launcher ----------------------------------------------------------------
step "Adding the launcher"
scripts/make-app.sh || say "Could not create the launcher. You can still run: $INSTALL_DIR/start.sh"

if [ "$WAS_RUNNING" = "1" ]; then
  LAUNCH="/Applications/Odylic Constellation.app/Contents/MacOS/launch"
  [ -x "$LAUNCH" ] || LAUNCH="$HOME/Applications/Odylic Constellation.app/Contents/MacOS/launch"
  [ -x "$LAUNCH" ] || LAUNCH="$INSTALL_DIR/.run/launch.sh"
  if [ -x "$LAUNCH" ] && "$LAUNCH" --no-open >/dev/null 2>&1; then
    say "Restarted the app server with the new version. Reload the page if it is open."
  else
    say "Open Odylic Constellation again to start the new version."
  fi
fi

printf '\n  Done.\n\n'
if [ "$(uname -s)" = "Darwin" ]; then
  say "Open \"Odylic Constellation\" from Applications (in Finder's sidebar) or Spotlight,"
  say "or run: $INSTALL_DIR/start.sh"
else
  say "Run: $INSTALL_DIR/start.sh"
fi
say "Then visit http://127.0.0.1:8777"
say "Update later by running the same install command again."
printf '\n'
