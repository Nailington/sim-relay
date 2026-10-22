// Native Electron verification, using a temporary profile rather than saved user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-relay-desktop-'));
app.setPath('userData', directory);
app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let finished = false;
const timeout = setTimeout(
  () => finish(new Error('Desktop smoke test timed out after 90 seconds.')),
  90000,
);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) {
    console.error(error);
    process.exitCode = 1;
  } else console.log('Native desktop smoke: PASS');
  app.quit();
}
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const evaluate = (code) => window.webContents.executeJavaScript(code);
      assert.equal(await evaluate('window.relay.platform'), process.platform);
      assert.equal(
        await evaluate('document.querySelector("h1").textContent'),
        'Big ideas. Any screen.',
      );
      await evaluate('window.relay.hosts()');
      console.log('Renderer loaded; context isolation and IPC bridge work.');
      if (process.env.SIM_RELAY_TEST_TOKEN_FILE) {
        const token = fs.readFileSync(process.env.SIM_RELAY_TEST_TOKEN_FILE, 'utf8').trim();
        const url = process.env.SIM_RELAY_TEST_URL || 'https://127.0.0.1:49310';
        await evaluate(
          `(async () => { const probe = await window.relay.probe(${JSON.stringify(url)}); return window.relay.pair(probe, ${JSON.stringify(token)}); })()`,
        );
        await sleep(4500);
        await evaluate('document.querySelector(".host-item").click()');
        for (let i = 0; i < 60; i++) {
          if (await evaluate('!!document.querySelector(".device-card")')) break;
          await sleep(500);
        }
        const name = process.env.SIM_RELAY_TEST_DEVICE_NAME || 'Sim Relay E2E';
        const found = await evaluate(
          `(() => { const device = [...document.querySelectorAll('.device-card')].find(e => e.textContent.includes(${JSON.stringify(name)})); if (device) device.click(); return !!device; })()`,
        );
        assert.equal(found, true, 'The test simulator must exist on the Mac.');
        await sleep(300);
        await evaluate('document.querySelector(".viewer-heading .button.primary").click()');
        let live = false;
        for (let i = 0; i < 100; i++) {
          const status = await evaluate(
            '({live:!!document.querySelector(".stream-badge.live"), text:document.querySelector(".quality-note")?.textContent, error:document.querySelector(".error-banner")?.textContent})',
          );
          if (status.error) throw new Error(status.error);
          if (status.live && /^[1-9]\d* frames/.test(status.text || '')) {
            live = true;
            console.log('Real simulator video decoded inside the Electron renderer:', status.text);
            break;
          }
          await sleep(500);
        }
        assert.equal(live, true, 'A real simulator frame must reach the native app.');
        await evaluate('document.querySelector(".control-grid button").click()');
      }
      await sleep(500);
      fs.writeFileSync(
        '/tmp/sim-relay-desktop.png',
        (await window.webContents.capturePage()).toPNG(),
      );
      assert.ok(
        (
          await evaluate(
            '({width:innerWidth,height:innerHeight,content:document.body.scrollWidth})',
          )
        ).width > 0,
      );
      console.log('Saved native window screenshot to /tmp/sim-relay-desktop.png.');
      finish();
    } catch (error) {
      finish(error);
    }
  });
});
require(process.env.SIM_RELAY_SMOKE_APP_PATH || '../dist-electron/main.cjs');
