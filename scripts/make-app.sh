#!/usr/bin/env bash
# Create a double-clickable launcher.
#   macOS: ~/Applications/Odylic Constellation.app
#   Linux: ~/.local/share/applications/odylic-constellation.desktop
# The launcher starts the local server in the background (if it is not already
# running) on 127.0.0.1:8777 and opens the browser. Safe to run again.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ODYLIC_PORT:-8777}"
URL="http://127.0.0.1:$PORT"

if [ "$(uname -s)" = "Darwin" ]; then
  LOG_DIR="$HOME/Library/Logs/Odylic Constellation"
else
  LOG_DIR="$HOME/.odylic-constellation/logs"
fi

# The launch script, shared by both platforms. Values from this run are baked
# in; anything escaped with a backslash is evaluated when the launcher runs.
# It only opens the browser on a server that proves it is this install's own
# (api/healthcheck.py), restarts this install's server when it runs an older
# build (after an update), and says so plainly when another program holds
# the port. `--no-open` starts or restarts the server without the browser.
launch_script() {
  local opener="$1" notify="$2"
  cat <<EOF
#!/usr/bin/env bash
APP_DIR="$APP_DIR"
URL="$URL"
LOG_DIR="$LOG_DIR"
PY="\$APP_DIR/.venv/bin/python"
mkdir -p "\$LOG_DIR"
cd "\$APP_DIR" || exit 1
say() { $notify; }
STATE="\$("\$PY" -m api.healthcheck "\$URL" --stop-stale 2>>"\$LOG_DIR/server.log")"
if [ "\$STATE" = "foreign" ]; then
  say "Port $PORT is in use by another program, so Odylic Constellation can not start. Quit that program, then try again."
  exit 1
fi
if [ "\$STATE" != "ours" ]; then
  # Keep the log small: past 1 MB, keep its last 256 KB.
  if [ -f "\$LOG_DIR/server.log" ] && [ "\$(wc -c < "\$LOG_DIR/server.log")" -gt 1048576 ]; then
    tail -c 262144 "\$LOG_DIR/server.log" > "\$LOG_DIR/server.log.tmp" && mv "\$LOG_DIR/server.log.tmp" "\$LOG_DIR/server.log"
  fi
  ARCH=""
  if [ "\$(uname -s)" = "Darwin" ] && [ "\$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
    ARCH="arch -arm64"
  fi
  nohup \$ARCH "\$PY" -m uvicorn api.main:app --host 127.0.0.1 --port $PORT --log-level warning \\
    >> "\$LOG_DIR/server.log" 2>&1 &
  for _ in \$(seq 1 80); do
    STATE="\$("\$PY" -m api.healthcheck "\$URL" 2>/dev/null)"
    [ "\$STATE" = "ours" ] && break
    sleep 0.25
  done
  if [ "\$STATE" != "ours" ]; then
    say "Odylic Constellation could not start. The log is in \$LOG_DIR/server.log"
    exit 1
  fi
fi
[ "\${1:-}" = "--no-open" ] || $opener "\$URL"
EOF
}

case "$(uname -s)" in
  Darwin)
    # The main Applications folder when this account can write it (admin accounts can), so it shows in
    # Finder's sidebar and in Spotlight; otherwise ~/Applications. A copy left in the other spot by an
    # earlier install is removed, so there is only ever one.
    if [ -w /Applications ]; then
      APP="/Applications/Odylic Constellation.app"
      rm -rf "$HOME/Applications/Odylic Constellation.app"
    else
      APP="$HOME/Applications/Odylic Constellation.app"
    fi
    mkdir -p "$(dirname "$APP")"
    rm -rf "$APP"
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    launch_script open 'osascript -e "display dialog \"$1\" with title \"Odylic Constellation\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1 || echo "$1" >&2' \
      > "$APP/Contents/MacOS/launch"
    chmod +x "$APP/Contents/MacOS/launch"

    VERSION="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$APP_DIR/api/__init__.py" 2>/dev/null || true)"
    VERSION="${VERSION:-1.0.0}"
    cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.odylicmedia.constellation</string>
  <key>CFBundleName</key><string>Odylic Constellation</string>
  <key>CFBundleDisplayName</key><string>Odylic Constellation</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST

    # Icon: the first square PNG the web app ships, turned into an .icns.
    SRC_PNG=""
    for c in "$APP_DIR/web/public/app-icon.png" "$APP_DIR/web/public/icon.png" "$APP_DIR/web/public/odylic-icon.png" \
             "$APP_DIR/web/public/apple-touch-icon.png" "$APP_DIR/web/public/logo.png"; do
      [ -f "$c" ] && { SRC_PNG="$c"; break; }
    done
    if [ -n "$SRC_PNG" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
      TMP="$(mktemp -d)"; SET="$TMP/AppIcon.iconset"; mkdir -p "$SET"
      for SZ in 16 32 128 256 512; do
        sips -z $SZ $SZ "$SRC_PNG" --out "$SET/icon_${SZ}x${SZ}.png" >/dev/null 2>&1 || true
        sips -z $((SZ*2)) $((SZ*2)) "$SRC_PNG" --out "$SET/icon_${SZ}x${SZ}@2x.png" >/dev/null 2>&1 || true
      done
      iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns" >/dev/null 2>&1 || true
      rm -rf "$TMP"
    fi

    touch "$APP"
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
      -f "$APP" >/dev/null 2>&1 || true
    mdimport "$APP" >/dev/null 2>&1 || true   # Spotlight finds it right away
    echo "  Launcher ready: $APP"
    ;;
  Linux)
    mkdir -p "$APP_DIR/.run" "$HOME/.local/share/applications"
    LAUNCH="$APP_DIR/.run/launch.sh"
    launch_script xdg-open 'notify-send "Odylic Constellation" "$1" >/dev/null 2>&1 || echo "$1" >&2' > "$LAUNCH"
    chmod +x "$LAUNCH"
    cat > "$HOME/.local/share/applications/odylic-constellation.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Odylic Constellation
Comment=See your Meta ads by funnel position
Exec=$LAUNCH
Terminal=false
Categories=Office;
EOF
    update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
    echo "  Launcher ready: Odylic Constellation (applications menu)"
    ;;
  *)
    echo "  No launcher for this system. Start the app with: $APP_DIR/start.sh"
    ;;
esac
