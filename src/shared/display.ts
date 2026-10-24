import type { Orientation, Point, StreamMeta } from './types';
export function displayDimensions(meta?: StreamMeta) {
  const width = meta?.width || 402,
    height = meta?.height || 874;
  return meta?.rotation === 90 || meta?.rotation === 270
    ? { width: height, height: width }
    : { width, height };
}
export function surfacePoint(point: Point, rotation: StreamMeta['rotation'] = 0): Point {
  switch (rotation) {
    case 90:
      return { x: point.y, y: 1 - point.x };
    case 180:
      return { x: 1 - point.x, y: 1 - point.y };
    case 270:
      return { x: 1 - point.y, y: point.x };
    default:
      return point;
  }
}
export function fitDisplay(width: number, height: number, meta?: StreamMeta) {
  const display = displayDimensions(meta);
  const scale = Math.max(0, Math.min(width / display.width, height / display.height));
  return { width: display.width * scale, height: display.height * scale };
}

/** get_orientation uses physical directions; legacy HID rotate uses inverse landscape names. */
export function displayRotation(
  orientation: Orientation,
  source: StreamMeta['orientationSource'],
  orientedFrames = false,
): 0 | 90 | 180 | 270 {
  if (orientedFrames) return 0;
  if (orientation === 'PORTRAIT_UPSIDE_DOWN') return 180;
  if (orientation === 'LANDSCAPE_LEFT') return source === 'host' ? 270 : 90;
  if (orientation === 'LANDSCAPE_RIGHT') return source === 'host' ? 90 : 270;
  return 0;
}
