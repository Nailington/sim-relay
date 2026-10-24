// Real built React app, shared Chromium cookie/storage partition, real local HTTP/TLS relay.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', process.env.SIM_RELAY_SMOKE_USER_DATA);
app.on('window-all-closed', () => {});
let sequence = 0;
const pending = new Map();
process.on('message', (value) => {
  const p = pending.get(value.id);
  pending.delete(value.id);
  value.error ? p.reject(new Error(value.error)) : p.resolve(value.result);
});
const control = (op) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    process.send({ id, op });
  });
const js = (window, source) => window.webContents.executeJavaScript(source, true);
async function wait(window, source) {
  const deadline = Date.now() + 12_000;
  while (!(await js(window, source))) {
    if (Date.now() > deadline)
      throw new Error(
        `Identity smoke timed out: ${source}\n${await js(window, 'document.body.innerText.slice(0,800)')}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function click(window, text) {
  await js(
    window,
    `(() => { const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button||button.disabled)throw new Error('Control unavailable');button.click() })()`,
  );
}
const web = process.env.SIM_RELAY_SMOKE_WEB;
const mac = process.env.SIM_RELAY_SMOKE_MAC;
const device = 'A1234567-1234-4123-8123-123456789ABC';
async function tab() {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: 'identity-shared', backgroundThrottling: false },
  });
  await window.loadURL(web);
  return window;
}
async function signIn(window, user) {
  await wait(window, `!!document.querySelector('.browser-sign-in form')`);
  await wait(
    window,
    `!!document.querySelector('.browser-sign-in button[type=submit]:not(:disabled)')`,
  );
  await js(
    window,
    `(() => { const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    for(const [selector,value] of [['input[autocomplete=username]',${JSON.stringify(user)}],['input[type=password]',${JSON.stringify(user + '-test-password-long')}]]){
      const input=document.querySelector(selector);set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));
    } document.querySelector('form').requestSubmit(); })()`,
  );
  await wait(
    window,
    `document.querySelector('.browser-account span')?.textContent.trim()==='Browser workspace · ${user}' && !!window.relay`,
  );
}
async function pair(window) {
  const code = await control('pair-code');
  const host = await js(
    window,
    `(async()=>window.relay.pair(await window.relay.probe(${JSON.stringify(mac)}),${JSON.stringify(code)}))()`,
  );
  return host;
}
async function readyHost(window) {
  await wait(window, `document.querySelectorAll('.host-item').length===1`);
  await js(window, `document.querySelector('.host-item').click()`);
  await wait(
    window,
    `document.querySelectorAll('.device-card').length===2&&!document.querySelector('.working-toast')`,
  );
}
async function holdOpening(window, hostId, blockStorage = false) {
  await js(
    window,
    `window.originalFetch=window.fetch;window.heldAuth=false;window.openingFinished=false;window.credentialWrites=0;window.socketOpens=0;
    window.fetch=async(url,options)=>{const response=await window.originalFetch(url,options);if(url==='/api/session'&&!window.heldAuth){window.heldAuth=true;await new Promise(resolve=>window.releaseAuth=resolve)}return response};
    window.NativeSocket=window.WebSocket;window.WebSocket=class extends window.NativeSocket{constructor(...args){super(...args);window.socketOpens++}send(data){if(JSON.parse(data).profile)window.credentialWrites++;super.send(data)}};
    window.blockReset=event=>{if(${blockStorage}&&(event.key==='sim-relay.web.v1.alice'||event.key==='sim-relay.web.v1.alice.reset'))event.stopImmediatePropagation()};window.addEventListener('storage',window.blockReset,true);
    window.oldAlice=window.relay;window.openingNotices=[];void window.oldAlice.onNotice(n=>window.openingNotices.push(n));
    void window.oldAlice.connect(${JSON.stringify(hostId)},${JSON.stringify(device)},30).then(()=>window.openingFinished=true,()=>window.openingFinished=true);void 0;`,
  );
  await wait(window, `window.heldAuth`);
}
async function releaseOpening(window) {
  await js(
    window,
    `window.releaseAuth();window.fetch=window.originalFetch;window.WebSocket=window.NativeSocket;window.removeEventListener('storage',window.blockReset,true);void 0;`,
  );
  await wait(window, `window.openingFinished===true`);
  assert.equal(await js(window, `window.credentialWrites`), 0);
  assert.equal(await js(window, `window.socketOpens`), 0);
}
(async () => {
  await app.whenReady();
  const alice = await tab();
  await signIn(alice, 'alice');
  let profileA = await pair(alice);
  const sibling = await tab();
  await wait(
    sibling,
    `document.querySelector('.browser-account span')?.textContent.includes('alice')`,
  );
  for (const blockStorage of [false, true]) {
    await readyHost(alice);
    await holdOpening(alice, profileA.id, blockStorage);
    await click(sibling, 'Clear saved setup');
    await click(sibling, 'Clear this browser’s setup');
    await wait(sibling, `!!window.relay && localStorage.getItem('sim-relay.web.v1.alice')===null`);
    await releaseOpening(alice);
    assert.equal(await js(alice, `window.relay.hosts().then(h=>h.length)`), 0);
    if (!blockStorage)
      assert.ok(
        await js(alice, `window.openingNotices.some(n=>n.state==='off')`),
        'storage reset cancels an opening session immediately',
      );
    profileA = await pair(alice);
    await alice.loadURL(web);
    await sibling.loadURL(web);
    await wait(alice, `!!window.relay && !!document.querySelector('.host-list')`);
    await wait(sibling, `!!window.relay && !!document.querySelector('.host-list')`);
  }
  console.log(
    'Identity smoke: pending authentication cannot resurrect reset pairing, even with reset events blocked',
  );
  await readyHost(alice);
  const savedAlice = await js(alice, `localStorage.getItem('sim-relay.web.v1.alice')`);
  await holdOpening(alice, profileA.id);
  await click(sibling, 'Sign out');
  await signIn(sibling, 'bob');
  await wait(
    alice,
    `document.querySelector('.browser-account span')?.textContent.trim()==='Browser workspace · bob' && !!window.relay`,
  );
  assert.equal(await js(alice, `document.querySelectorAll('.host-item').length`), 0);
  assert.equal(
    await js(alice, `!!document.querySelector('.viewer-heading')`),
    false,
    'Bob gets a fresh React workspace without Alice selection/actions',
  );
  assert.equal(await js(alice, `window.relay===window.oldAlice`), false);
  await releaseOpening(alice);
  const staleResults = await js(
    alice,
    `(async()=>{const actions=[()=>window.oldAlice.hosts(),()=>window.oldAlice.request(${JSON.stringify(profileA.id)},'GET','/devices'),()=>window.oldAlice.probe(${JSON.stringify(mac)}),()=>window.oldAlice.pair({info:{name:'Test'},url:${JSON.stringify(mac)}},'test-code'),()=>window.oldAlice.forget(${JSON.stringify(profileA.id)}),()=>window.oldAlice.installApp(${JSON.stringify(profileA.id)},${JSON.stringify(device)}),()=>window.oldAlice.saveScreenshot(${JSON.stringify(profileA.id)},${JSON.stringify(device)})];return Promise.all(actions.map(action=>Promise.resolve().then(action).then(()=>false,()=>true)))})()`,
  );
  assert.equal(
    await js(
      alice,
      `window.oldAlice.input({type:'button',button:'HOME'});window.oldAlice.input({type:'release'});window.credentialWrites`,
    ),
    0,
    'disposed input and cleanup release safely drop without forwarding',
  );
  assert.ok(
    staleResults.every(Boolean),
    'all stale profile/action/pair APIs reject before dispatch or local mutation',
  );
  assert.equal(await js(alice, `localStorage.getItem('sim-relay.web.v1.alice')`), savedAlice);
  const profileB = await pair(sibling);
  assert.notEqual(profileA.id, profileB.id);
  await readyHost(alice);
  await click(alice, 'Start & connect');
  await wait(alice, `document.querySelector('.stream-badge')?.textContent.trim()==='Live'`);
  const savedBob = await js(alice, `localStorage.getItem('sim-relay.web.v1.bob')`);
  await click(sibling, 'Sign out');
  await signIn(sibling, 'alice');
  await wait(
    alice,
    `document.querySelector('.browser-account span')?.textContent.trim()==='Browser workspace · alice'&&!!window.relay`,
  );
  assert.equal(
    await js(
      alice,
      `window.oldAlice.request(${JSON.stringify(profileA.id)},'GET','/devices').then(()=>false,()=>true)`,
    ),
    true,
    'old API remains invalid when the cookie returns to Alice',
  );
  assert.equal(await js(alice, `localStorage.getItem('sim-relay.web.v1.alice')`), savedAlice);
  assert.equal(await js(alice, `localStorage.getItem('sim-relay.web.v1.bob')`), savedBob);
  console.log(
    'Identity smoke: real Alice/Bob React sign-in controls remount siblings and retain both saved profile namespaces',
  );
  // No announcement: validate server identity rather than depending on storage/BroadcastChannel delivery.
  await js(
    alice,
    `window.unannouncedAlice=window.relay;fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'bob',password:'bob-test-password-long'})}).then(()=>undefined)`,
  );
  assert.equal(
    await js(
      alice,
      `window.unannouncedAlice.request(${JSON.stringify(profileA.id)},'GET','/devices').then(()=>false,()=>true)`,
    ),
    true,
  );
  await wait(alice, `!!document.querySelector('.browser-sign-in form')`);
  await signIn(alice, 'alice');
  assert.equal(
    await js(
      alice,
      `window.unannouncedAlice.forget(${JSON.stringify(profileA.id)}).then(()=>false,()=>true)`,
    ),
    true,
  );
  // Switch the cookie AFTER the preflight check but BEFORE the actual POST dispatch.
  await js(
    alice,
    `window.raceApi=window.relay;window.nativeFetch=window.fetch;window.postIdentity='';window.postStatus=0;window.swapOnce=true;
    window.fetch=async(url,options)=>{if(url==='/api/request'&&window.swapOnce){window.swapOnce=false;window.postIdentity=options.headers['X-Sim-Relay-User'];await window.nativeFetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:'bob',password:'bob-test-password-long'})});const response=await window.nativeFetch(url,options);window.postStatus=response.status;return response}return window.nativeFetch(url,options)};void 0;`,
  );
  assert.equal(
    await js(
      alice,
      `window.raceApi.request(${JSON.stringify(profileA.id)},'GET','/devices').then(()=>false,()=>true)`,
    ),
    true,
  );
  assert.equal(await js(alice, `window.postIdentity`), 'alice');
  assert.equal(await js(alice, `window.postStatus`), 401);
  assert.equal(await js(alice, `localStorage.getItem('sim-relay.web.v1.alice')`), savedAlice);
  await js(alice, `window.fetch=window.nativeFetch;void 0;`);
  console.log(
    'Identity smoke: server user verification and required identity close unannounced and between-request cookie switches',
  );
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  console.log(
    'BROWSER_IDENTITY_SMOKE_OK: opening/reset races, shared-profile account handoff, stale API permanence, unchanged saved pairings and identity-bound actions',
  );
  app.quit();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
