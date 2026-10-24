import { spawn, type ChildProcess } from 'node:child_process';

/** Observe exit immediately, including spawn failures; callers never wait on an already-fired event. */
export function childCompletion(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 || signal === 'SIGINT'
        ? resolve()
        : reject(new Error(`Capture exited (${code ?? signal}).`)),
    );
  });
}
export async function terminateChild(
  child: ChildProcess,
  done: Promise<unknown>,
  graceful: () => void,
  timeoutMs = 8000,
) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await done.catch(() => {});
    return;
  }
  graceful();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      done.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// This tiny supervisor survives a host crash long enough to stop/finalize its simctl child.
// EOF on stdin is ownership loss; a hard deadline also bounds stalled encoders.
export const recordingWorker = String.raw`
const {spawn} = require('node:child_process');
const child = spawn('/usr/bin/xcrun', ['simctl','io',process.argv[1],'recordVideo','--codec=h264','--force',process.argv[2]], {stdio:['ignore','ignore','pipe']});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill('SIGINT');
  setTimeout(() => { process.stderr.write('Recording finalization exceeded 30 seconds.\n'); child.kill('SIGKILL'); process.exit(1); }, 30000).unref();
}
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const deadline = setTimeout(stop, 30 * 60 * 1000);
child.stderr.on('data', d => process.stderr.write(d));
child.on('error', e => { process.stderr.write(e.message); process.exit(1); });
child.on('exit', (code, signal) => { clearTimeout(deadline); process.exit(code === 0 || signal === 'SIGINT' ? 0 : 1); });
`;
export function spawnRecording(udid: string, file: string) {
  return spawn(process.execPath, ['-e', recordingWorker, udid, file], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
}
