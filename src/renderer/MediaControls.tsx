import { useEffect, useRef, useState } from 'react';
import type { DesktopApi } from '../shared/types';
import {
  defaultQuality,
  type MediaCapabilities,
  type QualityLimits,
  type RecordingStatus,
  type StreamMetrics,
} from '../shared/media';
import { AudioPlayback } from './media-playback';
import './media.css';

/** Mount once per display window, outside conditional connected content so early capabilities arrive. */
export function MediaControls({
  api,
  connected,
  maxFps = 30,
  onError,
}: {
  api?: DesktopApi;
  connected: boolean;
  maxFps?: number;
  onError(message: string): void;
}) {
  const [capabilities, setCapabilities] = useState<MediaCapabilities>();
  const [recording, setRecording] = useState<RecordingStatus>({ phase: 'idle' });
  const [metrics, setMetrics] = useState<StreamMetrics>();
  const [limits, setLimits] = useState(defaultQuality());
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState(false);
  const [consent, setConsent] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [now, setNow] = useState(Date.now());
  const playback = useRef<AudioPlayback | undefined>(undefined);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    if (!api) return;
    const off = api.onMediaNotice((notice) => {
      if (notice.type === 'media-capabilities') setCapabilities(notice.capabilities);
      if (notice.type === 'metrics') setMetrics(notice.metrics);
      if (notice.type === 'recording') {
        setRecording(notice.recording);
        if (notice.recording.phase === 'error' && notice.recording.message)
          errorHandler.current(notice.recording.message);
      }
      if (notice.type === 'audio') {
        setAudio(notice.active);
        if (!notice.active) {
          playback.current?.close();
          playback.current = undefined;
        }
        if (notice.message) errorHandler.current(notice.message);
      }
    });
    const offAudio = api.onAudio((pcm) => playback.current?.push(pcm));
    return () => {
      off();
      offAudio();
      playback.current?.close();
      playback.current = undefined;
    };
  }, [api]);
  useEffect(() => {
    if (!connected) {
      playback.current?.close();
      playback.current = undefined;
      setAudio(false);
      setRecording({ phase: 'idle' });
      setMetrics(undefined);
      setLimits(defaultQuality());
      setConsent(false);
    }
  }, [connected]);
  useEffect(() => {
    if (connected && capabilities?.adaptive && api) {
      const initial = defaultQuality(maxFps);
      setLimits(initial);
      void api.setQuality(initial).catch((error: Error) => errorHandler.current(error.message));
    }
  }, [api, connected, capabilities?.adaptive, maxFps]);
  useEffect(() => {
    playback.current?.volume(volume, muted);
  }, [volume, muted]);
  useEffect(() => {
    if (recording.phase !== 'recording') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording.phase]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const quality = (patch: Partial<QualityLimits>) => {
    const next = { ...limits, ...patch };
    setLimits(next);
    void api?.setQuality(next).catch((error: Error) => onError(error.message));
  };
  const startAudio = async () => {
    if (!api) return;
    try {
      playback.current ??= new AudioPlayback();
      playback.current.volume(volume, muted);
      await playback.current.resume();
      await api.startAudio(consent);
    } catch (error) {
      playback.current?.close();
      playback.current = undefined;
      throw error;
    }
  };
  const elapsed = Math.max(0, Math.floor((now - (recording.startedAt ?? now)) / 1000));
  const duration = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const hasRecording = ['recording', 'ready', 'error'].includes(recording.phase);
  if (!api) return null;
  return (
    <section className="media-controls" aria-label="Media controls">
      <fieldset disabled={!connected || busy}>
        <legend>Screen recording</legend>
        <div className="media-row">
          {recording.phase === 'idle' ? (
            <button
              disabled={!capabilities?.recording}
              onClick={() => void run(() => api.startRecording())}
            >
              Record screen
            </button>
          ) : null}
          {recording.phase === 'recording' ? (
            <>
              <span className="recording-indicator" role="status">
                ● Recording {duration}
              </span>
              <button onClick={() => void run(() => api.stopRecording())}>Stop recording</button>
            </>
          ) : null}
          {recording.phase === 'ready' ? (
            <button onClick={() => void run(() => api.saveRecording())}>Save MP4…</button>
          ) : null}
          {hasRecording ? (
            <button onClick={() => void run(() => api.discardRecording())}>
              Discard recording
            </button>
          ) : null}
        </div>
        <p role="status">
          {recording.message ||
            (
              {
                starting: 'Starting recording…',
                finalizing: 'Finalizing MP4…',
                saving: 'Saving to this computer…',
                ready: 'Ready to save. Keep this simulator connected.',
                idle: 'Silent MP4 at host resolution. Disconnecting discards unsaved recordings.',
              } as Partial<Record<RecordingStatus['phase'], string>>
            )[recording.phase]}
        </p>
      </fieldset>
      <fieldset disabled={!connected || busy}>
        <legend>Mac audio</legend>
        {!audio ? (
          <>
            <label className="media-consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />{' '}
              Share sound from every app on the Mac, including other simulators.
            </label>
            <button
              disabled={!consent || !capabilities?.audio}
              onClick={() => void run(startAudio)}
            >
              Listen to Mac audio
            </button>
            {!capabilities?.audio ? (
              <p>{capabilities?.audioReason ?? 'This host has not reported audio support.'}</p>
            ) : null}
          </>
        ) : (
          <>
            <div className="media-row">
              <button onClick={() => void run(() => api.stopAudio())}>Stop audio</button>
              <button aria-pressed={muted} onClick={() => setMuted(!muted)}>
                {muted ? 'Unmute playback' : 'Mute playback'}
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    playback.current ??= new AudioPlayback();
                    playback.current.volume(volume, muted);
                    await playback.current.resume();
                  })
                }
              >
                Resume playback
              </button>
            </div>
            <label>
              Playback volume{' '}
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </label>
            <p>Changes playback on this computer. Simulator volume buttons are separate.</p>
          </>
        )}
      </fieldset>
      <fieldset disabled={!connected || !capabilities?.adaptive}>
        <legend>Stream quality</legend>
        <div className="media-quality">
          <label>
            Mode
            <select
              value={limits.mode}
              onChange={(event) => quality({ mode: event.target.value as QualityLimits['mode'] })}
            >
              <option value="auto">Automatic</option>
              <option value="manual">Manual limits</option>
            </select>
          </label>
          <label>
            Maximum FPS
            <select
              value={limits.maxFps}
              onChange={(event) => quality({ maxFps: Number(event.target.value) })}
            >
              {[5, 10, 15, 30, 60].map((fps) => (
                <option key={fps}>{fps}</option>
              ))}
            </select>
          </label>
          <label>
            Maximum resolution
            <select
              value={limits.maxScale}
              onChange={(event) => quality({ maxScale: Number(event.target.value) })}
            >
              <option value="1">Full</option>
              <option value="0.75">75%</option>
              <option value="0.5">50%</option>
              <option value="0.35">35%</option>
            </select>
          </label>
          <label>
            JPEG quality
            <input
              type="range"
              min="0.35"
              max="0.9"
              step="0.05"
              value={limits.quality}
              onChange={(event) => quality({ quality: Number(event.target.value) })}
            />
          </label>
          <label>
            Bandwidth limit
            <select
              value={limits.maxKbps}
              onChange={(event) => quality({ maxKbps: Number(event.target.value) })}
            >
              {[512, 1000, 2000, 5000, 12000, 30000].map((kbps) => (
                <option key={kbps} value={kbps}>
                  {kbps / 1000} Mbps
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          Automatic mode reduces resolution, FPS, and compression quality when delivery or decoding
          falls behind. Manual mode keeps these capture limits. Both drop stale frames.
        </p>
        {metrics ? (
          <output className="media-metrics">
            {(metrics.kbps / 1000).toFixed(2)} Mbps video · {metrics.decodedFps?.toFixed(1) ?? '—'}{' '}
            decoded FPS · {metrics.dropped} host drops / sample
            <br />
            {metrics.settings.fps} FPS capture · {Math.round(metrics.settings.scale * 100)}%
            resolution · JPEG {Math.round(metrics.settings.quality * 100)}%<br />
            {metrics.decodeMs?.toFixed(1) ?? '—'} ms decode ·{' '}
            {metrics.roundTripMs?.toFixed(0) ?? '—'} ms control round trip
            <br />
            Capture-to-display latency is not measured. Audio adds up to 140 ms of client
            scheduling; video is displayed as it arrives.
          </output>
        ) : null}
      </fieldset>
    </section>
  );
}
