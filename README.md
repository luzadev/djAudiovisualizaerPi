# DJ Visualizer Pi

Versione **standalone** del DJ Visualizer pensata per girare su un **Raspberry Pi 5**
e farsi comandare da **telefono/tablet** (webapp PWA, iOS + Android, niente store).

Riusa il motore grafico/audio dell'app Mac (shader WebGL2, catalogo effetti, Web Audio):
cambia solo il "tubo" di comunicazione — l'IPC di Electron è sostituito da un
**server Node con WebSocket**, e il pannello di controllo è una **webapp mobile**.

## Architettura

```
            Raspberry Pi 5 (device standalone)
  ┌───────────────────────────────────────────────┐
  │  server.js (Node)                              │
  │   • serve la PWA di controllo  ── HTTP ──> 📱  │
  │   • relay comandi  ── WebSocket ──>  📱 <─> 🖥  │
  │   • API: media, stato, peaks, registrazione    │
  │                                                │
  │  Chromium kiosk  ──>  output.html (WebGL+audio)│
  │       └── fullscreen su HDMI ──> proiettore    │
  │  Audio ──> uscita Pi (HDMI/DAC USB) ──> casse  │
  └───────────────────────────────────────────────┘
```

- **Output** (`public/output.html`): gira sul Pi in Chromium kiosk, rende i visual a 60fps
  e riproduce l'audio dei file sul Pi. Riceve comandi via WebSocket.
- **Controllo** (`public/index.html`): la webapp che apri dal telefono. Stesso protocollo
  di messaggi JSON dell'app Mac (`effect`, `playTrack`, `ticker*`, `bandGain`, …).

## Provarlo sul Mac (prima del Pi)

```bash
cd DjVisualizerPi
npm install
node scripts/gen-icons.js      # genera le icone PWA
npm start
```

- Output:    <http://localhost:8080/output.html>  (clicca una volta per fullscreen/audio)
- Controllo: <http://localhost:8080/>  (aprilo anche dal telefono sulla stessa rete)

Metti qualche brano nella cartella `media/` (o caricalo dall'app, tab **Media**).

## Installazione sul Raspberry Pi 5

Pi OS Bookworm (64-bit). Copia la cartella sul Pi e:

```bash
bash scripts/install-pi.sh
```

Installa node/ffmpeg/chromium/cage, crea due servizi systemd
(`djvisualizer-server` + `djvisualizer-kiosk`) e li avvia. Al boot il Pi mostra
i visual a tutto schermo; dal telefono apri `http://<ip-del-pi>:8080/`.

I brani vanno in `media/` (chiavetta USB, condivisione di rete, o upload dall'app).

### Rete — Hotspot (consigliato da palco)
Il Pi crea la sua rete WiFi su `wlan0` (NetworkManager), così basta il telefono.

- **SSID**: `DJVisualizer` · **password**: _scegli la tua_ (impostata in fase di setup; vedi sotto come cambiarla)
- **Remote**: <http://10.42.0.1:8080/>  (IP fisso dell'hotspot)
- Parte da solo al boot (connessione `Hotspot`, autoconnect, priorità 100).
- Cambiare SSID/password:
  `sudo nmcli connection modify Hotspot 802-11-wireless.ssid "NuovoNome" wifi-sec.psk "nuovapassword"`
- Passare a una rete WiFi normale (per aggiornamenti):
  `bash scripts/wifi-join.sh "NomeRete" "password"` → poi `bash scripts/hotspot-on.sh` per tornare AP.
- **Amministrazione**: la porta **ethernet** resta sempre disponibile per SSH/manutenzione.

## Funzioni del telecomando
- **🌀 Effetti**: libreria completa (famiglie + ricerca) + sagome SVG.
- **🎵 Media**: libreria sul dispositivo, upload, coda con play/seek/prev/next.
- **🔤 Testo**: ticker con direzione, posizione, effetto, grandezza, velocità, colore.
- **🎹 Pad**: griglia 3×4 (tieni premuto per assegnare un brano).
- **🎚 Audio**: reattività, velocità, EQ visual (bassi/medi/alti) + meter live.
- **🖥 Out**: fullscreen output + registrazione MP4 (16:9, 9:16, 1:1, 4:3).

## Da fare (port successivo dall'app Mac)
- Scene a tempo per brano (effetto/testo/immagine con timing indipendente).
- Trim inizio/fine + waveform per traccia nella coda.
- Intermezzi e pause tra i brani.

> L'app Mac (Electron) resta un progetto separato e invariato.
