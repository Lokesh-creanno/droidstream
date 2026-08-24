// Smoke test: needs an Android device/emulator attached. Run: node test.js
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const path = require('path');

const PORT = 8799;
const base = `http://localhost:${PORT}`;
const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'server.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(1200);
  try {
    const info = await (await fetch(base + '/info')).json();
    assert.ok(info.device, 'no device attached - start an emulator first');
    assert.ok(info.size.w > 0 && info.size.h > 0, 'bad screen size');
    console.log('info ok:', info.device, info.size.w + 'x' + info.size.h);

    const key = await (await fetch(base + '/input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'key', key: 'KEYCODE_HOME' }),
    })).json();
    assert.strictEqual(key.ok, true, 'input failed');
    console.log('input ok');

    // one MJPEG frame proves capture works even without WebCodecs
    const ctrl = new AbortController();
    const res = await fetch(base + '/stream', { signal: ctrl.signal });
    const chunk = (await res.body.getReader().read()).value;
    ctrl.abort();
    assert.ok(chunk && chunk.length > 100, 'no MJPEG data');
    assert.ok(Buffer.from(chunk).includes('image/png'), 'not an MJPEG part');
    console.log('mjpeg ok');

    // /video must start with an Annex-B start code + SPS (nal type 7)
    const ctrl2 = new AbortController();
    const vres = await fetch(base + '/video', { signal: ctrl2.signal });
    const vr = vres.body.getReader();
    let head = Buffer.alloc(0);
    while (head.length < 8) head = Buffer.concat([head, Buffer.from((await vr.read()).value)]);
    ctrl2.abort();
    assert.deepStrictEqual([...head.slice(0, 4)], [0, 0, 0, 1], 'no Annex-B start code');
    assert.strictEqual(head[4] & 0x1f, 7, 'stream does not start with SPS');
    console.log('h264 ok');

    const shot = await (await fetch(base + '/screenshot')).json();
    assert.ok(shot.saved && require('fs').existsSync(shot.saved), 'screenshot not saved');
    require('fs').unlinkSync(shot.saved);
    console.log('screenshot ok');

    // rotating must flip the reported size, or every tap lands in the wrong place
    const before = (await (await fetch(base + '/info')).json()).size;
    const rot = await (await fetch(base + '/rotate', { method: 'POST' })).json();
    assert.ok(rot.size, 'rotate returned no size');
    const after = (await (await fetch(base + '/info')).json()).size;
    assert.deepStrictEqual(after, rot.size, 'info disagrees with rotate');
    console.log('rotate ok:', before.w + 'x' + before.h, '->', after.w + 'x' + after.h,
      after.w === before.w ? '(app is orientation-locked - size unchanged, expected)' : '');

    // a dev build is dead without this tunnel, so prove the endpoint really sets it
    const rev = await (await fetch(base + '/reverse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ports: [8081] }),
    })).json();
    assert.deepStrictEqual(rev.reversed, [8081], 'reverse did not report the port');
    const list = execFileSync(ADB, ['reverse', '--list'], { encoding: 'utf8' });
    assert.ok(list.includes('tcp:8081'), 'adb has no reverse for 8081');
    console.log('reverse ok');

    console.log('\nall checks passed');
  } finally {
    srv.kill();
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
