import https from 'node:https';
import type { ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { hostUrl, tlsOptions } from '../electron/remote';
import type { Profile } from '../shared/types';

export const recordingDownloadSchema = z
  .object({
    id: z.string().uuid(),
    ticket: z.string().regex(/^[\da-f]{64}$/i),
    bytes: z
      .number()
      .int()
      .min(32)
      .max(1056 * 1024 * 1024),
  })
  .strict();
type Download = z.infer<typeof recordingDownloadSchema>;

/** Only the random relay capability enters a URL. Credentials remain in bounded server memory. */
export class RecordingDownloads {
  private tickets = new Map<
    string,
    {
      session: string;
      profile: Profile;
      recording: Download;
      expires: number;
      sessionExpires: number;
    }
  >();
  private active = new Map<AbortController, string>();
  constructor(private now = () => Date.now()) {}
  issue(
    session: string,
    profile: Profile,
    value: unknown,
    sessionExpires = this.now() + 12 * 60 * 60_000,
  ) {
    for (const [key, item] of this.tickets)
      if (item.expires <= this.now()) this.tickets.delete(key);
    if (this.tickets.size >= 256) throw new Error('Too many pending recording downloads.');
    const recording = recordingDownloadSchema.parse(value);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      session,
      profile,
      recording,
      expires: Math.min(this.now() + 60_000, sessionExpires),
      sessionExpires,
    });
    return { path: `/api/download/${ticket}` };
  }
  async serve(ticket: string, session: string, response: ServerResponse): Promise<boolean> {
    const item = this.tickets.get(ticket);
    if (!item || item.session !== session) return false;
    if (item.expires <= this.now()) {
      this.tickets.delete(ticket);
      return false;
    }
    this.tickets.delete(ticket);
    if (this.active.size >= 16) throw new Error('Too many active recording downloads.');
    const abort = new AbortController();
    this.active.set(abort, session);
    const expiry = setTimeout(() => abort.abort(), Math.max(0, item.sessionExpires - this.now()));
    const cancel = () => {
      if (!response.writableFinished) abort.abort();
    };
    response.once('close', cancel);
    try {
      await new Promise<void>((resolve, reject) => {
        const request = https.get(
          new URL(`/recordings/${item.recording.id}`, hostUrl(item.profile.url)),
          {
            ...tlsOptions(item.profile),
            signal: abort.signal,
            timeout: 30_000,
            headers: {
              Authorization: `Bearer ${item.profile.token}`,
              'X-Recording-Ticket': item.recording.ticket,
            },
          },
          (remote) => {
            if (
              remote.statusCode !== 200 ||
              Number(remote.headers['content-length']) !== item.recording.bytes
            ) {
              remote.destroy();
              reject(new Error('The recording is no longer available.'));
              return;
            }
            response.writeHead(200, {
              'Content-Type': 'video/mp4',
              'Content-Length': item.recording.bytes,
              'Content-Disposition': 'attachment; filename="Simulator-recording.mp4"',
              'Cache-Control': 'no-store',
            });
            let bytes = 0;
            const bounded = new Transform({
              transform(chunk: Buffer, _encoding, done) {
                bytes += chunk.length;
                done(
                  bytes > item.recording.bytes
                    ? new Error('Recording exceeded its expected size.')
                    : null,
                  chunk,
                );
              },
            });
            void pipeline(remote, bounded, response, { signal: abort.signal }).then(() => {
              bytes === item.recording.bytes
                ? resolve()
                : reject(new Error('Recording transfer was interrupted.'));
            }, reject);
          },
        );
        request.on('timeout', () => request.destroy(new Error('Recording transfer stalled.')));
        request.on('error', reject);
      });
      return true;
    } finally {
      response.off('close', cancel);
      clearTimeout(expiry);
      this.active.delete(abort);
    }
  }
  revoke(session?: string) {
    for (const [key, item] of this.tickets)
      if (!session || item.session === session) this.tickets.delete(key);
    for (const [abort, owner] of this.active) if (!session || owner === session) abort.abort();
  }
}
