import type { DesktopApi, DisplayContext, Inventory } from '../shared/types';

/** Only same-origin Window handles exchange public context. Every window keeps its own API/socket. */
export function browserDisplays(
  getApi: () => DesktopApi,
  active: () => boolean,
  signal: AbortSignal,
) {
  const children = new Map<
    Window,
    {
      nonce: string;
      context?: DisplayContext;
      ready?: () => void;
      returning?: boolean;
      hostId: string;
      udid: string;
    }
  >();
  const returns = new Set<(context: DisplayContext) => void>();
  const nonce = new URLSearchParams(location.search).get('browserDisplay');
  let context: DisplayContext | undefined;
  let contextPromise: Promise<DisplayContext> | undefined;
  let resolveContext: ((value: DisplayContext) => void) | undefined;
  let rejectReturn: ((error: Error) => void) | undefined;
  let resolveReturn: (() => void) | undefined;
  let returning: Promise<void> | undefined;
  const post = (target: Window, type: string, extra?: object, token = nonce) =>
    target.postMessage({ type: `sim-relay:${type}`, nonce: token, ...extra }, location.origin);
  const listener = (event: MessageEvent) => {
    if (event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
    const value = event.data;
    if (nonce && event.source === window.opener && value.nonce === nonce) {
      if (value.type === 'sim-relay:context') {
        context = value.context;
        if (context) resolveContext?.(context);
      }
      if (value.type === 'sim-relay:return-error') rejectReturn?.(new Error(value.message));
      if (value.type === 'sim-relay:release') {
        void getApi()
          .disconnect()
          .then(() => post(window.opener!, 'released'));
      }
      if (value.type === 'sim-relay:returned') resolveReturn?.();
      return;
    }
    const child = children.get(event.source as Window);
    if (!child || child.nonce !== value.nonce) return;
    if (value.type === 'sim-relay:ready') {
      child.ready?.();
      if (child.context)
        post(event.source as Window, 'context', { context: child.context }, child.nonce);
    }
    if (value.type === 'sim-relay:return') {
      if (active()) {
        post(
          event.source as Window,
          'return-error',
          { message: 'Disconnect the workspace’s display before returning this simulator.' },
          child.nonce,
        );
      } else {
        child.returning = true;
        post(event.source as Window, 'release', undefined, child.nonce);
      }
    }
    if (value.type === 'sim-relay:released' && child.context && child.returning) {
      child.returning = false;
      if (active()) {
        post(
          event.source as Window,
          'return-error',
          {
            message:
              'The workspace connected another display. Disconnect it and retry returning this simulator.',
          },
          child.nonce,
        );
        return;
      }
      const restored = { ...child.context, sessionActive: false };
      for (const callback of returns) callback(restored);
      post(event.source as Window, 'returned', undefined, child.nonce);
      children.delete(event.source as Window);
    }
  };
  window.addEventListener('message', listener, { signal });
  window.addEventListener('pagehide', () => window.removeEventListener('message', listener), {
    once: true,
  });
  return {
    popOut: async (id: string, udid: string, fps: number) => {
      for (const [popup, child] of children) {
        if (popup.closed) children.delete(popup);
        else if (child.hostId === id && child.udid === udid) {
          popup.focus();
          return;
        }
      }
      if (children.size >= 16)
        throw new Error('Close an unused display window before opening another.');
      // window.open must precede all awaits, while this is still a button action.
      const token = crypto.randomUUID();
      const url = new URL(location.pathname, location.href);
      url.searchParams.set('display', '1');
      url.searchParams.set('browserDisplay', token);
      const popup = window.open(url, '_blank', 'popup,width=560,height=900');
      if (!popup) throw new Error('Allow pop-ups for this site, then open the display again.');
      const child = { nonce: token, hostId: id, udid } as {
        nonce: string;
        context?: DisplayContext;
        ready?: () => void;
        hostId: string;
        udid: string;
      };
      children.set(popup, child);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ready = new Promise<void>((resolve, reject) => {
          child.ready = resolve;
          timer = setTimeout(
            () =>
              reject(new Error('The display window did not open. Check sign-in and try again.')),
            15_000,
          );
        });
        const [host, inventory] = await Promise.all([
          getApi()
            .hosts()
            .then((hosts) => hosts.find((host) => host.id === id)),
          getApi().request<Inventory>(id, 'GET', '/devices'),
          ready,
        ]);
        const device = inventory.devices.find((device) => device.udid === udid);
        if (!host || !device) throw new Error('Refresh simulators and open the display again.');
        child.context = { host, device, fps, sessionActive: false };
        await getApi().disconnect();
        // A transfer releases this socket. The new display offers Connect explicitly.
        post(popup, 'context', { context: child.context }, token);
        popup.focus();
      } catch (error) {
        children.delete(popup);
        popup.close();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    displayContext: async () => {
      if (!nonce || !window.opener) return undefined;
      if (context) return context;
      return (contextPromise ??= new Promise<DisplayContext>((resolve, reject) => {
        resolveContext = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(
          () => reject(new Error('Reopen this display from its workspace.')),
          20_000,
        );
        post(window.opener!, 'ready');
      }));
    },
    returnDisplay: async () => {
      if (returning) return returning;
      if (!nonce || !window.opener || window.opener.closed)
        throw new Error(
          'The workspace was closed. Keep this display open or close it to disconnect.',
        );
      returning = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error('The workspace did not respond. Keep this display open and retry.')),
          10_000,
        );
        resolveReturn = () => {
          clearTimeout(timer);
          resolve();
        };
        rejectReturn = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        post(window.opener!, 'return');
      })
        .then(() => {
          window.opener.focus();
          window.close();
        })
        .finally(() => {
          returning = undefined;
        });
      return returning;
    },
    onReturnDisplay: (callback: (context: DisplayContext) => void) => {
      returns.add(callback);
      return () => {
        returns.delete(callback);
      };
    },
    windowAction: async (_action: 'maximize' | 'fullscreen') => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    },
  };
}
