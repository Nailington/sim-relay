// Run only through native-session-smoke.ts; exercises the actual packaged main/preload/renderer.
const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
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
const ids = ['A1234567-1234-4123-8123-123456789ABC', 'B1234567-1234-4123-8123-123456789ABC'];
(async () => {
  await app.whenReady();
  await wait(() => BrowserWindow.getAllWindows().length === 1);
  const main = BrowserWindow.getAllWindows()[0];
  await ready(main);
  const host = await js(
    main,
    `(async()=>window.relay.pair(await window.relay.probe(${JSON.stringify(process.env.SIM_RELAY_SMOKE_URL)}),${JSON.stringify(process.env.SIM_RELAY_SMOKE_TOKEN)}))()`,
  );
  const hostId = JSON.stringify(host.id);
  await js(
    main,
    `window.nativeNotices=[];window.relay.onNotice(n=>window.nativeNotices.push(n));window.relay.connect(${hostId},${JSON.stringify(ids[0])},30)`,
  );
  await wait(() => js(main, `window.nativeNotices.some(n=>n.type==='metadata')`));
  await js(main, `window.relay.popOut(${hostId},${JSON.stringify(ids[0])},30)`);
  await wait(() => BrowserWindow.getAllWindows().length === 2);
  const a = BrowserWindow.getAllWindows().find((w) => w !== main);
  await ready(a);
  await wait(() =>
    js(a, `!!document.querySelector('canvas') && document.body.innerText.includes('Live')`),
  );
  assert.equal((await js(a, 'window.relay.displayContext()')).device.udid, ids[0]);
  await js(main, `window.relay.connect(${hostId},${JSON.stringify(ids[1])},15)`);
  await wait(() => js(main, `window.nativeNotices.filter(n=>n.type==='metadata').length>=2`));
  await js(main, `window.relay.popOut(${hostId},${JSON.stringify(ids[1])},15)`);
  await wait(() => BrowserWindow.getAllWindows().length === 3);
  const b = BrowserWindow.getAllWindows().find((w) => w !== main && w !== a);
  await ready(b);
  await wait(() =>
    js(b, `!!document.querySelector('canvas') && document.body.innerText.includes('Live')`),
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
  assert.equal(saves, 1);
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
  console.log(
    'NATIVE_SESSION_SMOKE_OK: main/preload, two windows, transfer, independent input, duplicate focus, inactive reservation, per-window dialogs',
  );
  app.quit();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
