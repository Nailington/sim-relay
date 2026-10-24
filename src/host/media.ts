import type { WebSocket } from 'ws';
import { WebSocket as Socket } from 'ws';
import { z } from 'zod';
import type { MediaCapabilities, MediaNotice, VideoSettings } from '../shared/media';
import { AdaptiveVideo } from './adaptive';
import { AudioCoordinator, audioHelper, type AudioCapture } from './audio';
import { RecordingStore, type Recording } from './recording';
import { exec } from './simulator';

const action = z.object({
  type: z.literal('media-control'),
  id: z.string().uuid(),
  action: z.enum([
    'recording-start',
    'recording-stop',
    'recording-discard',
    'audio-start',
    'audio-stop',
  ]),
  /** Explicit acknowledgement of host-wide capture on the client. */
  hostAudioConsent: z.boolean().optional(),
});
export class HostMedia {
  capabilities: MediaCapabilities;
  constructor(
    readonly recordings: RecordingStore,
    readonly audio = new AudioCoordinator(),
    recording = true,
  ) {
    this.capabilities = {
      recording,
      audio: false,
      audioScope: 'host',
      adaptive: true,
      audioReason:
        'The Mac owner must enable host-wide audio with SIM_RELAY_ENABLE_HOST_AUDIO=1, then restart the host.',
    };
  }
  async initialize() {
    await this.recordings.initialize();
    const helper = audioHelper();
    if (this.audio.enabled && helper) {
      try {
        const result = await exec(helper, ['--probe'], { timeout: 5000, maxBuffer: 4096 });
        this.capabilities.audio = result.stdout.trim() === 'screencapturekit-pcm16-48000-stereo-v1';
        this.capabilities.audioReason = this.capabilities.audio
          ? undefined
          : 'The Mac audio helper is incompatible. Reinstall Sim Relay.';
      } catch {
        this.capabilities.audioReason =
          'The Mac audio helper needs macOS 13 or later. Rebuild/reinstall Sim Relay on this Mac.';
      }
    } else if (this.audio.enabled)
      this.capabilities.audioReason =
        'The Mac audio helper is missing. Build/install the Mac host package.';
  }
}

/** All control, media, and downloads belong to one authenticated controller socket. */
export class MediaPeer {
  readonly video: AdaptiveVideo;
  private recording?: Recording;
  private audio?: AudioCapture;
  private audioAbort?: AbortController;
  private pendingAudio?: Promise<void>;
  private audioClosing?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private busy = false;
  private settings = '';
  private sentPing?: number;
  constructor(
    private ws: WebSocket,
    private udid: string,
    fps: number,
    private host: HostMedia,
    private apply: (settings: VideoSettings) => void,
  ) {
    this.video = new AdaptiveVideo(fps);
    this.send({ type: 'media-capabilities', capabilities: host.capabilities });
  }
  private send(value: MediaNotice | object) {
    if (!this.closed && this.ws.readyState === Socket.OPEN && this.ws.bufferedAmount < 512 * 1024)
      this.ws.send(JSON.stringify(value));
  }
  handle(raw: unknown): boolean {
    const type = (raw as { type?: string })?.type;
    if (type === 'quality') {
      this.video.configure((raw as { limits?: unknown }).limits);
      this.updateSettings();
      return true;
    }
    if (type === 'video-feedback') {
      this.video.report((raw as { feedback?: unknown }).feedback);
      return true;
    }
    if (type === 'media-pong') {
      if ((raw as { sentAt?: number }).sentAt === this.sentPing && this.sentPing !== undefined)
        this.video.roundTripMs = Math.max(0, performance.now() - this.sentPing);
      return true;
    }
    if (type !== 'media-control') return false;
    const command = action.parse(raw);
    if (this.busy) {
      this.send({
        type: 'media-result',
        id: command.id,
        error: 'A media action is still running. Wait and retry.',
      });
      return true;
    }
    this.busy = true;
    void this.control(command)
      .then(
        (result) => this.send({ type: 'media-result', id: command.id, result }),
        (error: Error) => this.send({ type: 'media-result', id: command.id, error: error.message }),
      )
      .finally(() => {
        this.busy = false;
      });
    return true;
  }
  private updateSettings() {
    const key = JSON.stringify(this.video.settings);
    if (this.settings !== key) {
      this.apply(this.video.settings);
      this.settings = key;
    }
  }
  tick() {
    if (this.closed) return;
    const metrics = this.video.sample();
    if (metrics) {
      this.updateSettings();
      this.send({ type: 'metrics', metrics });
      this.sentPing = performance.now();
      this.send({ type: 'media-ping', sentAt: this.sentPing });
    }
  }
  private async control(command: z.infer<typeof action>) {
    if (this.closed) throw new Error('Simulator session closed.');
    switch (command.action) {
      case 'recording-start': {
        if (!this.host.capabilities.recording)
          throw new Error('Screen recording requires a Mac host with Xcode.');
        if (this.recording) throw new Error('Save or discard the previous recording first.');
        const recording = this.host.recordings.create(this.udid, (status) => {
          // Expiry and encoder exit close autonomously. Release ownership only
          // after cleanup publishes idle, and ignore any obsolete lifecycle notice.
          if (this.recording !== recording) return;
          if (status.phase === 'idle') this.recording = undefined;
          this.send({ type: 'recording', recording: status });
        });
        this.recording = recording;
        try {
          await recording.start();
        } catch (error) {
          await recording.close();
          throw error;
        }
        break;
      }
      case 'recording-stop':
        if (!this.recording) throw new Error('There is no recording to stop.');
        try {
          return await this.recording.stop();
        } catch (error) {
          this.send({
            type: 'recording',
            recording: { phase: 'error', message: (error as Error).message },
          });
          throw error;
        }
      case 'recording-discard':
        await this.recording?.close();
        break;
      case 'audio-start':
        if (!command.hostAudioConsent)
          throw new Error('Confirm that audio includes every app on the Mac.');
        if (!this.host.capabilities.audio)
          throw new Error(
            this.host.capabilities.audioReason ?? 'Audio is unavailable on this host.',
          );
        if (this.audio || this.pendingAudio) return;
        this.audioClosing = undefined;
        this.audioAbort = new AbortController();
        this.pendingAudio = (async () => {
          const capture = await this.host.audio.start(
            this,
            (pcm) => {
              if (
                this.closed ||
                this.ws.readyState !== Socket.OPEN ||
                this.ws.bufferedAmount > 64 * 1024
              )
                return;
              // SRA1 cannot be confused with JPEG. Capture is fixed stereo PCM16/48k.
              this.ws.send(Buffer.concat([Buffer.from('SRA1'), pcm]));
            },
            (error) => {
              this.send({ type: 'audio', active: false, message: error.message });
              void this.stopAudio();
            },
            this.audioAbort!.signal,
          );
          if (this.closed || this.audioAbort!.signal.aborted) await capture.close();
          else {
            this.audio = capture;
            this.send({ type: 'audio', active: true });
          }
        })();
        try {
          await this.pendingAudio;
        } finally {
          this.pendingAudio = undefined;
        }
        break;
      case 'audio-stop':
        await this.stopAudio();
        break;
    }
  }
  private stopAudio() {
    this.audioAbort?.abort();
    return (this.audioClosing ??= (async () => {
      await this.audio?.close();
      this.audio = undefined;
      this.send({ type: 'audio', active: false });
    })());
  }
  close() {
    return (this.closing ??= (async () => {
      this.closed = true;
      this.audioAbort?.abort();
      await this.pendingAudio?.catch(() => {});
      // close assigned after pending startup, so startup races cannot escape ownership.
      await Promise.allSettled([this.audio?.close(), this.recording?.close()]);
    })());
  }
}
