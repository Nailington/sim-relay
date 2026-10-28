import { open } from 'node:fs/promises';
import type { StreamMeta } from '../shared/types';
import { displayDimensions, displayRotation } from '../shared/display';

export interface RecordingPresentation {
  rotation: 0 | 90 | 180 | 270;
  landscape: boolean;
}

/** Capture the presentation at recording start; do not resize it during recording. */
export function recordingPresentation(meta?: StreamMeta): RecordingPresentation {
  const display = displayDimensions(meta);
  const rotation =
    meta?.rotation ||
    (meta?.orientation && meta.orientationSource && meta.orientationSource !== 'unavailable'
      ? displayRotation(meta.orientation, meta.orientationSource, false)
      : 0);
  return { rotation, landscape: display.width > display.height };
}

const maximumBytes = 1024 ** 3 + 32 * 1024 ** 2;
const identity = [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];
interface Atom {
  type: string;
  payload: number;
  end: number;
}
const invalid = () =>
  new Error('Recording orientation metadata is invalid. Discard and record again.');

/**
 * Correct simctl's portrait canvas without decoding or changing media samples.
 * The caller must finish capture and await this before publishing a download ticket.
 * QuickTime matrices are stored a,b,u,c,d,v,x,y,w; a,b,c,d,x,y are 16.16 and
 * u,v,w are 2.30. Positive y runs down, so this clockwise transform translates
 * the rotated image back into the positive display bounds.
 * https://developer.apple.com/documentation/quicktime-file-format/matrices
 * https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/movenc.c
 */
export async function orientRecording(
  filename: string,
  presentation: RecordingPresentation | undefined,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!presentation) return;
  if (
    ![0, 90, 180, 270].includes(presentation.rotation) ||
    typeof presentation.landscape !== 'boolean'
  )
    throw invalid();
  if (!presentation.rotation) return;
  const file = await open(filename, 'r+');
  try {
    signal.throwIfAborted();
    const initial = await file.stat();
    if (!initial.isFile() || initial.size < 8 || initial.size > maximumBytes) throw invalid();
    const read = async (position: number, length: number, end: number) => {
      signal.throwIfAborted();
      if (length < 1 || length > 44 || position < 0 || position + length > end) throw invalid();
      const buffer = Buffer.alloc(length);
      const result = await file.read(buffer, 0, length, position);
      if (result.bytesRead !== length) throw invalid();
      signal.throwIfAborted();
      return buffer;
    };
    let budget = 10000;
    const atoms = async (start: number, end: number, depth: number): Promise<Atom[]> => {
      if (depth > 4) throw invalid();
      const result: Atom[] = [];
      let position = start;
      while (position < end) {
        if (--budget < 0) throw invalid();
        const header = await read(position, 8, end);
        const short = header.readUInt32BE();
        let headerBytes = 8;
        let size = short;
        if (short === 1) {
          const extended = (await read(position + 8, 8, end)).readBigUInt64BE();
          if (extended > BigInt(maximumBytes)) throw invalid();
          size = Number(extended);
          headerBytes = 16;
        } else if (short === 0) size = end - position;
        if (size < headerBytes || position + size > end) throw invalid();
        result.push({
          type: header.toString('latin1', 4, 8),
          payload: position + headerBytes,
          end: position + size,
        });
        position += size;
      }
      return result;
    };
    const one = (items: Atom[], type: string) => {
      const matches = items.filter((atom) => atom.type === type);
      if (matches.length !== 1) throw invalid();
      return matches[0];
    };
    const top = await atoms(0, initial.size, 0);
    const moov = one(top, 'moov');
    if (!top.some((atom) => atom.type === 'mdat')) throw invalid();
    const movie = await atoms(moov.payload, moov.end, 1);
    const patches: { position: number; matrix: Buffer }[] = [];
    let videoTracks = 0;
    for (const track of movie.filter((atom) => atom.type === 'trak')) {
      const children = await atoms(track.payload, track.end, 2);
      const media = one(children, 'mdia');
      const handler = one(await atoms(media.payload, media.end, 3), 'hdlr');
      if ((await read(handler.payload + 8, 4, handler.end)).toString('latin1') !== 'vide') continue;
      videoTracks++;
      const header = one(children, 'tkhd');
      const version = (await read(header.payload, 1, header.end))[0];
      if (version !== 0 && version !== 1) throw invalid();
      const position = header.payload + (version === 0 ? 40 : 52);
      const fields = await read(position, 44, header.end);
      const width = fields.readUInt32BE(36),
        height = fields.readUInt32BE(40);
      // Translation is signed 16.16, unlike the unsigned width/height fields.
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw invalid();
      if (!identity.every((value, index) => fields.readInt32BE(index * 4) === value)) continue;
      if (presentation.rotation !== 180 && width > height === presentation.landscape) continue;
      const matrix = Buffer.alloc(36);
      const values =
        presentation.rotation === 90
          ? [0, 65536, 0, -65536, 0, 0, height, 0, 1 << 30]
          : presentation.rotation === 180
            ? [-65536, 0, 0, 0, -65536, 0, width, height, 1 << 30]
            : [0, -65536, 0, 65536, 0, 0, 0, width, 1 << 30];
      values.forEach((value, index) => matrix.writeInt32BE(value, index * 4));
      patches.push({ position, matrix });
    }
    if (!videoTracks) throw invalid();
    // Validate the complete candidate before any write. Each replacement is one
    // bounded 36-byte write; a short write or cancellation prevents publication.
    signal.throwIfAborted();
    if ((await file.stat()).size !== initial.size) throw invalid();
    for (const patch of patches) {
      signal.throwIfAborted();
      const result = await file.write(patch.matrix, 0, 36, patch.position);
      if (result.bytesWritten !== 36) throw invalid();
      signal.throwIfAborted();
    }
  } finally {
    await file.close();
  }
}
