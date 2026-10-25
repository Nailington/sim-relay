import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopApi } from '../shared/types';
import {
  RecordingActionCancelled,
  type RecordingGuard,
  hasUnsavedRecording,
  requestMayLoseRecording,
} from '../shared/recording-protection';
import './recording-protection.css';

import { recordingGuard } from './recording-guard';

/** Raw APIs remain available to security/lifetime cleanup. Only intentional UI actions use this facade. */
export function useRecordingProtection(raw?: DesktopApi) {
  const guard = useMemo(() => (raw ? recordingGuard(raw) : undefined), [raw]);
  useEffect(() => {
    if (!raw || !guard) return;
    const off = raw.onMediaNotice((notice) => {
      if (notice.type === 'recording') guard.recording(notice.recording);
    });
    const offNotice = raw.onNotice((notice) => {
      if (
        notice.terminal ||
        (notice.type === 'status' && ['off', 'failed'].includes(notice.state ?? ''))
      )
        guard.cancel();
    });
    const offClose = raw.onRecordingCloseRequest?.((action) => guard.confirm(action));
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (raw.platform !== 'web' || !hasUnsavedRecording(guard.snapshot().recording)) return;
      // Browsers permit only their own generic warning here, never an asynchronous save.
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      off();
      offNotice();
      offClose?.();
      guard.cancel();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [raw, guard]);
  const api = useMemo(() => {
    if (!raw || !guard) return raw;
    const run = async <T,>(label: string, action: () => Promise<T>): Promise<T> => {
      if (hasUnsavedRecording(guard.snapshot().recording) && !(await guard.confirm(label)))
        throw new RecordingActionCancelled();
      return action();
    };
    return {
      ...raw,
      hostManagement: raw.hostManagement
        ? {
            ...raw.hostManagement,
            action: (action) =>
              action === 'start'
                ? raw.hostManagement!.action(action)
                : run(
                    action === 'restart' ? 'Restart sharing this Mac' : 'Stop sharing this Mac',
                    () => raw.hostManagement!.action(action),
                  ),
          }
        : undefined,
      disconnect: () => run('Disconnect this display', () => raw.disconnect()),
      retry: () => run('Retry this connection', () => raw.retry()),
      forget: (id) => run('Forget this Mac', () => raw.forget(id)),
      stopHost: () => run('Stop sharing this Mac', () => raw.stopHost()),
      request: <T,>(id: string, method: string, path: string, body?: unknown): Promise<T> =>
        requestMayLoseRecording(method, path, body)
          ? run('Run this simulator action', () => raw.request<T>(id, method, path, body))
          : raw.request<T>(id, method, path, body),
      popOut: (id, udid, fps) =>
        raw.platform === 'web'
          ? run('Pop out this display', () => raw.popOut(id, udid, fps))
          : raw.popOut(id, udid, fps),
      returnDisplay: () =>
        raw.platform === 'web'
          ? run('Return to the workspace', () => raw.returnDisplay())
          : raw.returnDisplay(),
    } satisfies DesktopApi;
  }, [raw, guard]);
  return { api, guard };
}

export function RecordingProtection({ guard }: { guard?: RecordingGuard }) {
  if (!guard) return null;
  return <RecordingDecision guard={guard} />;
}
function RecordingDecision({ guard }: { guard: RecordingGuard }) {
  const state = useSyncExternalStore(guard.subscribe, guard.snapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const open = !!state.action;
  useEffect(() => {
    if (!open) return;
    previous.current = document.activeElement as HTMLElement;
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => {
      dialog.current?.close();
      previous.current?.focus();
    };
  }, [open]);
  if (!open) return null;
  const waiting =
    state.working || ['starting', 'finalizing', 'saving'].includes(state.recording.phase);
  return createPortal(
    <dialog
      ref={dialog}
      className="recording-protection"
      aria-labelledby="recording-protection-title"
      aria-describedby="recording-protection-description"
      onCancel={(event) => {
        event.preventDefault();
        guard.cancel();
      }}
    >
      <h2 id="recording-protection-title">Save recording before continuing?</h2>
      <p id="recording-protection-description">
        {state.action} will end this recording’s session. Save stops recording and finalizes the MP4
        before saving it to this computer. Discard deletes the Mac’s unsaved copy.
      </p>
      <p role="status" aria-live="polite">
        {state.message ||
          (waiting
            ? 'Wait for the recording to finish. Cancel keeps this display open.'
            : 'Cancel keeps this display and its recording available.')}
      </p>
      <div className="recording-protection-actions">
        <button ref={cancel} className="button secondary" onClick={guard.cancel}>
          Cancel
        </button>
        <button
          className="button secondary recording-discard"
          disabled={waiting}
          onClick={() => void guard.choose('discard')}
        >
          Discard recording
        </button>
        <button
          className="button primary"
          disabled={waiting}
          onClick={() => void guard.choose('save')}
        >
          {state.working ? 'Working…' : 'Save recording'}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
