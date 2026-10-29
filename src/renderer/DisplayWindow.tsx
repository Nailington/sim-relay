import { RecordingProtection, useRecordingProtection } from './RecordingProtection';
import { recordingActionCancelled } from '../shared/recording-protection';
import type { RecordingStatus } from '../shared/media';
import { useCallback, useEffect, useState } from 'react';
import { Camera, House, Maximize2, RotateCw } from 'lucide-react';
import type { DisplayContext, InputEvent, StreamMeta, StreamNotice } from '../shared/types';
import { MediaControls } from './MediaControls';
import { DeviceStage } from './DeviceStage';
import { ActionModal } from './dialogs';
import { Busy, IconButton } from './components';

type Action = 'url' | 'text' | 'location' | 'command';
export function DisplayWindow() {
  const { api: protectedApi, guard } = useRecordingProtection(window.relay!);
  const api = protectedApi!;
  const [context, setContext] = useState<DisplayContext>();
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>({ phase: 'idle' });
  const [adaptive, setAdaptive] = useState(false);
  const [metadata, setMetadata] = useState<StreamMeta>();
  const [status, setStatus] = useState<StreamNotice['state']>('connecting');
  const [message, setMessage] = useState('Connecting display');
  const [fps, setFps] = useState(0),
    [requested, setRequested] = useState(30);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [toast, setToast] = useState('');
  const [modal, setModal] = useState<Action | null>(null);
  const closeModal = useCallback(() => setModal(null), []);
  const reportError = useCallback((text: string) => setError(text), []);
  useEffect(() => {
    let disposed = false;
    const closeMenus = (event: KeyboardEvent) => {
      if (document.querySelector('dialog.recording-protection[open]')) return;
      if (event.key === 'Escape')
        document.querySelectorAll<HTMLDetailsElement>('.display-menu[open]').forEach((menu) => {
          menu.open = false;
          menu.querySelector<HTMLElement>('summary')?.focus();
        });
    };
    window.addEventListener('keydown', closeMenus);
    const off = api.onNotice((notice) => {
      if (notice.type === 'metadata') {
        setMetadata(notice.metadata);
        setStatus('live');
        setMessage('Live display');
      }
      if (notice.type === 'status') {
        setStatus(notice.state);
        setFps(0);
        setMessage(
          notice.state === 'retrying'
            ? `${notice.message} Retry ${notice.attempt} in ${(notice.retryInMs ?? 0) / 1000}s.`
            : (notice.message ??
                (notice.state === 'live'
                  ? 'Live display'
                  : notice.state === 'off'
                    ? 'Display disconnected'
                    : 'Connecting display')),
        );
        if (notice.state === 'failed') setError(notice.message ?? 'Cannot connect.');
      }
      if (notice.type === 'error') setError(notice.message ?? 'Cannot control this simulator.');
    });
    void api
      .displayContext()
      .then(async (value) => {
        if (disposed || !value) return;
        setContext(value);
        setRequested(value.fps);
        if (value.sessionActive) await api.connect(value.host.id, value.device.udid, value.fps);
        else {
          setStatus('off');
          setMessage(
            api.platform === 'web'
              ? 'Display disconnected. Choose Connect display to continue. Moving browser displays stops audio and recording.'
              : 'Display disconnected',
          );
        }
      })
      .catch((e) => {
        if (!disposed) {
          setError(e.message);
          setStatus('failed');
        }
      });
    return () => {
      disposed = true;
      off();
      window.removeEventListener('keydown', closeMenus);
    };
  }, [api]);
  const act = async (label: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (e) {
      if (!recordingActionCancelled(e)) setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const input = (event: InputEvent) => {
    if (status === 'live') api.input(event);
  };
  const rotate = () =>
    input({
      type: 'rotate',
      orientation:
        metadata?.orientation?.startsWith('LANDSCAPE') ||
        (metadata && metadata.width > metadata.height)
          ? 'PORTRAIT'
          : 'LANDSCAPE_LEFT',
    });
  const request = (action: string, body?: unknown) =>
    api.request(context!.host.id, 'POST', `/devices/${context!.device.udid}/${action}`, body);
  const connect = () =>
    act('Connecting display', async () => {
      if (guard && !(await guard.confirm('Connect this display'))) return;
      if (context!.device.state !== 'Booted') {
        await request('boot');
        setContext({ ...context!, device: { ...context!.device, state: 'Booted' } });
      }
      await api.connect(context!.host.id, context!.device.udid, requested);
    });
  if (!context)
    return (
      <div className="display-window">
        <RecordingProtection guard={guard} />
        <p role="status">{error || 'Opening simulator display…'}</p>
        <div hidden>
          <MediaControls api={api} connected={false} onError={reportError} />
        </div>
      </div>
    );
  const disabled = status !== 'live' || !!busy;
  return (
    <main className="display-window">
      <RecordingProtection guard={guard} />
      <header
        className="display-toolbar"
        aria-label="Simulator controls"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) {
            const menu = (event.target as HTMLElement).closest('details');
            if (menu) {
              menu.open = false;
              menu.querySelector<HTMLElement>('summary')?.focus();
            }
          }
        }}
      >
        <div className="display-identity">
          <strong>{context.device.name}</strong>
          <span>
            {context.host.name} · {context.device.runtime}
          </span>
        </div>
        <div className="display-toolbar-actions">
          {recordingStatus.phase === 'recording' && (
            <span role="status" className="recording-indicator">
              ● Recording
            </span>
          )}
          <details className="display-menu" name="display-tools">
            <summary>Media</summary>
            <div className="display-media-panel">
              <MediaControls
                api={api}
                connected={status === 'live'}
                maxFps={requested}
                onRecordingChange={setRecordingStatus}
                onAdaptiveChange={setAdaptive}
                onError={reportError}
              />
            </div>
          </details>
          <IconButton
            label="Home"
            disabled={disabled}
            onClick={() => input({ type: 'button', button: 'HOME' })}
          >
            <House size={17} />
          </IconButton>
          <IconButton label="Rotate device" disabled={disabled} onClick={rotate}>
            <RotateCw size={17} />
          </IconButton>
          <IconButton
            label="Save screenshot"
            disabled={disabled}
            onClick={() =>
              void act('Saving screenshot', async () => {
                if (await api.saveScreenshot(context.host.id, context.device.udid))
                  setToast('Screenshot saved');
              })
            }
          >
            <Camera size={17} />
          </IconButton>
          <details className="display-menu" name="display-tools">
            <summary>Hardware</summary>
            <div>
              <button disabled={disabled} onClick={() => input({ type: 'button', button: 'HOME' })}>
                Home
              </button>
              <button disabled={disabled} onClick={() => input({ type: 'button', button: 'LOCK' })}>
                Lock
              </button>
              <button disabled={disabled} onClick={rotate}>
                Rotate device
              </button>
              <button disabled={disabled} onClick={() => input({ type: 'shake' })}>
                Shake
              </button>
              <button
                disabled={disabled}
                onClick={() => input({ type: 'button', button: 'VOLUME_DOWN' })}
              >
                Volume down
              </button>
              <button
                disabled={disabled}
                onClick={() => input({ type: 'button', button: 'VOLUME_UP' })}
              >
                Volume up
              </button>
            </div>
          </details>
          <details className="display-menu" name="display-tools">
            <summary>Actions</summary>
            <div>
              <button
                disabled={disabled}
                onClick={() =>
                  void act('Saving screenshot', async () => {
                    if (await api.saveScreenshot(context.host.id, context.device.udid))
                      setToast('Screenshot saved');
                  })
                }
              >
                Save screenshot
              </button>
              <button
                disabled={disabled}
                onClick={() =>
                  void act('Installing app', async () => {
                    if (await api.installApp(context.host.id, context.device.udid))
                      setToast('App installed');
                  })
                }
              >
                Install app
              </button>
              {(['url', 'text', 'location', 'command'] as const).map((kind, i) => (
                <button
                  key={kind}
                  disabled={!!busy || (kind !== 'command' && disabled)}
                  onClick={() => setModal(kind)}
                >
                  {['Open URL', 'Paste text', 'Set location', 'Run simctl command'][i]}
                </button>
              ))}
              <button
                disabled={disabled}
                onClick={() =>
                  void act('Setting light appearance', () =>
                    request('appearance', { appearance: 'light' }),
                  )
                }
              >
                Light appearance
              </button>
              <button
                disabled={disabled}
                onClick={() =>
                  void act('Setting dark appearance', () =>
                    request('appearance', { appearance: 'dark' }),
                  )
                }
              >
                Dark appearance
              </button>
            </div>
          </details>
          <details className="display-menu" name="display-tools">
            <summary>Display</summary>
            <div>
              <label>
                Requested frame rate
                <select
                  value={requested}
                  disabled={
                    !!busy ||
                    (status !== 'off' && status !== 'failed' && !(status === 'live' && !adaptive))
                  }
                  onChange={(e) => {
                    const rate = Number(e.target.value);
                    if (status !== 'live') setRequested(rate);
                    else
                      void act('Changing stream quality', async () => {
                        if (guard && !(await guard.confirm('Change the frame rate'))) return;
                        await api.connect(context.host.id, context.device.udid, rate);
                        setRequested(rate);
                      });
                  }}
                >
                  {[15, 30, 60].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate} fps
                    </option>
                  ))}
                </select>
              </label>
              {status === 'live' && adaptive && (
                <p className="field-hint">Adjust live video in the Media menu.</p>
              )}
              <p role="status">{status === 'live' ? `${fps} frames decoded / second` : message}</p>
              <button disabled={!!busy} onClick={() => void connect()}>
                {context.device.state === 'Booted' ? 'Connect display' : 'Start & connect'}
              </button>
              <button
                disabled={!!busy}
                onClick={() => void act('Retrying connection', () => api.retry())}
              >
                Retry connection
              </button>
              <button onClick={() => void act('Disconnecting display', () => api.disconnect())}>
                Disconnect display / cancel retries
              </button>
              <button onClick={() => void api.windowAction('maximize')}>
                Maximize / restore window
              </button>
              <button onClick={() => void api.windowAction('fullscreen')}>
                Enter / exit full screen
              </button>
              <button
                disabled={!!busy}
                onClick={() => void act('Returning display', () => api.returnDisplay())}
              >
                Return to workspace
              </button>
              <button
                disabled={!!busy}
                onClick={() =>
                  void act('Shutting down simulator', async () => {
                    await request('shutdown');
                    await api.disconnect();
                    setContext({ ...context, device: { ...context.device, state: 'Shutdown' } });
                  })
                }
              >
                Shut down simulator
              </button>
            </div>
          </details>
          <IconButton
            label="Maximize or restore window"
            onClick={() => void api.windowAction('maximize')}
          >
            <Maximize2 size={16} />
          </IconButton>
        </div>
      </header>
      <div className="display-connection" role="status">
        {status === 'live' ? `Live · ${fps} decoded fps` : message}
        {(status === 'retrying' || status === 'failed') && (
          <>
            <button onClick={() => void act('Retrying connection', () => api.retry())}>
              Retry now
            </button>
            <button onClick={() => void api.disconnect()}>Cancel</button>
          </>
        )}
      </div>
      {error && (
        <div className="display-error" role="alert">
          {error}
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      <div className="display-screen-area">
        <DeviceStage
          demo={false}
          api={api}
          connected={status === 'live'}
          metadata={metadata}
          homeSignal={0}
          onFps={setFps}
          onError={reportError}
        />
      </div>
      <footer className="display-help">
        <details>
          <summary>Gesture help</summary>
          <p>
            Click and drag to swipe. Click and hold for a long press. Alt + drag or Control + scroll
            performs a pinch. On touchscreens, spread two contacts and lift to perform a pinch.
            Pinch is applied when lifted; continuous multi-touch and two-finger twist are
            unavailable. Click the screen to type. Moving focus releases input.
          </p>
          {metadata && metadata.orientationSource !== 'host' && (
            <p>
              This companion cannot report external orientation changes. Use Rotate here, or update
              idb_companion for host orientation reporting.
            </p>
          )}
        </details>
        {busy ? <Busy text={busy} /> : toast && <span role="status">{toast}</span>}
      </footer>
      {modal && (
        <ActionModal
          kind={modal}
          selected={context.device}
          demo={false}
          api={api}
          host={context.host}
          onClose={closeModal}
          notify={setToast}
        />
      )}
    </main>
  );
}
