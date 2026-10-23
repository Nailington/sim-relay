import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayDimensions,
  displayRotation,
  fitDisplay,
  surfacePoint,
} from '../src/shared/display';
import { normalizedPoint } from '../src/renderer/input';
import { hidEvents, inputSchema } from '../src/host/protocol';
import { SimulatorSession } from '../src/host/simulator';
const portrait = { width: 1200, height: 2600, widthPoints: 400, heightPoints: 866 };
test('screen fits and centers without changing ratio in normal, expanded and narrow windows', () => {
  for (const [width, height] of [
    [500, 600],
    [1500, 1000],
    [200, 900],
    [900, 200],
    [0, 0],
  ]) {
    for (const rotation of [0, 90, 180, 270] as const) {
      const fit = fitDisplay(width, height, { ...portrait, rotation });
      assert.ok(fit.width <= width + 1e-9 && fit.height <= height + 1e-9);
      if (width && height)
        assert.ok(
          Math.abs(
            fit.width / fit.height -
              displayDimensions({ ...portrait, rotation }).width /
                displayDimensions({ ...portrait, rotation }).height,
          ) < 1e-9,
        );
    }
  }
});
test('pointer coordinates map from the visible rotated corners to the original HID surface', () => {
  const rect = { left: 100, top: 50, width: 800, height: 400 };
  const point = normalizedPoint(300, 350, rect);
  assert.deepEqual(point, { x: 0.25, y: 0.75 });
  assert.deepEqual(surfacePoint(point, 0), { x: 0.25, y: 0.75 });
  assert.deepEqual(surfacePoint(point, 90), { x: 0.75, y: 0.75 });
  assert.deepEqual(surfacePoint(point, 180), { x: 0.75, y: 0.25 });
  assert.deepEqual(surfacePoint(point, 270), { x: 0.25, y: 0.25 });
  assert.deepEqual(normalizedPoint(-1, 10000, rect), { x: 0, y: 1 });
  const event = hidEvents(
    { type: 'touch', phase: 'down', point: surfacePoint(point, 90) },
    portrait,
  )[0];
  assert.deepEqual(event, {
    press: { action: { touch: { point: { x: 0.75 * 399, y: 0.75 * 865 } } }, direction: 'DOWN' },
  });
});
test('focus cleanup and rotation release every held host input before changing metadata', async () => {
  const session = new SimulatorSession();
  session.metadata = { ...portrait };
  const sent: { events: object[]; finish: boolean }[] = [];
  Object.assign(session, {
    hid: {
      send: (events: object[], finish: boolean) => sent.push({ events, finish }),
      drain: async () => {},
    },
  });
  session.input({ type: 'touch', phase: 'down', point: { x: 0.5, y: 0.5 } });
  session.input({ type: 'key', phase: 'down', code: 225 });
  session.input({ type: 'release' });
  assert.equal(sent.at(-1)?.finish, true);
  assert.deepEqual(
    sent.slice(-2).map((s) => (s.events[0] as any).press.direction),
    ['UP', 'UP'],
  );
  session.input({ type: 'rotate', orientation: 'LANDSCAPE_LEFT' });
  assert.equal(session.metadata.rotation, 90);
  session.input({ type: 'rotate', orientation: 'PORTRAIT' });
  assert.equal(session.metadata.rotation, 0);
  await session.close();
  assert.equal(inputSchema.safeParse({ type: 'release' }).success, true);
  assert.equal(
    inputSchema.safeParse({ type: 'touch', contactId: 2, point: { x: 4, y: 0 }, phase: 'down' })
      .success,
    false,
  );
});

test('physical host orientation and legacy HID landscape naming do not invert the display twice', () => {
  assert.equal(displayRotation('LANDSCAPE_LEFT', 'requested'), 90);
  assert.equal(displayRotation('LANDSCAPE_LEFT', 'host'), 270);
  assert.equal(displayRotation('LANDSCAPE_RIGHT', 'requested'), 270);
  assert.equal(displayRotation('LANDSCAPE_RIGHT', 'host'), 90);
  assert.equal(displayRotation('PORTRAIT_UPSIDE_DOWN', 'host'), 180);
  for (const orientation of [
    'PORTRAIT',
    'PORTRAIT_UPSIDE_DOWN',
    'LANDSCAPE_LEFT',
    'LANDSCAPE_RIGHT',
  ] as const)
    assert.equal(displayRotation(orientation, 'host', true), 0);
});
