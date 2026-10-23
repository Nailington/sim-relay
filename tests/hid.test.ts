import test from 'node:test';
import assert from 'node:assert/strict';
import { HidDispatcher, type HidStream } from '../src/host/hid';
test('keeps a touch gesture open, ends it on release, and serializes the next gesture after acknowledgment', async () => {
  const operations: { events: object[]; ended: boolean; done(error?: Error): void }[] = [];
  const errors: Error[] = [];
  const hid = new HidDispatcher(
    (done) => {
      const operation = { events: [] as object[], ended: false, done };
      operations.push(operation);
      const stream: HidStream = {
        write: (e) => operation.events.push(e),
        end: () => {
          operation.ended = true;
        },
        on: () => {},
      };
      return stream;
    },
    (e) => errors.push(e),
  );
  hid.send([{ down: 1 }], false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations.length, 1);
  assert.equal(operations[0].ended, false);
  hid.send([{ move: 2 }], false);
  hid.send([{ up: 3 }], true);
  hid.send([{ buttonDown: 4 }, { buttonUp: 5 }], true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations.length, 1);
  assert.equal(operations[0].ended, true);
  assert.deepEqual(operations[0].events, [{ down: 1 }, { move: 2 }, { up: 3 }]);
  operations[0].done();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(operations.length, 2);
  assert.equal(operations[1].ended, true);
  assert.deepEqual(operations[1].events, [{ buttonDown: 4 }, { buttonUp: 5 }]);
  operations[1].done();
  await hid.drain();
  assert.deepEqual(errors, []);
});
test('surfaces an RPC failure promptly and allows the next queued gesture to settle', async () => {
  const errors: Error[] = [];
  let calls = 0;
  const hid = new HidDispatcher(
    (done) => ({
      write: () => {},
      end: () => {
        calls++;
        done(calls === 1 ? new Error('input failed') : undefined);
      },
      on: () => {},
    }),
    (e) => errors.push(e),
  );
  hid.send([{ tap: 1 }], true);
  hid.send([{ tap: 2 }], true);
  await hid.drain();
  assert.equal(calls, 2);
  assert.equal(errors[0].message, 'input failed');
});
