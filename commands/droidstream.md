---
name: droidstream
description: Start the droidstream server and open the Android device stream in the browser pane
---

Start droidstream and show the device.

1. Check a device is available: run `adb devices` (find adb via `$ANDROID_SDK_ROOT/platform-tools` or `%LOCALAPPDATA%\Android\Sdk\platform-tools`).
   If none is attached, list AVDs with `emulator -list-avds` and ask which one to boot, then boot it and wait for `sys.boot_completed`.
2. Start the server in the background: `node "${CLAUDE_PLUGIN_ROOT}/server/server.js"` (port 8787, override with `PORT`).
3. Open it in the browser pane with `preview_start` `{url: "http://localhost:8787"}`.
4. Screenshot the pane to confirm the device screen is rendering, and report the device serial and screen size.

If the user named an APK in `$ARGUMENTS`, install and launch it afterwards:
`curl -s -X POST --data-binary @<apk> localhost:8787/install`.

Follow the `droidstream` skill for the full HTTP API when driving the device.
