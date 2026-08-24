---
name: droidstream
description: Use when the user wants to see, run, test, or drive an Android app, emulator, or phone inside the browser pane - "open my app", "show the emulator", "install this APK", "tap that button on the phone", "test the Android build". Streams a live device screen into a web page (Appetize.io-style) and sends taps, swipes, text, and keys back over adb.
version: 0.1.0
---

# droidstream

Streams an Android device or emulator into a local web page and drives it with `adb`.
No npm dependencies. Everything is local — no cloud device farm.

## Requirements

- Android SDK with `platform-tools` (adb) and `emulator`
- Node 18+ (the server uses `fetch`-era APIs only on the client, but Node 18+ is a safe floor)
- A browser with WebCodecs (Chrome/Edge). Without it the page falls back to a ~1 fps MJPEG stream.

`adb` is found in this order: `$ADB` → `$ANDROID_SDK_ROOT/platform-tools/adb` → `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`.

## Start it

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/server.js"
```

Then open `http://localhost:8787` in the browser pane (`preview_start` with `{url}`).
Set `PORT` to use a different port, `ANDROID_SERIAL` to pin one device.

For a repeatable launch, add this to the project's `.claude/launch.json`:

```json
{ "name": "droidstream", "runtimeExecutable": "node",
  "runtimeArgs": ["<plugin-root>/server/server.js"], "port": 8787 }
```

## Drive it from the page

Click = tap. Drag = swipe. Typing = text. Side buttons = Back / Home / Recents / Enter / Backspace.
Drag an `.apk` file onto the page to install and launch it.
Rotate and Screenshot buttons sit under **Screen**; screenshots are written to `./screenshots`.
The "Start AVD" dropdown boots an emulator if none is running.

## Drive it from Claude (HTTP API)

Use these when acting on the device directly instead of clicking in the pane.
Coordinates are **device pixels** (get them from `/info`).

| Call | Purpose |
|---|---|
| `GET /info` | current device, screen size, device list, AVD list |
| `POST /select` `{serial}` | choose a device |
| `POST /boot` `{avd}` | start an emulator |
| `POST /input` `{type:"tap",x,y}` | tap |
| `POST /input` `{type:"swipe",x1,y1,x2,y2,ms}` | swipe / scroll |
| `POST /input` `{type:"text","..."}` | type text |
| `POST /input` `{type:"key",key:"KEYCODE_BACK"}` | key event |
| `POST /rotate` | rotate the screen 90 degrees |
| `GET /screenshot` | save a PNG to ./screenshots (add `?download=1` to download it) |
| `GET /frame` | one PNG of the current screen, nothing saved |
| `POST /install` (raw APK body) | install `-r` and launch |
| `GET /video` | raw H.264 Annex-B stream |
| `GET /stream` | MJPEG fallback |

Example:

```bash
curl -s -X POST localhost:8787/input -H "Content-Type: application/json" -d '{"type":"tap","x":540,"y":1200}'
curl -s -X POST --data-binary @app-debug.apk localhost:8787/install
```

## How the video works

`adb exec-out screenrecord --output-format=h264` streams Annex-B H.264 over chunked HTTP.
The page splits NAL units, feeds them to `VideoDecoder` (WebCodecs) and paints to a canvas.
No muxing, no MSE, no libraries. `screenrecord` stops at 180 s, so the server relaunches it
automatically while a client is connected.

The encoder emits nothing while the screen is still, so the status line reads `idle` — that is
normal, not a stall. Under motion expect ~15-25 fps.

## Troubleshooting

- **`no device`** — run `adb devices`; boot an AVD with the dropdown or `POST /boot`.
- **Black canvas** — the WebCodecs decoder never got a keyframe; reload the page.
- **Taps land in the wrong place** — the page maps clicks with the size from `/info`; reload after a rotation.
- **Install fails with `INSTALL_FAILED_*`** — the raw adb output is returned in the response.

## Known limits

- Android only. iOS mirroring needs macOS (`simctl` / Xcode) and is not implemented.
- One device at a time per server; run a second server on another `PORT` for a second device.
- No audio, no clipboard sync, no multi-touch (pinch/zoom).
