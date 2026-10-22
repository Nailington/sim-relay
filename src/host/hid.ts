export interface HidStream {
  write(event: object): unknown;
  end(): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
interface Operation {
  buffered: object[];
  stream?: HidStream;
  ended: boolean;
}

/** Complete an RPC per gesture: idb drains and acknowledges input at the RPC boundary. */
export class HidDispatcher {
  private current?: Operation;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly open: (done: (error?: Error | null) => void) => HidStream,
    private readonly onError: (error: Error) => void,
  ) {}
  send(events: object[], finish: boolean) {
    if (!this.current) {
      const operation: Operation = { buffered: [], ended: false };
      this.current = operation;
      this.tail = this.tail
        .then(
          () =>
            new Promise<void>((resolve, reject) => {
              try {
                const stream = this.open((error) => (error ? reject(error) : resolve()));
                stream.on('error', reject);
                operation.stream = stream;
                for (const event of operation.buffered) stream.write(event);
                operation.buffered = [];
                if (operation.ended) stream.end();
              } catch (error) {
                reject(error);
              }
            }),
        )
        .catch((error) => {
          this.onError(error as Error);
        });
    }
    const operation = this.current;
    for (const event of events) {
      if (operation.stream) operation.stream.write(event);
      else if (operation.buffered.length < 2000) operation.buffered.push(event);
      else throw new Error('The input service is not keeping up. Reconnect to continue.');
    }
    if (finish) {
      operation.ended = true;
      operation.stream?.end();
      this.current = undefined;
    }
  }
  async drain() {
    if (this.current) this.send([], true);
    await this.tail;
  }
}
