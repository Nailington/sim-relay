import { spawn, type ChildProcess } from 'node:child_process';
import { exec } from './process';
export { exec } from './process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { Inventory, StreamMeta, InputEvent, Orientation } from '../shared/types';
import { hidEvents, JpegFramer, jpegDimensions } from './protocol';
import { HidDispatcher } from './hid';
import type { VideoSettings } from '../shared/media';
import { displayRotation } from '../shared/display';

export const protoPath = () => {
  const directory = typeof __dirname === 'string' ? __dirname : path.resolve('src/host');
  return (
    [
      path.resolve('src/host/idb.proto'),
      path.join(directory, '../src/host/idb.proto'),
      path.join(directory, 'idb.proto'),
    ].find(existsSync) ?? path.resolve('src/host/idb.proto')
  );
};
// Dynamic gRPC methods are defined by the vendored, wire-compatible protocol.
export interface CompanionClient extends grpc.Client {
  getOrientation(
    request: object,
    options: grpc.CallOptions,
    cb: (error: grpc.ServiceError | null, result: { orientation: string }) => void,
  ): void;
  describe(
    request: object,
    options: grpc.CallOptions,
    cb: (
      error: grpc.ServiceError | null,
      result: {
        targetDescription: {
          displays?: { active: boolean; width: string; height: string }[];
          screenDimensions: {
            width: string;
            height: string;
            widthPoints: string;
            heightPoints: string;
            density: number;
          };
        };
      },
    ) => void,
  ): void;
  hid(cb: (error: grpc.ServiceError | null) => void): grpc.ClientWritableStream<object>;
  videoStream(): grpc.ClientDuplexStream<object, { payload?: { data?: Buffer } }>;
}
export function companionDefinition() {
  return grpc.loadPackageDefinition(
    protoLoader.loadSync(protoPath(), { longs: String, enums: String, defaults: true }),
  ) as unknown as { idb: { CompanionService: grpc.ServiceClientConstructor } };
}
export function companionExecutable() {
  return (
    process.env.IDB_COMPANION_PATH ??
    ['/opt/homebrew/bin/idb_companion', '/usr/local/bin/idb_companion'].find(existsSync) ??
    'idb_companion'
  );
}
export class MacSimulator {
  async run(
    args: string[],
    binary = false,
    stdin?: string,
    signal?: AbortSignal,
  ): Promise<string | Buffer> {
    const command = exec('xcrun', ['simctl', ...args], {
      timeout: 120_000,
      signal,
      maxBuffer: 32 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8',
      // simctl's pasteboard uses the process locale; SSH sessions may otherwise select Mac Roman.
      env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    });
    if (stdin !== undefined) command.child.stdin?.end(stdin);
    const result = await command;
    return result.stdout;
  }
  async inventory(signal?: AbortSignal): Promise<Inventory> {
    const list = JSON.parse(String(await this.run(['list', '--json'], false, undefined, signal)));
    const runtimes = list.runtimes.filter(
      (r: { identifier: string; isAvailable: boolean }) =>
        r.isAvailable && r.identifier.includes('.iOS-'),
    );
    const runtimeNames = new Map(
      runtimes.map((r: { identifier: string; name: string }) => [r.identifier, r.name]),
    );
    const devices = Object.entries(
      list.devices as Record<string, Record<string, unknown>[]>,
    ).flatMap(([runtime, devices]) =>
      runtimeNames.has(runtime)
        ? devices
            .filter((d) => d.isAvailable)
            .map((d) => ({ ...d, runtime: runtimeNames.get(runtime) }))
        : [],
    );
    return {
      devices,
      runtimes,
      devicetypes: list.devicetypes.filter((d: { productFamily: string }) =>
        ['iPhone', 'iPad'].includes(d.productFamily),
      ),
    } as Inventory;
  }
  async session(
    udid: string,
    fps: number,
    frame: (data: Buffer) => void,
    error: (e: Error) => void,
    signal?: AbortSignal,
  ): Promise<SimulatorSession> {
    return SimulatorSession.open(udid, fps, frame, error, signal);
  }
}

export class SimulatorSession {
  metadata!: StreamMeta;
  private child?: ChildProcess;
  private client?: CompanionClient;
  private hid?: HidDispatcher;
  private video?: grpc.ClientDuplexStream<object, { payload?: { data?: Buffer } }>;
  private directory = '';
  private closed = false;
  private closing?: Promise<void>;
  private orientationTimer?: ReturnType<typeof setInterval>;
  private nativeOrientedFrames = false;
  private requestedOrientation: Orientation = 'PORTRAIT';
  private activeTouch?: { x: number; y: number };
  private keys = new Set<number>();
  private videoSettings: VideoSettings = { fps: 30, scale: 1, quality: 0.7 };
  private frame?: (data: Buffer) => void;
  private onVideoError?: (error: Error) => void;
  private pointSize?: { short: number; long: number };
  static async open(
    udid: string,
    fps: number,
    frame: (data: Buffer) => void,
    onError: (e: Error) => void,
    signal?: AbortSignal,
  ) {
    const session = new SimulatorSession();
    const abort = () => {
      void session.close();
    };
    signal?.throwIfAborted();
    try {
      session.directory = await mkdtemp(path.join(tmpdir(), 'sim-relay-'));
      signal?.throwIfAborted();
      signal?.addEventListener('abort', abort, { once: true });
      const socket = path.join(session.directory, 'idb.sock');
      session.child = spawn(companionExecutable(), ['--udid', udid, '--grpc-domain-sock', socket], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise<void>((resolve, reject) => {
        let output = '',
          diagnostics = '';
        const timeout = setTimeout(
          () =>
            finish(
              new Error(
                'Input service did not start within 30 seconds. Check idb_companion and Xcode.',
              ),
            ),
          30_000,
        );
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          error ? reject(error) : resolve();
        };
        session.child!.once('error', finish);
        session.child!.once('exit', (code) =>
          finish(new Error(`Input service exited (${code}). ${diagnostics.slice(-1200)}`)),
        );
        session.child!.stderr!.on('data', (chunk) => {
          diagnostics = (diagnostics + chunk).slice(-4000);
        });
        session.child!.stdout!.on('data', (chunk) => {
          output += chunk;
          const lines = output.split('\n');
          output = lines.pop() ?? '';
          for (const line of lines) {
            try {
              if (JSON.parse(line).grpc_path) finish();
            } catch {
              /* diagnostic output */
            }
          }
        });
      });
      const Client = companionDefinition().idb.CompanionService;
      session.client = new Client(
        `unix:${socket}`,
        grpc.credentials.createInsecure(),
      ) as unknown as CompanionClient;
      session.metadata = await new Promise<StreamMeta>((resolve, reject) =>
        session.client!.describe({}, { deadline: Date.now() + 15000 }, (error, data) => {
          if (error) return reject(error);
          session.nativeOrientedFrames = !!data.targetDescription.displays?.length;
          const d = data.targetDescription.screenDimensions;
          const width = Number(d.width),
            height = Number(d.height);
          if (!width || !height)
            return reject(new Error('The simulator has no active display. Boot it and try again.'));
          resolve({
            width,
            height,
            rotation: 0,
            orientationSource: 'unavailable',
            widthPoints: Number(d.widthPoints) || width / (d.density || 1),
            heightPoints: Number(d.heightPoints) || height / (d.density || 1),
          });
        }),
      );
      let polling = false;
      const pollOrientation = () => {
        if (polling || session.closed) return;
        polling = true;
        session.client!.getOrientation({}, { deadline: Date.now() + 2000 }, (error, result) => {
          polling = false;
          if (session.closed) return;
          if (error) {
            if (error.code === grpc.status.UNIMPLEMENTED && session.orientationTimer)
              clearInterval(session.orientationTimer);
            return;
          }
          if (
            ['PORTRAIT', 'PORTRAIT_UPSIDE_DOWN', 'LANDSCAPE_LEFT', 'LANDSCAPE_RIGHT'].includes(
              result.orientation,
            )
          ) {
            session.requestedOrientation = result.orientation as Orientation;
            session.updateOrientation('host');
          }
        });
      };
      session.orientationTimer = setInterval(pollOrientation, 500);
      pollOrientation();
      session.hid = new HidDispatcher(
        (done) => session.client!.hid(done),
        (error) => {
          if (!session.closed) onError(error);
        },
      );
      session.frame = frame;
      session.onVideoError = onError;
      session.pointSize = {
        short: Math.min(session.metadata.widthPoints, session.metadata.heightPoints),
        long: Math.max(session.metadata.widthPoints, session.metadata.heightPoints),
      };
      session.child.on('exit', () => {
        if (!session.closed)
          onError(new Error('The simulator input service stopped. Reconnect to resume.'));
      });
      session.setVideoSettings({ fps, scale: 1, quality: 0.7 });
      return session;
    } catch (e) {
      await session.close();
      throw e;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  /** Restart only the video RPC; HID and simulator ownership remain intact. */
  setVideoSettings(settings: VideoSettings) {
    if (this.closed || !this.client) return;
    this.videoSettings = settings;
    const old = this.video;
    this.video = undefined;
    old?.cancel();
    const video = this.client.videoStream();
    this.video = video;
    const framer = new JpegFramer();
    video.on('data', (response) => {
      if (this.closed || this.video !== video || !response.payload?.data) return;
      try {
        for (const jpeg of framer.push(response.payload.data)) {
          const dimensions = jpegDimensions(jpeg);
          if (dimensions && this.pointSize) {
            // Encoded pixels may be scaled. Input coordinates always use native points.
            const landscape = dimensions.width > dimensions.height;
            if (
              dimensions.width !== this.metadata.width ||
              dimensions.height !== this.metadata.height
            )
              this.release();
            this.metadata = {
              ...this.metadata,
              ...dimensions,
              widthPoints: landscape ? this.pointSize.long : this.pointSize.short,
              heightPoints: landscape ? this.pointSize.short : this.pointSize.long,
            };
          }
          this.updateOrientation(this.metadata.orientationSource);
          this.frame?.(jpeg);
        }
      } catch (e) {
        this.onVideoError?.(e as Error);
      }
    });
    video.on('error', (error) => {
      if (!this.closed && this.video === video) this.onVideoError?.(error);
    });
    video.on('end', () => {
      if (!this.closed && this.video === video)
        this.onVideoError?.(new Error('The simulator stopped streaming. Reconnect to resume.'));
    });
    video.write({
      start: {
        format: 'MJPEG',
        fps: this.videoSettings.fps,
        compressionQuality: this.videoSettings.quality,
        scaleFactor: this.videoSettings.scale,
      },
    });
  }
  private updateOrientation(source = this.metadata.orientationSource) {
    const orientation = this.requestedOrientation;
    // Recent companions compose video in interface orientation. Legacy companions
    // expose the portrait IOSurface; compensate only for that path.
    const rotation = displayRotation(orientation, source, this.nativeOrientedFrames);
    if (rotation !== this.metadata.rotation) this.release();
    this.metadata = { ...this.metadata, orientation, rotation, orientationSource: source };
  }
  private release() {
    if (this.activeTouch) this.input({ type: 'touch', phase: 'up', point: this.activeTouch });
    for (const code of this.keys) this.input({ type: 'key', code, phase: 'up' });
  }
  input(event: InputEvent) {
    if (this.closed) return;
    if (event.type === 'release') {
      this.release();
      return;
    }
    if (event.type === 'rotate') {
      this.release();
      this.requestedOrientation = event.orientation;
      this.updateOrientation('requested');
    }
    if (event.type === 'touch') this.activeTouch = event.phase === 'up' ? undefined : event.point;
    if (event.type === 'key')
      event.phase === 'down' ? this.keys.add(event.code) : this.keys.delete(event.code);
    this.hid?.send(hidEvents(event, this.metadata), !this.activeTouch && this.keys.size === 0);
  }
  close(): Promise<void> {
    return (this.closing ??= this.finishClose());
  }
  private async finishClose() {
    if (this.closed) return;
    this.release();
    this.closed = true;
    if (this.orientationTimer) clearInterval(this.orientationTimer);
    this.video?.cancel();
    // Complete the final gesture and drain releases before stopping the owned process.
    await Promise.race([this.hid?.drain(), new Promise((resolve) => setTimeout(resolve, 1000))]);
    this.client?.close();
    if (this.child?.pid && this.child.exitCode === null) {
      const child = this.child;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          // The exit listener completes retirement; sending a signal is insufficient.
        }, 1000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
