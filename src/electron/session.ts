import type { InputEvent, StreamNotice } from '../shared/types';

export const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
export class SessionFailure extends Error {
  constructor(
    message: string,
    public readonly terminal = false,
  ) {
    super(message);
  }
}
export function terminalFailure(error: unknown): boolean {
  if (error instanceof SessionFailure) return error.terminal;
  const e = error as { code?: string; message?: string };
  return (
    /CERT|TLS|SSL/.test(e.code ?? '') ||
    /certificate|pair with|pairing|unauthorized|HTTP ?(?:401|403)|Unexpected server response: (?:401|403)|protocol|controlled by another|no longer exists|not booted|shut down/i.test(
      e.message ?? '',
    )
  );
}
export interface StreamSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: string, callback: (...args: any[]) => void): unknown;
}
export interface SessionTarget {
  hostId: string;
  udid: string;
  fps: number;
}
interface SessionDependencies {
  open(target: SessionTarget, signal: AbortSignal): Promise<StreamSocket>;
  notice(notice: StreamNotice): void;
  frame(data: Uint8Array): void;
  message?(data: Uint8Array, binary: boolean): boolean;
  schedule?(callback: () => void, delay: number): unknown;
  cancel?(timer: unknown): void;
}
/** One selected host/device, transport and bounded retry lifecycle. Never queues input. */
export class RelaySession {
  target?: SessionTarget;
  private socket?: StreamSocket;
  private opening?: AbortController;
  private timer?: unknown;
  private generation = 0;
  private attempt = 0;
  private stopped = true;
  private live = false;
  private metadata?: StreamNotice;
  private statusNotice?: StreamNotice;
  private touch?: Extract<InputEvent, { type: 'touch' }>['point'];
  private keys = new Set<number>();
  constructor(private readonly deps: SessionDependencies) {}
  get active() {
    return !this.stopped;
  }
  private emit(
    state: 'connecting' | 'live' | 'retrying' | 'off' | 'failed',
    message?: string,
    retryInMs?: number,
  ) {
    this.statusNotice = { type: 'status', state, message, retryInMs, attempt: this.attempt };
    this.deps.notice(this.statusNotice);
  }
  async connect(target: SessionTarget) {
    if (
      this.active &&
      this.target?.hostId === target.hostId &&
      this.target.udid === target.udid &&
      this.target.fps === target.fps
    ) {
      if (this.statusNotice) this.deps.notice(this.statusNotice);
      if (this.live && this.metadata) this.deps.notice(this.metadata);
      return;
    }
    this.disconnect(false);
    this.metadata = undefined;
    this.target = { ...target };
    this.stopped = false;
    this.attempt = 0;
    await this.open(this.generation);
  }
  async retry() {
    if (!this.target) return;
    const target = this.target;
    this.disconnect(false);
    await this.connect(target);
  }
  private clearTimer() {
    if (this.timer !== undefined)
      (this.deps.cancel ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = undefined;
  }
  release() {
    // Expand releases to protocol-1 primitives, so legacy hosts remain compatible.
    if (this.socket?.readyState === 1) {
      if (this.touch)
        this.socket.send(JSON.stringify({ type: 'touch', phase: 'up', point: this.touch }));
      for (const code of this.keys)
        this.socket.send(JSON.stringify({ type: 'key', phase: 'up', code }));
    }
    this.touch = undefined;
    this.keys.clear();
  }
  disconnect(notify = true) {
    this.stopped = true;
    this.generation++;
    this.opening?.abort();
    this.opening = undefined;
    this.clearTimer();
    this.release();
    this.live = false;
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
    if (notify) this.emit('off');
  }
  input(event: InputEvent) {
    if (event.type === 'release') {
      this.release();
      return;
    }
    if (!this.stopped && this.live && this.socket?.readyState === 1) {
      if (event.type === 'touch') this.touch = event.phase === 'up' ? undefined : event.point;
      if (event.type === 'key')
        event.phase === 'down' ? this.keys.add(event.code) : this.keys.delete(event.code);
      if (event.type === 'rotate') this.release();
      this.socket.send(JSON.stringify(event));
    }
  }
  private async open(generation: number) {
    if (this.stopped || generation !== this.generation || !this.target) return;
    this.emit('connecting');
    try {
      const opening = new AbortController();
      this.opening = opening;
      const socket = await this.deps.open(this.target, opening.signal);
      if (this.opening === opening) this.opening = undefined;
      if (this.stopped || generation !== this.generation) {
        socket.terminate();
        return;
      }
      this.socket = socket;
      let failed = false;
      const fail = (error: unknown) => {
        if (failed || this.stopped || this.socket !== socket || generation !== this.generation)
          return;
        failed = true;
        this.live = false;
        this.release();
        this.socket = undefined;
        socket.terminate();
        this.failed(error, generation);
      };
      socket.on('message', (data: Uint8Array, binary: boolean) => {
        if (failed || this.socket !== socket || generation !== this.generation) return;
        if (this.deps.message?.(data, binary)) return;
        if (binary) {
          if (this.live) this.deps.frame(new Uint8Array(data));
          return;
        }
        try {
          const notice = JSON.parse(data.toString()) as StreamNotice;
          if (notice.type === 'error') {
            fail(
              new SessionFailure(
                notice.message ?? 'The host stopped streaming.',
                notice.terminal === true ||
                  notice.code === 'authorization_required' ||
                  terminalFailure({ message: notice.message }),
              ),
            );
            return;
          }
          if (notice.type === 'metadata' && notice.metadata) {
            this.metadata = notice;
            this.live = true;
            this.attempt = 0;
            this.emit('live');
          }
          this.deps.notice(notice);
        } catch {
          fail(
            new SessionFailure(
              'The host sent invalid stream metadata. Update the host and client.',
              true,
            ),
          );
        }
      });
      socket.on('error', fail);
      socket.on('close', (code: number) =>
        fail(
          new SessionFailure(
            code === 4003
              ? 'Authorization was revoked. Pair with this Mac again.'
              : 'Connection interrupted. Waiting for the original Mac and simulator.',
            code === 4003,
          ),
        ),
      );
    } catch (error) {
      if (!this.stopped && generation === this.generation) this.failed(error, generation);
    }
  }
  private failed(error: unknown, generation: number) {
    const message = (error as Error).message || 'Cannot reach the Mac.';
    if (terminalFailure(error) || this.attempt >= RETRY_DELAYS.length) {
      this.stopped = true;
      this.emit(
        'failed',
        terminalFailure(error)
          ? message
          : `${message} Automatic retries stopped. Retry when the Mac is available.`,
      );
      return;
    }
    const delay = RETRY_DELAYS[this.attempt++];
    this.emit('retrying', message, delay);
    this.clearTimer();
    this.timer = (this.deps.schedule ?? setTimeout)(() => {
      this.timer = undefined;
      void this.open(generation);
    }, delay);
  }
}

/** Explicit ownership prevents one window from routing input to another display. */
export class SessionRouter<Owner, Session extends { target?: SessionTarget; active?: boolean }> {
  private readonly sessions = new Map<Owner, Session>();
  get(owner: Owner) {
    return this.sessions.get(owner);
  }
  set(owner: Owner, session: Session) {
    this.sessions.set(owner, session);
  }
  delete(owner: Owner) {
    return this.sessions.delete(owner);
  }
  entries() {
    return this.sessions.entries();
  }
  move(from: Owner, to: Owner) {
    const session = this.sessions.get(from);
    if (!session) throw new Error('This display is no longer connected.');
    if (this.sessions.has(to)) throw new Error('The destination already owns a display.');
    this.sessions.delete(from);
    this.sessions.set(to, session);
    return session;
  }
  ownerOf(hostId: string, udid: string) {
    for (const [owner, session] of this.sessions)
      if (
        session.active !== false &&
        session.target?.hostId === hostId &&
        session.target.udid === udid
      )
        return owner;
    return undefined;
  }
}
