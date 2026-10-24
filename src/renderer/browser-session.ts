import { RelaySession, SessionFailure, type StreamSocket } from '../electron/session';
import type { Profile, StreamNotice } from '../shared/types';
import { BrowserMedia } from './browser-media';
import type { BrowserAccount } from './browser-account';

/** Adapt browser sockets to the shared retry/cancellation lifecycle without Node dependencies. */
export function browserSession(
  get: (id: string) => Profile,
  notice: (value: StreamNotice) => void,
  account: BrowserAccount,
  resetRevision: () => string | null,
) {
  let socket: WebSocket | undefined;
  let connectedProfile: Profile | undefined;
  let openingProfile: Profile | undefined;
  const media = new BrowserMedia((value) => {
    account.assertCurrent();
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('Connect to a simulator first.');
    if (socket.bufferedAmount > 64 * 1024)
      throw new Error('The connection is busy. Wait and retry.');
    socket.send(JSON.stringify(value));
  });
  const session = new RelaySession({
    notice,
    frame: (frame) => media.video(frame),
    message: (data, binary) => media.message(binary ? new Uint8Array(data) : data.toString()),
    open: async (target, signal) => {
      const reset = resetRevision();
      let profile: Profile;
      try {
        profile = get(target.hostId);
        openingProfile = profile;
      } catch (error) {
        throw new SessionFailure((error as Error).message, true);
      }
      const currentProfile = () => {
        account.assertCurrent();
        const current = get(target.hostId);
        if (
          reset !== resetRevision() ||
          current.token !== profile.token ||
          current.certificate !== profile.certificate ||
          current.fingerprint !== profile.fingerprint ||
          current.url !== profile.url
        )
          throw new SessionFailure(
            'This browser’s saved pairing changed. Select the Mac and connect again.',
            true,
          );
        return current;
      };
      await account.verify(signal);
      signal.throwIfAborted();
      currentProfile();
      const url = new URL('/api/stream', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const current = new WebSocket(url);
      current.binaryType = 'arraybuffer';
      const callbacks = new Map<string, ((...args: any[]) => void)[]>();
      const emit = (event: string, ...args: unknown[]) => {
        for (const callback of callbacks.get(event) ?? []) callback(...args);
      };
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (openingProfile === profile) openingProfile = undefined;
        if (socket === current) {
          socket = undefined;
          connectedProfile = undefined;
          media.close();
        }
      };
      const adapter: StreamSocket = {
        get readyState() {
          return current.readyState;
        },
        send: (value) => {
          if (current.bufferedAmount < 64 * 1024) current.send(value);
          else adapter.terminate(); // Force host-side input release rather than lose an UP event.
        },
        close: () => current.close(),
        terminate: () => {
          cleanup();
          current.close();
        },
        on: (event, callback) => {
          callbacks.set(event, [...(callbacks.get(event) ?? []), callback]);
        },
      };
      const abort = () => {
        cleanup();
        current.close();
      };
      return new Promise<StreamSocket>((resolve, reject) => {
        let opened = false;
        timer = setTimeout(() => {
          const failure = new SessionFailure(
            'The Mac did not start streaming. Check its connection and retry.',
          );
          reject(failure);
          emit('error', failure);
          adapter.terminate();
        }, 20_000);
        signal.addEventListener(
          'abort',
          () => reject(new SessionFailure('Display connection canceled.')),
          { once: true },
        );
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
          reject(new SessionFailure('Display connection canceled.'));
          return;
        }
        current.onopen = async () => {
          try {
            await account.verify(signal);
            signal.throwIfAborted();
            const checked = currentProfile();
            opened = true;
            socket = current;
            connectedProfile = checked;
            openingProfile = undefined;
            media.open(target.fps);
            current.send(
              JSON.stringify({
                user: account.user,
                profile: checked,
                udid: target.udid,
                fps: target.fps,
              }),
            );
            resolve(adapter);
          } catch (error) {
            abort();
            reject(error);
          }
        };
        current.onmessage = (event) => {
          if (socket !== current || signal.aborted) return;
          try {
            const data = typeof event.data === 'string' ? event.data : new Uint8Array(event.data);
            if (typeof data === 'string' && JSON.parse(data)?.type === 'metadata')
              clearTimeout(timer);
            emit('message', data, typeof data !== 'string');
          } catch {
            emit(
              'error',
              new SessionFailure(
                'The Mac sent an invalid stream message. Update Sim Relay on both computers.',
                true,
              ),
            );
          }
        };
        current.onerror = () => {
          const failure = new SessionFailure(
            'Cannot reach the hosting service. Check its connection or sign in again.',
          );
          if (!opened) {
            cleanup();
            reject(failure);
          } else emit('error', failure);
        };
        current.onclose = (event) => {
          cleanup();
          if (!opened)
            reject(
              new SessionFailure(
                'The hosting service closed the connection. Sign in again if your session expired.',
                event.code === 4003,
              ),
            );
          emit('close', event.code);
        };
      });
    },
  });
  return { session, media, profile: () => connectedProfile ?? openingProfile };
}
