// Run only through native-session-smoke.ts; exercises the actual packaged main/preload/renderer.
const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
app.setPath('userData', process.env.SIM_RELAY_SMOKE_USER_DATA);
require(path.resolve('dist-electron/main.cjs'));
const wait = async (check) => {
  const until = Date.now() + 20000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('native smoke timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const js = (w, expression) => w.webContents.executeJavaScript(expression);
const ready = (w) =>
  wait(async () => !w.webContents.isLoading() && (await js(w, '!!window.relay')));
const snapshot = async (owner, name) => {
  if (!process.env.SIM_RELAY_SMOKE_ARTIFACT_DIR) return;
  await fs.mkdir(process.env.SIM_RELAY_SMOKE_ARTIFACT_DIR, { recursive: true });
  await js(
    owner,
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  const image = await owner.webContents.capturePage();
  await fs.writeFile(
    path.join(process.env.SIM_RELAY_SMOKE_ARTIFACT_DIR, `${name}.png`),
    image.toPNG(),
  );
};
const ids = [
  'A1234567-1234-4123-8123-123456789ABC',
  'B1234567-1234-4123-8123-123456789ABC',
  'C1234567-1234-4123-8123-123456789ABC',
];
(async () => {
  await app.whenReady();
  await wait(() => BrowserWindow.getAllWindows().length === 1);
  const main = BrowserWindow.getAllWindows()[0];
  await ready(main);
  const host = await js(
    main,
    `(async()=>window.relay.pair(await window.relay.probe(${JSON.stringify(process.env.SIM_RELAY_SMOKE_URL)}),${JSON.stringify(process.env.SIM_RELAY_SMOKE_PAIRING_CODE)}))()`,
  );
  const hostId = JSON.stringify(host.id);
  await js(
    main,
    `window.nativeNotices=[];window.relay.onNotice(n=>window.nativeNotices.push(n));window.relay.connect(${hostId},${JSON.stringify(ids[0])},30)`,
  );
  await wait(() => js(main, `window.nativeNotices.some(n=>n.type==='metadata')`));
  await js(main, 'window.relay.startRecording()');
  await js(main, 'window.relay.startAudio(true)');
  await js(main, `window.relay.popOut(${hostId},${JSON.stringify(ids[0])},30)`);
  await wait(() => BrowserWindow.getAllWindows().length === 2);
  const a = BrowserWindow.getAllWindows().find((w) => w !== main);
  await ready(a);
  await wait(() =>
    js(a, `!!document.querySelector('canvas') && document.body.innerText.includes('Live')`),
  );
  assert.equal((await js(a, 'window.relay.displayContext()')).device.udid, ids[0]);
  await wait(() => js(a, `!!document.querySelector('.recording-indicator')`));
  await assert.rejects(js(main, 'window.relay.stopRecording()'), /Connect to a simulator/);
  await js(
    a,
    `window.relay.setQuality({mode:'manual',maxFps:10,maxScale:0.5,quality:0.6,maxKbps:5000})`,
  );
  await js(a, 'window.relay.stopAudio()');
  a.setSize(680, 900);
  await wait(() => js(a, 'innerWidth===680'));
  await js(
    a,
    `[...document.querySelectorAll('.display-menu')].find(d=>d.querySelector('summary').textContent==='Media').open=true`,
  );
  await snapshot(a, 'popout-media-680x900');
  a.setSize(360, 680);
  await wait(() => js(a, 'innerWidth===360'));
  assert.equal(await js(a, 'document.documentElement.scrollWidth <= innerWidth'), true);
  await snapshot(a, 'popout-media-360x680');
  await js(a, `document.querySelector('.display-menu[open]').open=false`);
  a.setSize(680, 900);
  await js(main, `window.relay.connect(${hostId},${JSON.stringify(ids[1])},15)`);
  await wait(() => js(main, `window.nativeNotices.filter(n=>n.type==='metadata').length>=2`));
  await js(main, `window.relay.popOut(${hostId},${JSON.stringify(ids[1])},15)`);
  await wait(() => BrowserWindow.getAllWindows().length === 3);
  const b = BrowserWindow.getAllWindows().find((w) => w !== main && w !== a);
  await ready(b);
  await wait(() =>
    js(b, `!!document.querySelector('canvas') && document.body.innerText.includes('Live')`),
  );
  await js(b, 'window.relay.startRecording()');
  await js(
    b,
    `window.relay.setQuality({mode:'manual',maxFps:5,maxScale:0.5,quality:0.6,maxKbps:5000})`,
  );
  await js(a, 'window.relay.stopRecording()');
  await wait(() =>
    js(
      a,
      `document.querySelector('[aria-label="Media controls"]').textContent.includes('Save MP4')`,
    ),
  );
  await js(a, `window.relay.input({type:'button',button:'HOME'})`);
  await js(b, `window.relay.input({type:'button',button:'LOCK'})`);
  let saves = 0,
    installs = 0;
  dialog.showSaveDialog = async (owner) => {
    assert.equal(owner, a);
    saves++;
    return { canceled: true };
  };
  dialog.showOpenDialog = async (owner) => {
    assert.equal(owner, b);
    installs++;
    return { canceled: true, filePaths: [] };
  };
  assert.equal(
    await js(a, `window.relay.saveScreenshot(${hostId},${JSON.stringify(ids[0])})`),
    false,
  );
  assert.equal(await js(b, `window.relay.installApp(${hostId},${JSON.stringify(ids[1])})`), false);
  assert.equal(await js(a, 'window.relay.saveRecording()'), false);
  assert.equal(saves, 2);
  assert.equal(installs, 1);
  await js(main, `window.relay.popOut(${hostId},${JSON.stringify(ids[0])},30)`);
  assert.equal(BrowserWindow.getAllWindows().length, 3);
  // Explicit disconnect releases its reservation; the other window may connect this target.
  await js(b, 'window.relay.disconnect()');
  await js(main, `window.relay.connect(${hostId},${JSON.stringify(ids[1])},30)`);
  await wait(() => js(main, `window.nativeNotices.filter(n=>n.type==='metadata').length>=3`));
  // Returning A moves the active workspace B into another display instead of interrupting it.
  await js(a, 'void window.relay.returnDisplay(); true');
  await wait(() => a.isDestroyed());
  assert.equal(BrowserWindow.getAllWindows().length, 3);
  await wait(() => js(main, `document.body.innerText.includes('Native A')`));
  await js(main, `window.relay.input({type:'button',button:'VOLUME_UP'})`);
  main.setSize(1280, 800);
  await wait(() => js(main, 'innerWidth===1280'));
  await snapshot(main, 'workspace-1280x800');
  b.close();
  assert.equal(main.isDestroyed(), false);
  await js(main, `window.relay.popOut(${hostId},${JSON.stringify(ids[0])},30)`);
  const returned = BrowserWindow.getAllWindows().find(
    (w) =>
      w !== main &&
      w.webContents.getURL().includes('display=1') &&
      w.getTitle().includes('Native A'),
  );
  assert.ok(returned);
  await ready(returned);
  main.close();
  await wait(() => main.isDestroyed());
  await js(returned, 'void window.relay.returnDisplay(); true');
  await wait(() => returned.isDestroyed());
  const reopened = BrowserWindow.getAllWindows().find(
    (w) => !w.webContents.getURL().includes('display=1'),
  );
  assert.ok(reopened);
  await ready(reopened);
  await wait(() => js(reopened, `document.body.innerText.includes('Native A')`));
  // Two returns race while a third active workspace session is detached asynchronously.
  await js(reopened, `window.relay.popOut(${hostId},${JSON.stringify(ids[0])},30)`);
  const concurrentA = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Native A'));
  const concurrentB = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Native B'));
  assert.ok(concurrentA && concurrentB);
  await ready(concurrentA);
  await wait(() => js(concurrentA, `document.body.innerText.includes('Live')`));
  await js(reopened, `window.relay.connect(${hostId},${JSON.stringify(ids[2])},30)`);
  await js(
    reopened,
    `window.concurrentLive=false;window.relay.onNotice(n=>{if(n.type==='metadata')window.concurrentLive=true});true`,
  );
  await js(reopened, `window.relay.connect(${hostId},${JSON.stringify(ids[2])},30)`);
  await wait(() => js(reopened, 'window.concurrentLive'));
  const originalLoadFile = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = async function (...args) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return originalLoadFile.apply(this, args);
  };
  await Promise.all(
    [concurrentA, concurrentB].map((owner) => js(owner, 'void window.relay.returnDisplay();true')),
  );
  await wait(() => concurrentA.isDestroyed() && concurrentB.isDestroyed());
  BrowserWindow.prototype.loadFile = originalLoadFile;
  assert.equal(BrowserWindow.getAllWindows().length, 3);
  for (const owner of BrowserWindow.getAllWindows()) {
    await ready(owner);
    const context = await js(owner, 'window.relay.displayContext()');
    const id = context?.device.udid ?? ids[1];
    // Reannounce verifies ownership and host lease without creating a replacement transport.
    await js(owner, `window.relay.connect(${hostId},${JSON.stringify(id)},30)`);
    const index = ids.indexOf(id);
    await js(
      owner,
      `window.relay.input({type:'key',code:${40}+${index},phase:'down'});window.relay.input({type:'key',code:${40}+${index},phase:'up'})`,
    );
  }
  console.log(
    'NATIVE_SESSION_SMOKE_OK: main/preload, two windows, transfer, independent input, duplicate focus, inactive reservation, per-window dialogs',
  );
  app.quit();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
