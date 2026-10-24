import test from 'node:test';
import assert from 'node:assert/strict';
import { hidEvents, inputSchema, JpegFramer, jpegDimensions } from '../src/host/protocol';
import { normalizedPoint, parseCommand, keyCode } from '../src/renderer/input';
import { authorized } from '../src/host/security';

const screen = { width: 1206, height: 2622, widthPoints: 402, heightPoints: 874 };
test('touch coordinates use simulator points rather than stream pixels, including edges', () => {
  assert.deepEqual(hidEvents({ type: 'touch', phase: 'move', point: { x: 1, y: 1 } }, screen), [
    { press: { action: { touch: { point: { x: 401, y: 873 } } }, direction: 'DOWN' } },
  ]);
  assert.deepEqual(hidEvents({ type: 'touch', phase: 'up', point: { x: 0, y: 0 } }, screen), [
    { press: { action: { touch: { point: { x: 0, y: 0 } } }, direction: 'UP' } },
  ]);
  assert.deepEqual(normalizedPoint(200, -4, { left: 20, top: 10, width: 100, height: 200 }), {
    x: 1,
    y: 0,
  });
});
test('rejects malformed, non-finite, and out-of-range input before sending HID', () => {
  for (const value of [
    { type: 'touch', phase: 'down', point: { x: -1, y: 0 } },
    { type: 'key', phase: 'up', code: 999 },
    { type: 'pinch', center: { x: 0.5, y: 0.5 }, scale: Infinity },
    { type: 'rotate', orientation: 'sideways' },
    { type: 'shell', command: 'anything' },
  ])
    assert.equal(inputSchema.safeParse(value).success, false);
});
test('button presses have an explicit release and bounded hold', () => {
  const events = hidEvents({ type: 'button', button: 'HOME', duration: 0.2 }, screen);
  assert.deepEqual(events, [
    { press: { action: { button: { button: 'HOME' } }, direction: 'DOWN' } },
    { delay: { duration: 0.2 } },
    { press: { action: { button: { button: 'HOME' } }, direction: 'UP' } },
  ]);
});
test('MJPEG parser retains arbitrary boundary fragments and emits multiple complete frames', () => {
  const framer = new JpegFramer(),
    a = Buffer.from([255, 216, 1, 2, 255, 217]),
    b = Buffer.from([255, 216, 3, 4, 255, 217]);
  assert.deepEqual(framer.push(Buffer.from('HTTP headers\r\n--boundary\r\n')), []);
  assert.deepEqual(framer.push(a.subarray(0, 1)), []);
  assert.deepEqual(
    framer.push(Buffer.concat([a.subarray(1), Buffer.from('\r\n--boundary\r\n'), b])),
    [a, b],
  );
  assert.throws(() => framer.push(Buffer.alloc(17 * 1024 * 1024)), /exceeded/);
});
test('commands preserve quoted arguments and never evaluate shell syntax', () => {
  assert.deepEqual(parseCommand('install $DEVICE "/a path/My App.app"'), [
    'install',
    '$DEVICE',
    '/a path/My App.app',
  ]);
  assert.deepEqual(parseCommand('openurl $DEVICE "https://example.com?a=$(whoami)&b=2"'), [
    'openurl',
    '$DEVICE',
    'https://example.com?a=$(whoami)&b=2',
  ]);
  assert.deepEqual(parseCommand("create 'My Phone' ''"), ['create', 'My Phone', '']);
  assert.throws(() => parseCommand('launch "unfinished'), /Close the quote/);
  assert.throws(() => parseCommand('xcrun simctl list'), /only the subcommand/);
});
test('reads portrait and landscape dimensions from JPEG headers without decoding pixels', () => {
  const frame = Buffer.from([
    255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 8, 8, 0x0a, 0x3e, 0x04, 0xb6, 3, 255, 217,
  ]);
  assert.deepEqual(jpegDimensions(frame), { width: 1206, height: 2622 });
  frame.writeUInt16BE(1206, 13);
  frame.writeUInt16BE(2622, 15);
  assert.deepEqual(jpegDimensions(frame), { width: 2622, height: 1206 });
  assert.equal(jpegDimensions(Buffer.from([255, 216, 255])), undefined);
});
test('keyboard maps letters, modifiers, navigation, and function keys to USB HID usages', () => {
  assert.equal(keyCode('KeyA'), 4);
  assert.equal(keyCode('Digit0'), 39);
  assert.equal(keyCode('MetaLeft'), 227);
  assert.equal(keyCode('F12'), 69);
  assert.equal(keyCode('Unknown'), undefined);
});
test('authentication rejects wrong, missing, or truncated credentials', () => {
  assert.equal(authorized(undefined, 'abc'), false);
  assert.equal(authorized('Basic abc', 'abc'), false);
  assert.equal(authorized('Bearer ab', 'abc'), false);
  assert.equal(authorized('Bearer abd', 'abc'), false);
  assert.equal(authorized('Bearer abc', 'abc'), true);
});
