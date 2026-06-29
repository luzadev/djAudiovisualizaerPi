#!/usr/bin/env bash
# Attiva l'access point del Pi su wlan0 (SSID "DJVisualizer").
# Il telefono si collega alla rete del Pi e apre http://10.42.0.1:8080/
sudo nmcli connection up Hotspot
echo "Hotspot attivo. WiFi: DJVisualizer  ·  Remote: http://10.42.0.1:8080/"
