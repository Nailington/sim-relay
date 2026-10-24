const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', process.env.SIM_RELAY_SMOKE_USER_DATA);
app.on('window-all-closed', () => {});
let sequence = 0;
const controls = new Map();
process.on('message', (value) => {
  const pending = controls.get(value.id);
  controls.delete(value.id);
  value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result);
});
const control = (op) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    controls.set(id, { resolve, reject });
    process.send({ id, op });
  });
const js = (window, value) => window.webContents.executeJavaScript(value, true);
async function wait(window, expression) {
  const deadline = Date.now() + 12_000;
  while (!(await js(window, expression))) {
    if (Date.now() > deadline)
      throw new Error(
        `Browser timeout: ${expression}\n${await js(window, 'document.body.innerText.slice(0, 1800)')}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function click(window, text) {
  await js(
    window,
    `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b||b.disabled) throw new Error('Unavailable: '+${JSON.stringify(text)}); b.click(); })()`,
  );
}
const ids = ['A1234567-1234-4123-8123-123456789ABC', 'B1234567-1234-4123-8123-123456789ABC'];
const web = process.env.SIM_RELAY_SMOKE_WEB;
const mac = process.env.SIM_RELAY_SMOKE_MAC;
async function open(user) {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: user, backgroundThrottling: false },
  });
  await window.loadURL(web);
  await js(
    window,
    `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:${JSON.stringify(user)},password:${JSON.stringify(user + '-test-password-long')}})}).then(r=>{if(!r.ok)throw new Error('Login failed')})`,
  );
  await window.loadURL(web);
  await wait(window, `!!window.relay && !!document.querySelector('.host-list')`);
  return window;
}
async function pair(window) {
  const code = await control('pair-code');
  return js(
    window,
    `(async()=>window.relay.pair(await window.relay.probe(${JSON.stringify(mac)}),${JSON.stringify(code)}))()`,
  );
}
async function observe(window) {
  await js(
    window,
    `window.testNotices=[];window.testMedia=[];window.relay.onNotice(n=>window.testNotices.push(n));void window.relay.onMediaNotice(n=>window.testMedia.push(n));`,
  );
}
async function connect(window, profile, index) {
  // Drive the actual React selection and connect controls.
  await wait(window, `document.querySelectorAll('.host-item').length===1`);
  await js(window, `document.querySelector('.host-item').click()`);
  await wait(
    window,
    `document.querySelectorAll('.device-card').length===2 && !document.querySelector('.working-toast')`,
  );
  if (index) await js(window, `document.querySelectorAll('.device-card')[${index}].click()`);
  await click(window, 'Start & connect');
  await wait(
    window,
    `document.querySelector('.stream-badge')?.textContent.trim()==='Live' && !document.querySelector('.working-toast')`,
  );
  assert.match(
    await js(window, `document.querySelector('.viewer-heading').textContent`),
    new RegExp(`Phone ${index ? 'B' : 'A'}`),
  );
}
(async () => {
  await app.whenReady();
  const alice = await open('alice'),
    bob = await open('bob');
  let profileA = await pair(alice);
  const profileB = await pair(bob);
  assert.notEqual(profileA.id, profileB.id);
  console.log('Browser smoke: paired two browser contexts');
  await observe(alice);
  await observe(bob);
  await connect(alice, profileA, 0);
  await connect(bob, profileB, 1);
  await wait(alice, `document.querySelector('[aria-label="Requested frame rate"]').disabled`);
  await click(alice, 'Home');
  await click(bob, 'Lock');
  await js(
    alice,
    `window.relay.setQuality({mode:'manual',maxFps:15,maxScale:0.5,quality:0.6,maxKbps:1000});window.relay.reportVideoFeedback({decoded:3,dropped:1,decodeMs:10,intervalMs:1000});`,
  );
  await wait(
    alice,
    `window.testMedia.some(n=>n.type==='metrics'&&n.metrics.mode==='manual'&&n.metrics.settings.scale===0.5)`,
  );
  assert.ok(
    !(await js(bob, `window.testMedia.some(n=>n.type==='metrics'&&n.metrics.mode==='manual')`)),
  );
  console.log('Browser smoke: UI input and quality isolated');
  // No native capture: the fake backend supplies a deterministic MP4-shaped file.
  await js(alice, `window.relay.startRecording()`);
  await wait(
    alice,
    `window.testMedia.some(n=>n.type==='recording'&&n.recording.phase==='recording')`,
  );
  await js(alice, `window.relay.stopRecording()`);
  await wait(alice, `window.testMedia.some(n=>n.type==='recording'&&n.recording.phase==='ready')`);
  await js(
    alice,
    `window.showSaveFilePicker=undefined;window.downloadLinks=[];window.originalAnchorClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.downloadLinks.push({path:this.getAttribute('href'),filename:this.download})};Response.prototype.blob=()=>{throw new Error('Recording must stream, never create a Blob')};void 0;`,
  );
  assert.equal(
    await js(alice, `window.relay.saveRecording()`),
    false,
    'fallback reports download start, not completion',
  );
  const download = await js(alice, `window.downloadLinks.at(-1).path`);
  assert.match(download, /^\/api\/download\/[\w-]{43}$/);
  assert.equal(
    await js(bob, `fetch(${JSON.stringify(download)}).then(r=>r.status)`),
    404,
    'other cookie cannot consume a download',
  );
  const bytes = await js(
    alice,
    `(async()=>{const r=await fetch(${JSON.stringify(download)});if(!r.ok)throw new Error('Download failed');const reader=r.body.getReader();let bytes=0;for(;;){const n=await reader.read();if(n.done)return bytes;bytes+=n.value.length;}})()`,
  );
  assert.equal(bytes, 2 * 1024 * 1024 + 56);
  assert.equal(
    await js(alice, `fetch(${JSON.stringify(download)}).then(r=>r.status)`),
    404,
    'download is one use',
  );
  await js(
    alice,
    `window.savedBytes=0;window.showSaveFilePicker=async()=>({createWritable:async()=>new WritableStream({write(chunk){window.savedBytes+=chunk.length}})});void 0;`,
  );
  assert.equal(await js(alice, `window.relay.saveRecording()`), true);
  assert.equal(await js(alice, `window.savedBytes`), bytes);
  assert.ok(
    !(await js(
      bob,
      `window.testMedia.some(n=>n.type==='recording'&&n.recording.phase==='recording')`,
    )),
  );
  console.log('Browser smoke: both streaming download paths verified');
  await js(
    alice,
    `window.realCreateObjectURL=URL.createObjectURL;URL.createObjectURL=function(blob){window.exportedJson=blob.text();return window.realCreateObjectURL(blob)};void 0;`,
  );
  const report = await js(alice, `window.relay.diagnostics(${JSON.stringify(profileA.id)})`);
  assert.equal(report.client.platform, 'browser');
  assert.equal(report.checks.find((c) => c.stage === 'authentication').state, 'passed');
  assert.ok(!JSON.stringify(report).includes(mac));
  assert.equal(
    await js(
      alice,
      `window.relay.exportDiagnostics({...${JSON.stringify(report)},secret:'extra'}).then(()=>false,()=>true)`,
    ),
    true,
  );
  await click(alice, 'Diagnostics');
  await wait(alice, `!!document.querySelector('.health-checks')`);
  await click(alice, 'Review report');
  const reviewed = await js(alice, `document.querySelector('.report-preview').textContent`);
  assert.ok(!reviewed.includes(mac));
  await click(alice, 'Save report…');
  await wait(alice, `document.body.innerText.includes('Diagnostic report download started')`);
  const exact = await js(alice, `window.exportedJson`);
  assert.equal(exact, reviewed);
  await js(alice, `document.querySelector('[aria-label="Close dialog"]').click()`);
  console.log('Browser smoke: exact diagnostic review exported');
  // Popup blocking leaves the existing tab connected and its pairing intact.
  assert.match(
    await js(
      alice,
      `(async()=>{const open=window.open;window.open=()=>null;try{await window.relay.popOut(${JSON.stringify(profileA.id)},${JSON.stringify(ids[0])},30);return 'unexpected'}catch(e){return e.message}finally{window.open=open}})()`,
    ),
    /Allow pop-ups/,
  );
  await wait(alice, `document.querySelector('.stream-badge')?.textContent.trim()==='Live'`);
  await js(
    alice,
    `window.relay.popOut(${JSON.stringify(profileA.id)},${JSON.stringify(ids[0])},30)`,
  );
  const popup = BrowserWindow.getAllWindows().find((w) => w !== alice && w !== bob);
  assert.ok(popup);
  await wait(popup, `!!window.relay && !!document.querySelector('.display-identity')`);
  assert.equal((await js(popup, `window.relay.displayContext()`)).device.udid, ids[0]);
  assert.ok(!popup.webContents.getURL().includes(profileA.id));
  await click(popup, 'Connect display');
  await wait(
    popup,
    `document.querySelector('.display-connection')?.textContent.startsWith('Live')`,
  );
  await js(popup, `window.relay.input({type:'button',button:'HOME'})`);
  await js(popup, `void window.relay.returnDisplay();true`);
  const until = Date.now() + 5000;
  while (!popup.isDestroyed()) {
    if (Date.now() > until) throw new Error('Display did not return');
    await new Promise((r) => setTimeout(r, 25));
  }
  await wait(alice, `document.querySelector('.stream-badge')?.textContent.trim()==='Disconnected'`);
  assert.equal(await js(bob, `document.querySelector('.stream-badge').textContent.trim()`), 'Live');
  // Reload restores the browser-local selection without claiming a live connection.
  await alice.loadURL(web);
  await wait(
    alice,
    `document.querySelector('.device-card.active')?.textContent.includes('Phone A')`,
  );
  assert.equal(
    await js(alice, `document.querySelector('.stream-badge').textContent.trim()`),
    'Disconnected',
  );
  await observe(alice);
  await click(alice, 'Start & connect');
  await wait(alice, `document.querySelector('.stream-badge')?.textContent.trim()==='Live'`);
  await control('revoke-alice');
  await wait(alice, `window.testNotices.some(n=>n.state==='failed')`);
  assert.equal(await js(bob, `document.querySelector('.stream-badge').textContent.trim()`), 'Live');
  profileA = await pair(alice);
  await js(
    alice,
    `window.realFetch=window.fetch;window.offlineCalls=0;window.fetch=(url,options)=>{if(url==='/api/session'){window.offlineCalls++;return Promise.reject(new Error('Offline fixture'))}return window.realFetch(url,options)};window.relay.retry();`,
  );
  await wait(alice, `window.testNotices.some(n=>n.state==='retrying')`);
  await js(alice, `window.relay.disconnect();window.fetch=window.realFetch;void 0`);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await js(alice, `window.offlineCalls`), 1, 'disconnect cancels the scheduled retry');
  await js(
    alice,
    `window.relay.connect(${JSON.stringify(profileA.id)},${JSON.stringify(ids[0])},30)`,
  );
  await wait(alice, `document.querySelector('.stream-badge')?.textContent.trim()==='Live'`);
  const sibling = new BrowserWindow({
    show: false,
    webPreferences: { partition: 'alice', backgroundThrottling: false },
  });
  await sibling.loadURL(web);
  await wait(sibling, `!!window.relay && document.querySelectorAll('.host-item').length===1`);
  await js(sibling, `localStorage.removeItem('sim-relay.web.v1.alice')`);
  await wait(
    alice,
    `window.testNotices.some(n=>n.type==='error'&&n.message.includes('another tab'))`,
  );
  assert.equal(await js(alice, `window.relay.hosts().then(h=>h.length)`), 0);
  assert.equal(await js(bob, `window.relay.hosts().then(h=>h.length)`), 1);
  assert.equal(await js(bob, `document.querySelector('.stream-badge').textContent.trim()`), 'Live');
  // Logout invalidates a native-download capability even after signing back in.
  await js(bob, `window.relay.startRecording()`);
  await js(bob, `window.relay.stopRecording()`);
  await js(
    bob,
    `window.showSaveFilePicker=undefined;window.downloadLinks=[];HTMLAnchorElement.prototype.click=function(){window.downloadLinks.push(this.getAttribute('href'))};void 0;`,
  );
  assert.equal(await js(bob, `window.relay.saveRecording()`), false);
  const pending = await js(bob, `window.downloadLinks.at(-1)`);
  await js(bob, `fetch('/api/logout',{method:'POST'}).then(()=>undefined)`);
  assert.equal(await js(bob, `fetch(${JSON.stringify(pending)}).then(r=>r.status)`), 401);
  await js(
    bob,
    `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'bob',password:'bob-test-password-long'})}).then(()=>undefined)`,
  );
  assert.equal(await js(bob, `fetch(${JSON.stringify(pending)}).then(r=>r.status)`), 404);
  const state = await control('events');
  assert.ok(state.closed.includes(ids[0]));
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  console.log(
    'BROWSER_WORKSPACES_SMOKE_OK: two real browser contexts, authenticated UI routing, media quality, streaming download and exact diagnostic export, popout/return, persistence, revocation and cancel',
  );
  app.quit();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
