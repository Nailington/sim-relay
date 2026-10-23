import { z } from 'zod';
import type { InputEvent, StreamMeta } from '../shared/types';

const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const inputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('touch'), phase: z.enum(['down', 'move', 'up']), point }),
  z.object({
    type: z.literal('key'),
    code: z.number().int().min(0).max(255),
    phase: z.enum(['down', 'up']),
  }),
  z.object({
    type: z.literal('button'),
    button: z.enum([
      'HOME',
      'LOCK',
      'SIDE_BUTTON',
      'SIRI',
      'VOLUME_UP',
      'VOLUME_DOWN',
      'APPLE_PAY',
      'EJECT',
    ]),
    duration: z.number().min(0).max(5).optional(),
  }),
  z.object({
    type: z.literal('pinch'),
    center: point,
    scale: z.number().min(0.25).max(4),
    duration: z.number().min(0.05).max(5).optional(),
    radius: z.number().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal('swipe'),
    start: point,
    end: point,
    duration: z.number().min(0.05).max(5),
  }),
  z.object({
    type: z.literal('rotate'),
    orientation: z.enum(['PORTRAIT', 'PORTRAIT_UPSIDE_DOWN', 'LANDSCAPE_LEFT', 'LANDSCAPE_RIGHT']),
  }),
  z.object({ type: z.literal('shake') }),
  z.object({ type: z.literal('release') }),
]);

export function hidEvents(input: InputEvent, screen: StreamMeta): object[] {
  const position = (p: { x: number; y: number }) => ({
    x: p.x * (screen.widthPoints - 1),
    y: p.y * (screen.heightPoints - 1),
  });
  const press = (action: object, direction: string) => ({ press: { action, direction } });
  switch (input.type) {
    case 'release':
      return [];
    case 'touch':
      return [
        press({ touch: { point: position(input.point) } }, input.phase === 'up' ? 'UP' : 'DOWN'),
      ];
    case 'key':
      return [press({ key: { keycode: input.code } }, input.phase === 'up' ? 'UP' : 'DOWN')];
    case 'button':
      return [
        press({ button: { button: input.button } }, 'DOWN'),
        { delay: { duration: input.duration ?? 0.08 } },
        press({ button: { button: input.button } }, 'UP'),
      ];
    case 'pinch':
      return [
        {
          pinch: {
            center: position(input.center),
            scale: input.scale,
            duration: input.duration ?? 0.3,
            radius: input.radius ?? Math.min(screen.widthPoints, screen.heightPoints) * 0.18,
          },
        },
      ];
    case 'swipe':
      return [
        {
          swipe: {
            start: position(input.start),
            end: position(input.end),
            duration: input.duration,
            delta: 5,
          },
        },
      ];
    case 'rotate':
      return [{ orientation: { orientation: input.orientation } }];
    case 'shake':
      return [{ shake: {} }];
  }
}

/** idb may split an MJPEG frame across arbitrary gRPC payload boundaries. */
export class JpegFramer {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > 16 * 1024 * 1024) throw new Error('Video frame exceeded 16 MB.');
    const frames: Buffer[] = [];
    while (true) {
      const start = this.pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.pending = this.pending.subarray(-1);
        break;
      }
      const end = this.pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        this.pending = this.pending.subarray(start);
        break;
      }
      frames.push(this.pending.subarray(start, end + 2));
      this.pending = this.pending.subarray(end + 2);
    }
    return frames;
  }
}

export function jpegDimensions(jpeg: Buffer): { width: number; height: number } | undefined {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return;
  let offset = 2;
  while (offset + 4 < jpeg.length) {
    if (jpeg[offset] !== 0xff) return;
    const marker = jpeg[offset + 1];
    if (marker === 0xda || marker === 0xd9) return;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = jpeg.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > jpeg.length) return;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      ) &&
      length >= 7
    )
      return { width: jpeg.readUInt16BE(offset + 7), height: jpeg.readUInt16BE(offset + 5) };
    offset += length + 2;
  }
}
