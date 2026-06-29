#!/usr/bin/env bash
# One-shot installer for Raspberry Pi OS (Bookworm). Run from the project folder:
#   bash scripts/install-pi.sh
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(whoami)"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

echo "==> Installo dipendenze di sistema (node, ffmpeg, chromium, cage)…"
sudo apt update
sudo apt install -y nodejs npm ffmpeg cage curl chromium-browser || \
  sudo apt install -y nodejs npm ffmpeg cage curl chromium

echo "==> Installo i pacchetti npm…"
cd "$DIR"
npm install --omit=dev
node scripts/gen-icons.js || true
chmod +x scripts/kiosk.sh

echo "==> Creo i servizi systemd…"
sudo tee /etc/systemd/system/djvisualizer-server.service >/dev/null <<UNIT
[Unit]
Description=DJ Visualizer Pi server
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE_BIN server.js
Restart=always
User=$USER_NAME
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/djvisualizer-kiosk.service >/dev/null <<UNIT
[Unit]
Description=DJ Visualizer kiosk (Chromium fullscreen on HDMI)
After=djvisualizer-server.service systemd-user-sessions.target
Wants=djvisualizer-server.service

[Service]
User=$USER_NAME
PAMName=login
TTYPath=/dev/tty1
ExecStartPre=/bin/sh -c 'until curl -sf http://localhost:8080/ >/dev/null; do sleep 1; done'
ExecStart=/usr/bin/cage -- /bin/bash $DIR/scripts/kiosk.sh
Restart=always

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now djvisualizer-server.service
sudo systemctl enable --now djvisualizer-kiosk.service

IP="$(hostname -I | awk '{print $1}')"
echo
echo "==> Fatto!"
echo "    Output (HDMI):   parte da solo in kiosk."
echo "    Telecomando:     http://$IP:8080/   (apri dal telefono, stessa rete)"
echo "    Media:           copia i brani in $DIR/media/  (o carica dall'app)"
