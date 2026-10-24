import test from 'node:test';
import assert from 'node:assert/strict';
import { announceBrowserAccount, createBrowserAccount } from '../src/renderer/browser-account';

async function fixture(
  run: (deps: { serverUser(user: string): void; lifetime: AbortController }) => Promise<void>,
) {
  const originals = new Map(
    ['localStorage', 'window', 'fetch'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const stored = new Map<string, string>();
  let user = 'alice';
  const lifetime = new AbortController();
  try {
    Object.defineProperties(globalThis, {
      localStorage: {
        configurable: true,
        value: {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => stored.set(key, value),
        },
      },
      window: { configurable: true, value: new EventTarget() },
      fetch: { configurable: true, value: async () => new Response(JSON.stringify({ user })) },
    });
    announceBrowserAccount('alice');
    await run({
      serverUser: (value) => {
        user = value;
      },
      lifetime,
    });
  } finally {
    lifetime.abort();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('account verification checks server username and permanently invalidates old API scopes', async () =>
  fixture(async ({ serverUser, lifetime }) => {
    let invalidated = 0;
    const account = createBrowserAccount('alice', lifetime.signal, () => {
      invalidated++;
      lifetime.abort();
    });
    await account.verify();
    serverUser('bob');
    await assert.rejects(account.verify(), /sign-in changed/);
    serverUser('alice');
    assert.throws(account.assertCurrent, /sign-in changed/);
    assert.equal(invalidated, 1);
  }));

test('announced account revision cancels delayed preflight even when the fetch ignores abort', async () =>
  fixture(async ({ lifetime }) => {
    const account = createBrowserAccount('alice', lifetime.signal, () => lifetime.abort());
    let release!: (value: Response) => void;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const verifying = account.verify();
    const rejected = assert.rejects(verifying, /sign-in changed/);
    announceBrowserAccount('bob');
    release(new Response(JSON.stringify({ user: 'alice' })));
    await rejected;
    announceBrowserAccount('alice');
    assert.throws(account.assertCurrent, /sign-in changed/);
  }));
