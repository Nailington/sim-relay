import { SessionFailure } from '../electron/session';

const accountKey = 'sim-relay.web.account.v1';
const accountEvent = 'sim-relay-account-change';
let memory: string | null = null;

export function browserAccountSnapshot(): string | null {
  try {
    return localStorage.getItem(accountKey);
  } catch {
    return memory;
  }
}
export function browserAccountUser(snapshot = browserAccountSnapshot()): string | undefined {
  try {
    const value = JSON.parse(snapshot ?? 'null');
    return typeof value?.user === 'string' ? value.user : undefined;
  } catch {
    return undefined;
  }
}
/** No credentials: this revision only invalidates existing APIs in this browser profile. */
export function announceBrowserAccount(user?: string) {
  memory = JSON.stringify({ user: user ?? null, revision: crypto.randomUUID() });
  try {
    localStorage.setItem(accountKey, memory);
  } catch {
    /* Server identity remains authoritative when storage is unavailable. */
  }
  window.dispatchEvent(new Event(accountEvent));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(accountKey);
    channel.postMessage(memory);
    channel.close();
  }
}
export function watchBrowserAccount(
  changed: (snapshot: string | null) => void,
  signal: AbortSignal,
) {
  const update = () => changed(browserAccountSnapshot());
  window.addEventListener(accountEvent, update, { signal });
  window.addEventListener(
    'storage',
    (event) => {
      if (event.key === accountKey || event.key === null) update();
    },
    { signal },
  );
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(accountKey);
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      // Delivery may lag a later login. The current shared marker wins over an older message.
      try {
        changed(localStorage.getItem(accountKey));
      } catch {
        memory = event.data;
        changed(memory);
      }
    };
    signal.addEventListener('abort', () => channel.close(), { once: true });
  }
}

export function createBrowserAccount(user: string, signal: AbortSignal, invalidated: () => void) {
  const revision = browserAccountSnapshot();
  let valid = true;
  const failure = () =>
    new SessionFailure('Your sign-in changed. Open this workspace again to continue.', true);
  const invalidate = () => {
    if (valid) {
      valid = false;
      invalidated();
    }
  };
  const isCurrent = () =>
    valid &&
    !signal.aborted &&
    revision === browserAccountSnapshot() &&
    (revision === null || browserAccountUser(revision) === user);
  const assertCurrent = () => {
    if (!isCurrent()) {
      invalidate();
      throw failure();
    }
  };
  watchBrowserAccount((snapshot) => {
    if (snapshot !== revision) invalidate();
  }, signal);
  return {
    user,
    assertCurrent,
    isCurrent,
    invalidate,
    async verify(openingSignal?: AbortSignal) {
      assertCurrent();
      const response = await fetch('/api/session', {
        credentials: 'same-origin',
        signal: openingSignal ? AbortSignal.any([signal, openingSignal]) : signal,
      });
      const value = await response.json();
      assertCurrent();
      openingSignal?.throwIfAborted();
      if (!response.ok || value.user !== user) {
        invalidate();
        throw failure();
      }
    },
  };
}
export type BrowserAccount = ReturnType<typeof createBrowserAccount>;
