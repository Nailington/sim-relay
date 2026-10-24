const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
app.setPath('userData', process.env.SIM_RELAY_SMOKE_USER_DATA);
app.on('window-all-closed', () => {});
const js = (window, source) => window.webContents.executeJavaScript(source);
async function wait(window, source) {
  const deadline = Date.now() + 15_000;
  while (!(await js(window, source))) {
    if (Date.now() > deadline) throw new Error(`Renderer timed out: ${source}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const clickText = (window, text) =>
  js(
    window,
    `(() => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
  if (!button || button.disabled) throw new Error('Action unavailable: ' + ${JSON.stringify(text)});
  button.click();
})()`,
  );
(async () => {
  await app.whenReady();
  // Separate browser contexts also exercise StrictMode's repeated mount effects.
  for (const scenario of [
    'choose-success',
    'choose-failure',
    'return-success',
    'return-failure',
    'returned-race',
    'returned-race-failure',
  ]) {
    const failLateRequest = scenario.endsWith('failure');
    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        preload: path.resolve('tests/browser-renderer-preload.cjs'),
        contextIsolation: false,
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: `hydration-${scenario}`,
      },
    });
    await window.loadFile(path.resolve('dist/index.html'));
    await wait(
      window,
      `window.hydrationFixture.pending.length > 0 && document.querySelectorAll('.host-item').length === 2`,
    );
    if (scenario.startsWith('returned-race')) {
      await js(window, `window.hydrationFixture.returnA()`);
      await wait(window, `window.hydrationFixture.pendingConnects.length > 0`);
    }
    await js(
      window,
      scenario.startsWith('return')
        ? `window.hydrationFixture.returnB()`
        : `document.querySelectorAll('.host-item')[1].click()`,
    );
    await wait(
      window,
      `document.querySelector('.device-card.active')?.textContent.includes('Hydration Phone B') && !document.querySelector('.working-toast')`,
    );
    await clickText(window, 'Start & connect');
    await wait(
      window,
      `document.querySelector('.stream-badge')?.textContent.includes('Live') && !document.querySelector('.working-toast')`,
    );
    assert.equal(
      await js(window, `document.querySelector('[aria-label="Requested frame rate"]').disabled`),
      false,
      'legacy stream can still change its live frame rate',
    );
    await js(window, `window.hydrationFixture.release(${failLateRequest})`);
    if (scenario.startsWith('returned-race'))
      await js(window, `window.hydrationFixture.failOldConnect()`);
    // Let promise continuations, React commits and the following effect flush finish.
    await js(
      window,
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    assert.match(
      await js(window, `document.querySelector('.workspace-context strong').textContent`),
      /Mac B/,
    );
    assert.match(
      await js(window, `document.querySelector('.host-item.selected').textContent`),
      /Mac B/,
    );
    assert.match(
      await js(window, `document.querySelector('.device-card.active').textContent`),
      /Phone B/,
    );
    assert.match(
      await js(window, `document.querySelector('.viewer-heading').textContent`),
      /Phone B/,
    );
    assert.equal(
      await js(window, `document.querySelector('[aria-label="Requested frame rate"]').value`),
      '30',
    );
    assert.equal(await js(window, `!!document.querySelector('[role="alert"]')`), false);
    await js(
      window,
      `(() => { const select = document.querySelector('[aria-label="Requested frame rate"]'); select.value='60'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`,
    );
    await wait(
      window,
      `window.hydrationFixture.calls.some(c=>c.action==='connect'&&c.id==='host-B'&&c.fps===60) && !document.querySelector('.working-toast')`,
    );
    await js(window, `window.hydrationFixture.advertiseAdaptive()`);
    await wait(window, `document.querySelector('[aria-label="Requested frame rate"]').disabled`);
    await js(window, `window.hydrationFixture.manualQuality()`);
    await wait(
      window,
      `[...document.querySelectorAll('.media-controls select')].some(s=>s.value==='manual')`,
    );
    assert.equal(
      await js(window, `window.hydrationFixture.calls.filter(c=>c.action==='quality').length`),
      0,
      'capabilities and cached quality state never write defaults back to the host',
    );
    await clickText(window, 'Home');
    await clickText(window, 'Save screenshotPNG');
    await wait(window, `!document.querySelector('.working-toast')`);
    await clickText(window, 'Dark');
    await wait(window, `!document.querySelector('.working-toast')`);
    const calls = await js(window, 'window.hydrationFixture.calls');
    for (const action of ['connect', 'input', 'screenshot']) {
      const call = calls.filter((value) => value.action === action).at(-1);
      assert.ok(call, `${action} reached the API`);
      assert.equal(call.id, 'host-B');
      assert.equal(call.udid, 'device-B');
    }
    assert.ok(calls.some((c) => c.id === 'host-B' && c.path === '/devices/device-B/appearance'));
    assert.ok(
      !calls.some(
        (c) =>
          c.id === 'host-A' &&
          c.action !== 'connect' &&
          (c.action !== 'request' || c.path !== '/devices'),
      ),
    );
    assert.equal(calls.filter((c) => c.action === 'save').at(-1).hostId, 'host-B');
    window.destroy();
  }
  console.log(
    'BROWSER_RENDERER_SMOKE_OK: real React late hydration success/failure preserve B selection, frame rate, actions and saved preferences',
  );
  app.quit();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
