// Smoke test: needs an Android device/emulator attached. Run: node test.js
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8799;
const base = `http://localhost:${PORT}`;
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

    console.log('\nall checks passed');
  } finally {
    srv.kill();
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
