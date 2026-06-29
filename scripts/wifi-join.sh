#!/usr/bin/env bash
# Fa entrare il Pi in una rete WiFi normale (client) — disattiva l'hotspot.
# Uso: bash scripts/wifi-join.sh "NomeRete" "password"
# Per tornare hotspot: bash scripts/hotspot-on.sh
if [ -z "$1" ]; then echo "Uso: $0 <SSID> [password]"; exit 1; fi
sudo nmcli device wifi connect "$1" ${2:+password "$2"} ifname wlan0
echo "Connesso a '$1'. IP wlan0: $(ip -4 -br addr show wlan0 | awk '{print $3}')"
