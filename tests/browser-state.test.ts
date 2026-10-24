import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserStorageKey,
  clearBrowserWorkspace,
  createBrowserApi,
  disposeBrowserApi,
} from '../src/renderer/browser-api';
import type { Profile, Probe, DesktopApi } from '../src/shared/types';

test('reset is visible to existing tabs and pairing cannot resurrect their stale credentials', async () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const documentFixture = new EventTarget();
  const windowFixture = new EventTarget();
  const originals = new Map(
    ['localStorage', 'document', 'window', 'fetch', 'location', 'WebSocket'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const sockets: FakeSocket[] = [];
  const apis: DesktopApi[] = [];
  let signedInUser = 'alice';
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    binaryType = '';
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    onerror?: () => void;
    constructor(_url: URL) {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(value: string) {
      if ('profile' in JSON.parse(value))
        setTimeout(() =>
          this.onmessage?.({
            data: JSON.stringify({
              type: 'metadata',
              metadata: { width: 100, height: 200, widthPoints: 100, heightPoints: 200 },
            }),
          }),
        );
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code: 1000 }));
    }
  }
  const profile: Profile = {
    id: '218f5525-50cf-4313-8f44-d58d64811d38',
    name: 'Old Mac',
    url: 'https://old.local:49300',
    certificate: 'certificate',
    fingerprint: 'fingerprint',
    token: 'old-private-credential',
    source: 'saved',
  };
  const probe: Probe = {
    url: 'https://new.local:49300',
    certificate: 'certificate-new',
    fingerprint: 'fingerprint-new',
    info: { name: 'New Mac', platform: 'macOS', version: '0.1.5', companion: true, xcode: true },
  };
  try {
    Object.defineProperties(globalThis, {
      localStorage: { configurable: true, value: storage },
      document: { configurable: true, value: documentFixture },
      window: { configurable: true, value: windowFixture },
      location: {
        configurable: true,
        value: { href: 'http://127.0.0.1:49301', protocol: 'http:' },
      },
      WebSocket: { configurable: true, value: FakeSocket },
      fetch: {
        configurable: true,
        value: async (_url: string, options: { body: string }) => {
          if (_url === '/api/session') return new Response(JSON.stringify({ user: signedInUser }));
          const value = JSON.parse(options.body);
          return new Response(
            JSON.stringify({ ...value.profile, token: 'new-private-credential' }),
            { status: 200 },
          );
        },
      },
    });
    storage.setItem(browserStorageKey('alice'), JSON.stringify([profile]));
    storage.setItem(browserStorageKey('bob'), JSON.stringify([profile]));
    const firstTab = createBrowserApi('alice'),
      secondTab = createBrowserApi('alice'),
      otherUser = createBrowserApi('bob');
    apis.push(firstTab, secondTab, otherUser);
    assert.equal((await secondTab.hosts()).length, 1);
    await secondTab.connect(profile.id, '218f5525-50cf-4313-8f44-d58d64811d39', 30);
    assert.equal(sockets[0].readyState, 1);
    await clearBrowserWorkspace('alice');
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: browserStorageKey('alice') });
    windowFixture.dispatchEvent(event);
    assert.equal(sockets[0].readyState, 3, 'reset disconnects the affected tab transport');
    assert.deepEqual(await firstTab.hosts(), []);
    assert.deepEqual(await secondTab.hosts(), []);
    signedInUser = 'bob';
    assert.equal((await otherUser.hosts()).length, 1, 'another user namespace is unaffected');
    signedInUser = 'alice';
    await secondTab.pair(probe, 'single-use-code');
    const saved = storage.getItem(browserStorageKey('alice'))!;
    assert.equal(saved.includes('old-private-credential'), false);
    assert.equal((await firstTab.hosts())[0].name, 'New Mac');
    await firstTab.forget((await firstTab.hosts())[0].id);
    assert.deepEqual(await secondTab.hosts(), []);
    for (const malformed of ['null', '[]', '"bad"', '{']) {
      storage.setItem(browserStorageKey('alice') + '.preferences', malformed);
      assert.deepEqual(firstTab.workspace!.restore(), {});
    }
  } finally {
    for (const api of apis) disposeBrowserApi(api);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('an in-flight pairing cannot append a credential after another tab explicitly resets setup', async () => {
  const originals = new Map(
    ['localStorage', 'window', 'document', 'location', 'fetch'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const data = new Map<string, string>();
  let api: DesktopApi | undefined;
  let finishPair!: (value: Response) => void;
  let pairStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    pairStarted = resolve;
  });
  let pending = true;
  const profile: Profile = {
    id: '218f5525-50cf-4313-8f44-d58d64811d38',
    name: 'New Mac',
    url: 'https://new.test:49300',
    fingerprint: 'pin',
    certificate: 'certificate',
    token: 'new-test-credential',
    source: 'saved',
  };
  const probe: Probe = {
    url: profile.url,
    fingerprint: profile.fingerprint,
    certificate: profile.certificate,
    info: { name: profile.name, version: '0.1.5', platform: 'macOS', xcode: true, companion: true },
  };
  try {
    Object.defineProperties(globalThis, {
      localStorage: {
        configurable: true,
        value: {
          getItem: (key: string) => data.get(key) ?? null,
          setItem: (key: string, value: string) => data.set(key, value),
          removeItem: (key: string) => data.delete(key),
        },
      },
      window: { configurable: true, value: new EventTarget() },
      document: { configurable: true, value: new EventTarget() },
      location: {
        configurable: true,
        value: { href: 'http://127.0.0.1:49301', protocol: 'http:' },
      },
      fetch: {
        configurable: true,
        value: async (url: string) => {
          if (url === '/api/session') return new Response(JSON.stringify({ user: 'alice' }));
          if (pending) {
            pairStarted();
            return new Promise<Response>((resolve) => {
              finishPair = resolve;
            });
          }
          return new Response(JSON.stringify(profile));
        },
      },
    });
    api = createBrowserApi('alice');
    const pairing = api.pair(probe, 'pairing-code');
    const rejected = assert.rejects(pairing, /cleared while pairing/);
    await started;
    await clearBrowserWorkspace('alice');
    finishPair(new Response(JSON.stringify(profile)));
    await rejected;
    assert.equal(data.get(browserStorageKey('alice')), undefined);
    pending = false;
    await api.pair(probe, 'fresh-pairing-code');
    assert.equal(
      (await api.hosts())[0].id,
      profile.id,
      'a new explicit pairing after reset can save normally',
    );
  } finally {
    disposeBrowserApi(api);
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
