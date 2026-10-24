import type { RecordingDownload } from '../shared/media';
import type { Profile } from '../shared/types';
import type { BrowserMedia } from './browser-media';

type FileHandle = { createWritable(): Promise<WritableStream<Uint8Array>> };
type PickerWindow = Window & { showSaveFilePicker?: (options: unknown) => Promise<FileHandle> };
function connectedPicker<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException('Display disconnected', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
/** File System Access streams to disk. Other browsers use their native download manager. */
export function browserRecording(
  media: BrowserMedia,
  profile: () => Profile | undefined,
  issue: (profile: Profile, recording: RecordingDownload) => Promise<{ path: string }>,
) {
  let saving = false;
  let abort: AbortController | undefined;
  const off = (value: Parameters<BrowserMedia['notify']>[0]) => {
    if (value.type === 'recording' && value.recording.phase === 'idle') abort?.abort();
  };
  media.notices.add(off);
  return async (): Promise<boolean> => {
    if (saving) throw new Error('A recording save is already in progress.');
    saving = true;
    abort = new AbortController();
    const signal = abort.signal;
    let writable: WritableStream<Uint8Array> | undefined;
    let recording: RecordingDownload | undefined;
    try {
      const picker = (window as PickerWindow).showSaveFilePicker;
      // Open immediately while the Save button still carries user activation.
      const file = picker
        ? await connectedPicker(
            picker.call(window, {
              suggestedName: `Simulator-${Date.now()}.mp4`,
              types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
            }),
            signal,
          )
        : undefined;
      signal.throwIfAborted();
      const owner = profile();
      if (!owner) throw new Error('Keep the display connected while saving a recording.');
      recording = await media.command('recording-stop');
      if (!recording) throw new Error('The Mac did not provide a recording.');
      const expectedBytes = recording.bytes;
      const { path } = await issue(owner, recording);
      if (!/^\/api\/download\/[\w-]{43}$/.test(path))
        throw new Error('The download link is invalid. Retry Save.');
      signal.throwIfAborted();
      if (!file) {
        const link = document.createElement('a');
        link.href = path;
        link.download = 'Simulator-recording.mp4';
        link.click();
        media.notify({
          type: 'recording',
          recording: {
            phase: 'ready',
            bytes: recording.bytes,
            message:
              'Download started. Check your browser’s downloads before discarding or disconnecting.',
          },
        });
        return false; // Native downloads have no reliable completion/cancellation callback.
      }
      writable = await file.createWritable();
      const response = await fetch(path, { credentials: 'same-origin', signal });
      if (!response.ok || !response.body)
        throw new Error(
          'The recording could not be downloaded. Keep the display connected and retry Save.',
        );
      media.notify({ type: 'recording', recording: { phase: 'saving', bytes: 0 } });
      let bytes = 0;
      await response.body
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.length;
              if (bytes > expectedBytes)
                throw new Error('The recording exceeded its expected size.');
              controller.enqueue(chunk);
            },
            flush() {
              if (bytes !== expectedBytes)
                throw new Error('The recording transfer was interrupted. Retry Save.');
            },
          }),
        )
        .pipeTo(writable, { signal });
      writable = undefined;
      await media.command('recording-discard');
      return true;
    } catch (error) {
      if ((error as Error).name === 'AbortError') return false;
      if (recording && !signal.aborted)
        media.notify({
          type: 'recording',
          recording: {
            phase: 'ready',
            bytes: recording.bytes,
            message: 'The recording could not be saved. Keep the display connected and retry Save.',
          },
        });
      throw error;
    } finally {
      if (writable && !writable.locked) await writable.abort().catch(() => {});
      saving = false;
      abort = undefined;
    }
  };
}
