import type { DesktopApi } from '../shared/types';
import { RecordingGuard } from '../shared/recording-protection';

const guards = new WeakMap<DesktopApi, RecordingGuard>();
export function recordingGuard(api: DesktopApi) {
  let guard = guards.get(api);
  if (!guard) {
    guard = new RecordingGuard(api);
    guards.set(api, guard);
  }
  return guard;
}
export function invalidateRecordingProtection(api: DesktopApi) {
  guards.get(api)?.invalidate();
}
