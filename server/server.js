// droidstream - stream an Android device/emulator into a web page (Appetize-style, local).
// v1: MJPEG frames from `adb exec-out screencap`, input via `adb shell input`.
// ponytail: screencap loop caps ~5-8fps. Upgrade path = scrcpy H.264 server + MSE if fps matters.
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = process.platform === 'win32' ? '.exe' : '';
const HOME = require('os').homedir();
const defaultSdk = () =>
  process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || HOME, 'Android', 'Sdk')
  : process.platform === 'darwin' ? path.join(HOME, 'Library', 'Android', 'sdk')
  : path.join(HOME, 'Android', 'Sdk');
const SDK = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || defaultSdk();
const ADB = process.env.ADB || path.join(SDK, 'platform-tools', 'adb' + EXE);
const EMULATOR = path.join(SDK, 'emulator', 'emulator' + EXE);
const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = path.join(__dirname, 'public');

let serial = process.env.ANDROID_SERIAL || null;
let size = null; // {w,h}

const run = (args, opts = {}) => new Promise((res, rej) => {
  const full = serial ? ['-s', serial, ...args] : args;
  execFile(ADB, full, { maxBuffer: 1 << 26, encoding: opts.binary ? 'buffer' : 'utf8' },
    (err, stdout) => err ? rej(err) : res(stdout));
});

async function devices() {
  const out = await run(['devices']);
  return out.split('\n').slice(1)
    .map(l => l.trim().split(/\s+/))
    .filter(p => p[1] === 'device')
    .map(p => p[0]);
}

async function pickDevice() {
  const list = await devices();
  if (!list.length) { serial = null; size = null; return null; }
  if (!serial || !list.includes(serial)) { serial = list[0]; size = null; }
  return serial;
}

// Take the size from a real capture. `wm size` reports the physical size and never flips
// with rotation, which would put every tap in the wrong place in landscape.
async function getSize() {
  if (size) return size;
  try {
    const png = await run(['exec-out', 'screencap', '-p'], { binary: true });
    if (png.length > 24 && png.readUInt32BE(12) === 0x49484452)   // 'IHDR'
      return (size = { w: png.readUInt32BE(16), h: png.readUInt32BE(20) });
  } catch { /* fall through to wm size */ }
  const out = await run(['shell', 'wm', 'size']);
  const m = out.match(/Override size:\s*(\d+)x(\d+)/) || out.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!m) throw new Error('cannot read screen size: ' + out);
  return (size = { w: +m[1], h: +m[2] });
}

// ---- MJPEG broadcast ----
const clients = new Set();
let looping = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function captureLoop() {
  if (looping) return;
  looping = true;
  while (clients.size) {
    let buf = null;
    try {
      if (await pickDevice()) buf = await run(['exec-out', 'screencap', '-p'], { binary: true });
    } catch (e) { buf = null; }
    if (buf && buf.length > 100) {
      const head = Buffer.from(
        `--frame\r\nContent-Type: image/png\r\nContent-Length: ${buf.length}\r\n\r\n`);
      for (const res of clients) { res.write(head); res.write(buf); res.write('\r\n'); }
    } else {
      await sleep(700); // no device / capture failed - back off
    }
  }
  looping = false;
}

// ---- input ----
const esc = s => String(s).replace(/(["\$`])/g, '\$1').replace(/ /g, '%s');

async function doInput(b) {
  switch (b.type) {
    case 'tap':   return run(['shell', 'input', 'tap', b.x | 0, b.y | 0]);
    case 'swipe': return run(['shell', 'input', 'swipe', b.x1 | 0, b.y1 | 0, b.x2 | 0, b.y2 | 0, b.ms || 200]);
    case 'text':  return run(['shell', 'input', 'text', esc(b.text)]);
    case 'key':   return run(['shell', 'input', 'keyevent', String(b.key).replace(/[^A-Z0-9_]/gi, '')]);
    default: throw new Error('unknown input type');
  }
}

const body = req => new Promise(res => {
  let d = ''; req.on('data', c => d += c); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } });
});

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store', 'Connection': 'close',
      });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      captureLoop();
      return;
    }

    if (url.pathname === '/video') {
      if (!await pickDevice()) return json(res, 409, { error: 'no device' });
      const d = await getSize();
      const vw = Math.round(Math.min(720, d.w) / 16) * 16;
      const vh = Math.round((vw * d.h / d.w) / 16) * 16;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      let child = null, alive = true;
      const start = () => {
        const args = (serial ? ['-s', serial] : []).concat(
          ['exec-out', 'screenrecord', '--output-format=h264', '--size', vw + 'x' + vh,
           '--bit-rate', '6M', '--time-limit', '170', '-']);
        child = require('child_process').spawn(ADB, args);
        child.stdout.on('data', c => res.write(c));
        child.on('exit', () => { if (alive) start(); }); // screenrecord caps at 180s - relaunch
      };
      start();
      req.on('close', () => { alive = false; if (child) child.kill(); });
      return;
    }

    if (url.pathname === '/frame') {
      if (!await pickDevice()) return json(res, 409, { error: 'no device' });
      const png = await run(['exec-out', 'screencap', '-p'], { binary: true });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    }
    if (url.pathname === '/screenshot') {
      if (!await pickDevice()) return json(res, 409, { error: 'no device' });
      const png = await run(['exec-out', 'screencap', '-p'], { binary: true });
      const name = 'droidstream-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      const dir = path.join(process.cwd(), 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), png);
      if (url.searchParams.get('download')) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename=' + name });
        return res.end(png);
      }
      return json(res, 200, { saved: path.join(dir, name) });
    }
    if (url.pathname === '/rotate' && req.method === 'POST') {
      if (!await pickDevice()) return json(res, 409, { error: 'no device' });
      const cur = parseInt((await run(['shell', 'settings', 'get', 'system', 'user_rotation'])).trim(), 10) || 0;
      const next = (cur + 1) % 4;
      await run(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
      await run(['shell', 'settings', 'put', 'system', 'user_rotation', String(next)]);
      size = null;                       // wm size flips with the rotation
      await new Promise(r => setTimeout(r, 700));
      return json(res, 200, { rotation: next, size: await getSize() });
    }
    if (url.pathname === '/install' && req.method === 'POST') {
      if (!await pickDevice()) return json(res, 409, { error: 'no device' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const apk = path.join(require('os').tmpdir(), 'droidstream-' + Date.now() + '.apk');
      fs.writeFileSync(apk, Buffer.concat(chunks));
      try {
        const out = await run(['install', '-r', '-t', apk]);
        const pkg = await pkgOf(apk);
        // A dev build reaches its bundler over `adb reverse`. `expo start` and `npm run dev`
        // never set that up, so the app hangs on its splash screen with no error.
        const reversed = await autoReverse();
        const launched = pkg ? await launch(pkg) : false;
        return json(res, 200, { ok: /Success/i.test(out), pkg, launched, reversed, out: out.trim() });
      } finally { fs.unlinkSync(apk); }
    }
    if (url.pathname === '/info') {
      const s = await pickDevice();
      if (!s) return json(res, 200, { device: null, avds: listAvds() });
      return json(res, 200, { device: s, size: await getSize(), devices: await devices(), avds: listAvds() });
    }
    if (url.pathname === '/select' && req.method === 'POST') {
      const b = await body(req); serial = b.serial || null; size = null;
      return json(res, 200, { device: serial });
    }
    if (url.pathname === '/input' && req.method === 'POST') {
      if (!await pickDevice()) return json(res, 409, { error: 'no device' });
      await doInput(await body(req));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/boot' && req.method === 'POST') {
      const b = await body(req);
      const avd = (b.avd || '').replace(/[^\w.-]/g, '');
      if (!avd) return json(res, 400, { error: 'avd required' });
      // Warm boot by default: a snapshot start is roughly 3x faster than a cold one.
      const args = ['-avd', avd, '-netdelay', 'none', '-netspeed', 'full', '-no-boot-anim'];
      if (b.cold) args.push('-no-snapshot-load');
      // Headless is opt-in: many GPUs (Intel/AMD integrated especially) cannot make an offscreen
      // GL context, so -no-window only works with the software renderer.
      if (b.headless) args.push('-no-window', '-gpu', 'swiftshader_indirect');
      const child = require('child_process').spawn(EMULATOR, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return json(res, 200, { booting: avd, cold: !!b.cold });
    }
    if (url.pathname === '/reverse' && req.method === 'POST') {
      if (!await pickDevice()) return json(res, 409, { error: 'no device' });
      const b = await body(req);
      const ports = (b.ports || (b.port ? [b.port] : DEV_PORTS)).map(Number).filter(p => p > 0 && p < 65536);
      const done = [];
      for (const p of ports) {
        try { await run(['reverse', `tcp:${p}`, `tcp:${p}`]); done.push(p); } catch { /* port in use elsewhere */ }
      }
      return json(res, 200, { reversed: done });
    }
    // static
    const f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (f.startsWith(PUBLIC) && fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      return fs.createReadStream(f).pipe(res);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

// Bundler and dev-server ports a debug build is likely to want back on the host.
const DEV_PORTS = [8081, 19000, 19001, 8097, 5173, 3000];

const listening = port => new Promise(resolve => {
  const s = require('net').connect({ host: '127.0.0.1', port });
  const done = ok => { s.destroy(); resolve(ok); };
  s.setTimeout(300);
  s.once('connect', () => done(true));
  s.once('timeout', () => done(false));
  s.once('error', () => done(false));
});

// Only tunnel ports something is actually serving on, so this stays a no-op for release builds.
async function autoReverse() {
  const done = [];
  for (const p of DEV_PORTS) {
    if (!await listening(p)) continue;
    try { await run(['reverse', `tcp:${p}`, `tcp:${p}`]); done.push(p); } catch { /* ignore */ }
  }
  return done;
}

// monkey sometimes fires before the package is ready - confirm it reached the foreground.
async function launch(pkg, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { await run(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']); } catch {}
    for (let t = 0; t < 10; t++) {
      await new Promise(r => setTimeout(r, 500));
      const out = await run(['shell', 'dumpsys', 'activity', 'activities']).catch(() => '');
      if (new RegExp('topResumedActivity.*' + pkg.replace(/./g, '\.')).test(out)) return true;
    }
  }
  return false;
}

async function pkgOf(apk) {
  const aapt = fs.readdirSync(path.join(SDK, 'build-tools')).sort().pop();
  try {
    const out = require('child_process').execFileSync(
      path.join(SDK, 'build-tools', aapt, 'aapt' + EXE), ['dump', 'badging', apk], { encoding: 'utf8' });
    const m = out.match(/package: name='([^']+)'/);
    return m ? m[1] : null;
  } catch { return null; }
}

function listAvds() {
  try {
    return require('child_process').execFileSync(EMULATOR, ['-list-avds'], { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

server.listen(PORT, () => console.log(`droidstream on http://localhost:${PORT}  adb=${ADB}`));
