export interface HidStream {
  write(event: object): unknown;
  end(): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
interface Operation {
  buffered: object[];
  stream?: HidStream;
  ended: boolean;
  onStart?: () => void;
}

/** Complete an RPC per gesture: idb drains and acknowledges input at the RPC boundary. */
export class HidDispatcher {
  private current?: Operation;
  private active?: Operation;
  private queue: Operation[] = [];
  private buffered = 0;
  private scheduled = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle?: () => void;
  constructor(
    private readonly open: (done: (error?: Error | null) => void) => HidStream,
    private readonly onError: (error: Error) => void,
  ) {}
  send(events: object[], finish: boolean, onStart?: () => void) {
    if (this.current && onStart)
      throw new Error('Finish the current input gesture before changing orientation.');
    if (!this.current?.stream && this.buffered + events.length > 2000)
      throw new Error('The input service is not keeping up. Reconnect to continue.');
    if (!this.current) {
      if (this.queue.length + (this.active ? 1 : 0) >= 16)
        throw new Error(
          'The input service is not keeping up. Wait before sending another gesture.',
        );
      if (!this.resolveIdle) this.idle = new Promise((resolve) => (this.resolveIdle = resolve));
      this.current = { buffered: [], ended: false, onStart };
      this.queue.push(this.current);
      this.schedule();
    }
    const operation = this.current;
    for (const event of events) {
      if (operation.stream) operation.stream.write(event);
      else {
        operation.buffered.push(event);
        this.buffered++;
      }
    }
    if (finish) {
      operation.ended = true;
      operation.stream?.end();
      this.current = undefined;
    }
  }
  /** Drop only unsent RPCs; an active gesture must still receive its contact/key UP events.
   * Returns true when the unfinished gesture had never reached the companion. */
  cancelPending(): boolean {
    const canceledCurrent = !!this.current && this.queue.includes(this.current);
    for (const operation of this.queue) this.buffered -= operation.buffered.length;
    this.queue = [];
    if (canceledCurrent) this.current = undefined;
    this.settleIdle();
    return canceledCurrent;
  }
  private settleIdle() {
    if (this.active || this.queue.length) return;
    this.resolveIdle?.();
    this.resolveIdle = undefined;
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }
  private pump() {
    if (this.active) return;
    const operation = this.queue.shift();
    if (!operation) return this.settleIdle();
    this.active = operation;
    const done = (error?: Error | null) => {
      if (this.active !== operation) return;
      this.active = undefined;
      if (this.current === operation) this.current = undefined;
      this.buffered -= operation.buffered.length;
      operation.buffered = [];
      this.schedule();
      if (error) this.onError(error);
    };
    try {
      const stream = this.open(done);
      if (this.active !== operation) return;
      stream.on('error', done);
      operation.stream = stream;
      try {
        operation.onStart?.();
      } catch (error) {
        stream.end();
        done(error as Error);
        return;
      }
      const events = operation.buffered;
      operation.buffered = [];
      this.buffered -= events.length;
      for (const event of events) stream.write(event);
      if (operation.ended) stream.end();
    } catch (error) {
      done(error as Error);
    }
  }
  async drain() {
    if (this.current) this.send([], true);
    await this.idle;
  }
}
