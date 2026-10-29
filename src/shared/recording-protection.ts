import type { RecordingStatus } from './media';

/** Error/starting states may still own capture data. Only idle is safe to lose. */
export const hasUnsavedRecording = (status: RecordingStatus) => status.phase !== 'idle';
export class RecordingActionCancelled extends Error {
  constructor() {
    super('Recording action cancelled.');
    this.name = 'RecordingActionCancelled';
  }
}
export const recordingActionCancelled = (error: unknown): boolean =>
  error instanceof RecordingActionCancelled ||
  (error instanceof Error && error.message.includes('Recording action cancelled.'));

export interface RecordingProtectionState {
  recording: RecordingStatus;
  action?: string;
  working: boolean;
  message?: string;
}

/** A single decision per owner. A second action never inherits the first action's consent. */
export class RecordingGuard {
  private state: RecordingProtectionState = { recording: { phase: 'idle' }, working: false };
  private listeners = new Set<() => void>();
  private pending?: { resolve(value: boolean): void };
  private generation = 0;
  private valid = true;
  constructor(
    private media: { saveRecording(): Promise<boolean>; discardRecording(): Promise<void> },
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<RecordingProtectionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  recording(status: RecordingStatus) {
    this.update({ recording: status });
    // Unexpected loss/expiry must never approve the action awaiting a decision.
    if (status.phase === 'idle' && this.pending && !this.state.working) this.cancel();
  }
  confirm = (action: string): Promise<boolean> => {
    if (!this.valid || this.pending) return Promise.resolve(false);
    if (!hasUnsavedRecording(this.state.recording)) return Promise.resolve(true);
    const result = new Promise<boolean>((resolve) => {
      this.pending = { resolve };
    });
    this.update({ action, message: undefined, working: false });
    return result;
  };
  private finish(allowed: boolean) {
    const pending = this.pending;
    this.pending = undefined;
    this.generation++;
    this.update({ action: undefined, working: false, message: undefined });
    pending?.resolve(allowed);
  }
  cancel = () => this.finish(false);
  /** Security revocation/disposal never waits for a dialog or approves stale work. */
  invalidate() {
    this.valid = false;
    this.cancel();
  }
  async choose(choice: 'save' | 'discard') {
    if (!this.pending || this.state.working || !this.valid) return;
    if (['starting', 'finalizing', 'saving'].includes(this.state.recording.phase)) return;
    const generation = this.generation;
    this.update({ working: true, message: undefined });
    try {
      // saveRecording stops/finalizes and resolves true only after the destination is closed.
      // Start it synchronously from the click so browser pickers retain user activation.
      const saved =
        choice === 'save'
          ? await this.media.saveRecording()
          : (await this.media.discardRecording(), true);
      if (generation !== this.generation || !this.valid) return;
      if (saved === true) this.finish(true);
      else
        this.update({
          working: false,
          message:
            'Save was not confirmed. If a download started, check your browser’s downloads. Keep this display connected, or explicitly discard the Mac’s copy to continue.',
        });
    } catch {
      if (generation === this.generation && this.valid)
        this.update({
          working: false,
          message:
            'The recording could not be saved or discarded. Keep this display connected and try again, or cancel this action.',
        });
    }
  }
}

/** Commands can target all devices. Guard every command except known read-only verbs. */
export function requestMayLoseRecording(method: string, path: string, body?: unknown) {
  if (method.toUpperCase() === 'GET') return false;
  if (path === '/command') {
    const args = (body as { args?: unknown })?.args;
    return (
      !Array.isArray(args) || !['list', 'help', 'get_app_container', 'getenv'].includes(args[0])
    );
  }
  return method.toUpperCase() === 'DELETE' || /\/(shutdown|erase|delete)(\/|$)/.test(path);
}
