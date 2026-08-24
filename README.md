# droidstream

Stream an Android device or emulator into a web page and drive it with your mouse and keyboard —
a small, local, zero-dependency take on [Appetize.io](https://appetize.io).

Built to run an app inside the **Claude Code browser pane**, so an agent can open a build, tap
through it, and see what happened. It works as a plain web app too.

![status](https://img.shields.io/badge/android-working-brightgreen) ![deps](https://img.shields.io/badge/dependencies-0-blue)

## What it does

- **Live screen** — H.264 via `adb exec-out screenrecord`, decoded in the browser with WebCodecs
  (~15-25 fps under motion). Falls back to a ~1 fps MJPEG stream where WebCodecs is missing.
- **Full input** — click to tap, drag to swipe, type to type, buttons for Back / Home / Recents.
- **Drop an APK on the page** — installs with `adb install -r` and launches it.
- **Boot an emulator** from the AVD dropdown when nothing is attached.
- **HTTP API** so a script or an AI agent can drive the device without a browser.

No npm install. No native modules. One Node file plus one HTML file.

## Requirements

- Android SDK — `platform-tools` (adb) and, for emulators, `emulator`
- Node 18+
- Chrome or Edge for the fast video path

## Run it

```bash
git clone https://github.com/USER/droidstream
node droidstream/server/server.js
# open http://localhost:8787
```

Environment: `PORT` (default `8787`), `ADB`, `ANDROID_SDK_ROOT`, `ANDROID_SERIAL`.

## Use it as a Claude Code plugin

This repo is also a Claude Code plugin — a `droidstream` skill plus a `/droidstream` command.

```
/plugin install USER/droidstream
```

Then just ask: *"open my app on the emulator"*, *"install this APK and tap Sign in"*.

## HTTP API

Coordinates are device pixels; read the screen size from `/info`.

| Call | Purpose |
|---|---|
| `GET /info` | device, screen size, device list, AVD list |
| `POST /select` `{serial}` | choose a device |
| `POST /boot` `{avd}` | start an emulator |
| `POST /input` `{type:"tap",x,y}` | tap |
| `POST /input` `{type:"swipe",x1,y1,x2,y2,ms}` | swipe |
| `POST /input` `{type:"text",text}` | type text |
| `POST /input` `{type:"key",key:"KEYCODE_BACK"}` | key event |
| `POST /install` (raw APK body) | install and launch |
| `GET /video` | raw H.264 Annex-B stream |
| `GET /stream` | MJPEG fallback |

```bash
curl -X POST localhost:8787/input -H 'Content-Type: application/json' -d '{"type":"tap","x":540,"y":1200}'
curl -X POST --data-binary @app-debug.apk localhost:8787/install
```

## How the video path works

`screenrecord` writes an Annex-B H.264 elementary stream to stdout. The server pipes it over
chunked HTTP. The page splits NAL units, groups each slice into an access unit, and hands them to
`VideoDecoder`, painting frames on a canvas. No muxer, no MSE, no libraries.

`screenrecord` stops after 180 s, so the server relaunches it while a client is connected. The
encoder emits nothing while the screen is still — the status line reads `idle`, which is normal.

## Limits

- Android only. iOS needs macOS (`simctl`) and is not implemented yet.
- One device per server instance; start another on a different `PORT` for a second device.
- No audio, no clipboard sync, no pinch/zoom.
- Local use only — the server has no authentication. Do not expose it to a network.

## Test

```bash
node test.js     # needs a device attached
```

## License

MIT
