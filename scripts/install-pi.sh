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

# Audio: il vc4hdmi del Pi 5 espone solo il formato IEC958 e NON ha mixing
# hardware, quindi ALSA grezzo è esclusivo (un solo stream) e l'audio dei file
# resta muto mentre Chromium tiene il device. PipeWire fa da mixer software e
# gestisce la conversione IEC958, così tutti gli stream di Chromium escono su HDMI.
echo "==> Installo PipeWire (mixer audio per l'uscita HDMI)…"
sudo apt install -y pipewire pipewire-pulse pipewire-alsa wireplumber
sudo loginctl enable-linger "$USER_NAME"   # i servizi utente partono al boot
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user enable --now pipewire.socket pipewire-pulse.socket wireplumber.service 2>/dev/null || true
systemctl --user start pipewire pipewire-pulse 2>/dev/null || true
sleep 2
# Porta l'uscita HDMI a volume pieno e smutala (best-effort).
HDMI_SINK="$(wpctl status 2>/dev/null | grep -iE 'HDMI' | grep -oE '^\s*\*?\s*[0-9]+' | grep -oE '[0-9]+' | head -1)"
[ -n "$HDMI_SINK" ] && { wpctl set-volume "$HDMI_SINK" 1.0; wpctl set-mute "$HDMI_SINK" 0; }

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
