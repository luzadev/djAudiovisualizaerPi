#!/usr/bin/env bash
# Launch Chromium fullscreen (kiosk) on the Pi's HDMI, pointed at the output page.
URL="${1:-http://localhost:8080/output.html}"
BIN="$(command -v chromium-browser || command -v chromium || echo chromium)"
exec "$BIN" \
  --kiosk --noerrordialogs --disable-infobars --no-first-run \
  --autoplay-policy=no-user-gesture-required \
  --disable-translate --disable-features=Translate \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --ozone-platform=wayland --use-gl=egl \
  "$URL"
