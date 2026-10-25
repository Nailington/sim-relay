import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Cleanup could not prove that owned work has retired. Never acknowledge a safe upgrade. */
export class RetirementError extends Error {}

/** Bound shutdown without interpreting a timeout as successful resource retirement. */
export async function retirementDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RetirementError('Host resources did not retire before the shutdown deadline.'),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const nativeExec = promisify(execFile);

/** execFile's AbortError can arrive before exit. Preserve its overloads and .child,
 * but keep the command pending until the spawned process has actually retired. */
export const exec = ((...args: Parameters<typeof nativeExec>) => {
  const command = nativeExec(...args);
  const child = command.child;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => {
      // Spawn failure has no process to reap. AbortError on a live process does.
      if (!child.pid) resolve();
    });
  });
  const joined = command.then(
    async (result) => {
      await exited;
      return result;
    },
    async (error: unknown) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* The exit deadline still fails closed. */
          }
        }, 1000);
      }
      try {
        await retirementDeadline(exited, 5000);
      } finally {
        clearTimeout(killTimer);
      }
      throw error;
    },
  );
  return Object.assign(joined, { child });
}) as typeof nativeExec;
