import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Globe2,
  House,
  Keyboard,
  Link2,
  LockKeyhole,
  Maximize2,
  ExternalLink,
  Monitor,
  Moon,
  Plus,
  Power,
  Radio,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  Smartphone,
  Sun,
  Tablet,
  Terminal,
  Unplug,
  Vibrate,
  Wifi,
  X,
} from 'lucide-react';
import type {
  HostEntry,
  Inventory,
  Simulator,
  StreamMeta,
  InputEvent,
  DisplayContext,
} from '../shared/types';
import { Busy, IconButton, Modal } from './components';
import { DeviceStage } from './DeviceStage';
import { MediaControls } from './MediaControls';
import { demoHosts, demoInventory } from './demo';
import { DiagnosticsModal } from './DiagnosticsModal';
import { explainFailure, redactSecrets } from '../shared/diagnostics';
import { PairModal, CreateModal, HostModal, ActionModal } from './dialogs';

const empty: Inventory = { devices: [], runtimes: [], devicetypes: [] };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type ModalKind =
  | 'diagnostics'
  | 'pair'
  | 'create'
  | 'host'
  | 'help'
  | 'url'
  | 'command'
  | 'location'
  | 'text'
  | null;

export function App() {
  const api = window.relay;
  const [demo, setDemo] = useState(!api);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [host, setHost] = useState<HostEntry | undefined>(!api ? demoHosts[0] : undefined);
  const [inventory, setInventory] = useState<Inventory>(
    !api ? structuredClone(demoInventory) : empty,
  );
  const [selectedId, setSelectedId] = useState(!api ? demoInventory.devices[0].udid : '');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState<ModalKind>(null);
  const [pairUrl, setPairUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [stream, setStream] = useState<'off' | 'connecting' | 'live'>(!api ? 'live' : 'off');
  const [connectionStatus, setConnectionStatus] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const [metadata, setMetadata] = useState<StreamMeta>();
  const [fps, setFps] = useState(0);
  const [targetFps, setTargetFps] = useState(30);
  const [homeSignal, setHomeSignal] = useState(0);
  const [dark, setDark] = useState<boolean>();
  const [zoom, setZoom] = useState(false);
  const [controls, setControls] = useState(() => window.innerWidth > 800);
  const failure = error
    ? explainFailure(error, stream === 'connecting' ? 'stream' : 'action')
    : undefined;
  const selected = inventory.devices.find((d) => d.udid === selectedId);
  const currentHost = useRef(host?.id);
  currentHost.current = host?.id;
  const connectionAttempt = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const restoredWorkspace = useRef(false);
  const selectionGeneration = useRef(0);
  useEffect(() => {
    if (!api?.workspace || restoredWorkspace.current) return;
    restoredWorkspace.current = true;
    const saved = api.workspace.restore();
    const selection = selectionGeneration.current;
    let cancelled = false;
    void api
      .hosts()
      .then(async (entries) => {
        const entry = entries.find((candidate) => candidate.id === saved.hostId);
        if (!entry) return;
        const value = await api.request<Inventory>(entry.id, 'GET', '/devices');
        if (cancelled || selection !== selectionGeneration.current) return;
        setHost(entry);
        setInventory(value);
        setSelectedId(
          value.devices.some((device) => device.udid === saved.deviceId)
            ? saved.deviceId!
            : (value.devices[0]?.udid ?? ''),
        );
        if ([15, 30, 60].includes(saved.fps ?? 0)) setTargetFps(saved.fps!);
      })
      .catch((failure: Error) => {
        if (!cancelled && selection === selectionGeneration.current) setError(failure.message);
      });
    return () => {
      cancelled = true;
      restoredWorkspace.current = false;
    };
  }, [api]);
  useEffect(() => {
    if (!api?.workspace || !host) return;
    try {
      api.workspace.save({ hostId: host.id, deviceId: selectedId, fps: targetFps });
    } catch {
      setError('Browser preferences could not be saved. Allow storage for this site.');
    }
  }, [api, host, selectedId, targetFps]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !modal && zoom) {
        setZoom(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && host) {
        event.preventDefault();
        setModal('command');
      } else if (
        event.key === '/' &&
        !['INPUT', 'TEXTAREA', 'CANVAS', 'SELECT'].includes(
          (event.target as HTMLElement).tagName,
        ) &&
        !modal
      ) {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [host, modal, zoom]);
  const closeModal = useCallback(() => setModal(null), []);
  const reportError = useCallback((message: string) => setError(message), []);
  const notify = (message: string) => setToast(message);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const refresh = () =>
      api
        .hosts()
        .then((h) => {
          if (mounted) setHosts(h);
        })
        .catch((e) => {
          if (mounted) setError(e.message);
        });
    void refresh();
    const timer = setInterval(refresh, 4000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [api]);
  useEffect(() => {
    if (!api || demo) return;
    return api.onNotice((notice) => {
      if (notice.type === 'status') {
        setCanRetry(notice.state === 'retrying' || notice.state === 'failed');
        setConnectionStatus(
          notice.state === 'retrying'
            ? `${notice.message} Retry ${notice.attempt} in ${(notice.retryInMs ?? 0) / 1000}s.`
            : (notice.message ?? ''),
        );
        if (notice.state === 'connecting' || notice.state === 'retrying') {
          setStream('connecting');
          setFps(0);
        }
        if (notice.state === 'off' || notice.state === 'failed') {
          setStream('off');
          setFps(0);
        }
        if (notice.state === 'failed') setError(notice.message ?? 'Cannot connect to this Mac.');
      }
      if (notice.type === 'metadata') {
        setMetadata(notice.metadata);
        setStream('live');
      }
      if (notice.type === 'error') {
        setError(notice.message ?? 'The simulator stopped responding.');
        setStream('off');
      }
      if (notice.type === 'closed') {
        setStream('off');
        setFps(0);
      }
    });
  }, [api, demo]);
  useEffect(() => {
    if (!api) return;
    const restore = (context: DisplayContext) => {
      connectionAttempt.current++;
      setDemo(false);
      setHost(context.host);
      currentHost.current = context.host.id;
      setInventory((old) => ({ ...old, devices: [context.device] }));
      setSelectedId(context.device.udid);
      setTargetFps(context.fps);
      setMetadata(undefined);
      setStream(context.sessionActive ? 'connecting' : 'off');
      setError('');
      void api
        .request<Inventory>(context.host.id, 'GET', '/devices')
        .then((value) => {
          if (currentHost.current === context.host.id) setInventory(value);
        })
        .catch((e) => setError(e.message));
      if (context.sessionActive)
        void api
          .connect(context.host.id, context.device.udid, context.fps)
          .catch((e) => setError(e.message));
    };
    const off = api.onReturnDisplay(restore);
    void api
      .displayContext()
      .then((context) => {
        if (context) restore(context);
      })
      .catch((e) => setError(e.message));
    return off;
  }, [api]);
  const refreshInventory = async (entry = host) => {
    if (!entry || entry.source === 'demo') return;
    const value = await api!.request<Inventory>(entry.id, 'GET', '/devices');
    if (currentHost.current === entry.id) setInventory(value);
    return value;
  };
  const stopStream = async () => {
    selectionGeneration.current++;
    connectionAttempt.current++;
    await api?.disconnect();
    setStream('off');
    setConnectionStatus('');
    setCanRetry(false);
    setMetadata(undefined);
    setFps(0);
  };
  const chooseHost = async (entry: HostEntry) => {
    if (busy) return;
    selectionGeneration.current++;
    if (entry.source === 'discovered') {
      setPairUrl(entry.url);
      setModal('pair');
      return;
    }
    await stopStream();
    setError('');
    setHost(entry);
    currentHost.current = entry.id;
    setSelectedId('');
    setDark(undefined);
    setInventory(empty);
    if (entry.source === 'demo') {
      setDemo(true);
      setInventory(structuredClone(demoInventory));
      setSelectedId(demoInventory.devices[0].udid);
      setStream('live');
      return;
    }
    setDemo(false);
    setBusy('Loading simulators');
    try {
      const data = await refreshInventory(entry);
      if (data?.devices.length) setSelectedId(data.devices[0].udid);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const explore = () => {
    void chooseHost(demoHosts[0]);
  };
  const act = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const connect = async (device = selected, rate = targetFps) => {
    if (!device || !host) return;
    const attempt = ++connectionAttempt.current;
    setStream('connecting');
    setError('');
    setBusy('Starting simulator');
    try {
      if (demo) {
        await delay(500);
        setInventory((previous) => ({
          ...previous,
          devices: previous.devices.map((d) =>
            d.udid === device.udid ? { ...d, state: 'Booted' } : d,
          ),
        }));
        setStream('live');
      } else {
        await api!.request(host.id, 'POST', `/devices/${device.udid}/boot`);
        if (connectionAttempt.current !== attempt) return;
        await refreshInventory();
        if (connectionAttempt.current !== attempt) return;
        setBusy('Connecting display');
        await api!.connect(host.id, device.udid, rate);
      }
    } catch (e) {
      if (connectionAttempt.current === attempt) {
        setStream('off');
        setError((e as Error).message);
      }
    } finally {
      if (connectionAttempt.current === attempt) setBusy('');
    }
  };
  const selectDevice = async (device: Simulator) => {
    if (busy || device.udid === selectedId) return;
    await stopStream();
    setSelectedId(device.udid);
    setDark(undefined);
    setError('');
  };
  const input = (event: InputEvent) => {
    if (event.type === 'button' && event.button === 'HOME') setHomeSignal((n) => n + 1);
    if (demo) {
      if (!(event.type === 'button' && event.button === 'HOME'))
        notify('Demo action. Connect a Mac to control a real simulator.');
      return;
    }
    if (stream === 'live') api?.input(event);
  };
  const shutdown = () =>
    act('Shutting down', async () => {
      if (!selected || !host) return;
      await stopStream();
      if (demo)
        setInventory((previous) => ({
          ...previous,
          devices: previous.devices.map((d) =>
            d.udid === selected.udid ? { ...d, state: 'Shutdown' } : d,
          ),
        }));
      else {
        await api!.request(host.id, 'POST', `/devices/${selected.udid}/shutdown`);
        await refreshInventory();
      }
    });
  const filtered = inventory.devices.filter(
    (d) =>
      (filter === 'all' || d.state === 'Booted') &&
      `${d.name} ${d.runtime}`.toLowerCase().includes(query.toLowerCase()),
  );
  const canControl = stream === 'live';
  const allHosts = demo ? [...demoHosts, ...hosts] : hosts;

  return (
    <div className={`app ${zoom ? 'expanded' : ''} ${controls ? '' : 'controls-hidden'}`}>
      <aside className="sidebar" aria-label="Macs and simulators" inert={!!modal}>
        <div className="brand">
          <span className="brand-icon">
            <Radio size={23} />
          </span>
          <strong>Sim Relay</strong>
        </div>
        <section className="host-section" aria-labelledby="macs-heading">
          <div className="rail-heading">
            <h2 id="macs-heading">Macs</h2>
            <IconButton
              label="Connect a Mac"
              onClick={() => {
                setPairUrl('');
                setModal('pair');
              }}
            >
              <Plus size={16} />
            </IconButton>
          </div>
          <div className="host-list">
            {allHosts.map((entry) => (
              <button
                key={entry.id}
                className={`host-item ${host?.id === entry.id ? 'selected' : ''}`}
                aria-pressed={host?.id === entry.id}
                disabled={!!busy}
                onClick={() => void chooseHost(entry)}
              >
                <Monitor size={19} />
                <span>
                  <strong>{entry.name}</strong>
                  <small>
                    {entry.source === 'demo'
                      ? 'Simulated preview'
                      : entry.source === 'discovered'
                        ? 'Nearby • Pair to connect'
                        : entry.sessionOnly
                          ? 'Paired for this session'
                          : 'Paired'}
                  </small>
                </span>
                {host?.id === entry.id && <Check size={14} />}
              </button>
            ))}
          </div>
          {!allHosts.length && (
            <div className="discover-empty">
              <Wifi size={20} />
              <p>Searching for nearby Macs.</p>
              <small>Start sharing on the Mac, or connect using its address.</small>
              <button
                className="button secondary"
                onClick={() => {
                  setPairUrl('');
                  setModal('pair');
                }}
              >
                Connect a Mac
              </button>
            </div>
          )}
        </section>
        <section className="devices-section" aria-labelledby="simulators-heading">
          <div className="rail-heading">
            <h2 id="simulators-heading">Simulators</h2>
            <div>
              <IconButton
                label="Refresh simulators"
                disabled={!host || !!busy}
                onClick={() =>
                  void act('Refreshing simulators', async () => {
                    if (demo) notify('Simulated list refreshed');
                    else await refreshInventory();
                  })
                }
              >
                <RefreshCw size={15} />
              </IconButton>
              <IconButton
                label="Create simulator"
                disabled={!host || !!busy}
                onClick={() => setModal('create')}
              >
                <Plus size={16} />
              </IconButton>
            </div>
          </div>
          {host ? (
            <>
              <label className="search">
                <Search size={15} />
                <input
                  ref={searchInput}
                  aria-label="Search simulators"
                  placeholder="Search simulators"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd>/</kbd>
              </label>
              <div className="tabs" aria-label="Filter simulators">
                <button
                  aria-pressed={filter === 'all'}
                  className={filter === 'all' ? 'active' : ''}
                  onClick={() => setFilter('all')}
                >
                  All ({inventory.devices.length})
                </button>
                <button
                  aria-pressed={filter === 'running'}
                  className={filter === 'running' ? 'active' : ''}
                  onClick={() => setFilter('running')}
                >
                  Running ({inventory.devices.filter((d) => d.state === 'Booted').length})
                </button>
              </div>
              <div className="device-cards">
                {filtered.map((device) => (
                  <button
                    key={device.udid}
                    className={`device-card ${selectedId === device.udid ? 'active' : ''}`}
                    aria-pressed={selectedId === device.udid}
                    onClick={() => void selectDevice(device)}
                    disabled={!!busy}
                  >
                    {device.name.includes('iPad') ? <Tablet size={24} /> : <Smartphone size={24} />}
                    <span className="device-card-copy">
                      <strong>{device.name}</strong>
                      <small>{device.runtime}</small>
                      <span
                        className={`device-state ${device.state === 'Booted' ? 'running' : ''}`}
                      >
                        <i />
                        {device.state === 'Booted'
                          ? 'Running'
                          : device.state === 'Shutdown'
                            ? 'Powered off'
                            : device.state}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              {!filtered.length && (
                <div className="empty-list">
                  <p>
                    {query || filter !== 'all'
                      ? 'No matching simulators.'
                      : busy
                        ? 'Loading simulators…'
                        : 'No simulators on this Mac.'}
                  </p>
                  {query || filter !== 'all' ? (
                    <button
                      onClick={() => {
                        setQuery('');
                        setFilter('all');
                      }}
                    >
                      Clear filters
                    </button>
                  ) : (
                    !busy && <button onClick={() => setModal('create')}>Create simulator</button>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="rail-hint">Choose a Mac to load its simulators.</p>
          )}
        </section>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setModal('host')}>
            <Cable size={16} />
            {api?.platform === 'darwin' ? 'Share this Mac' : 'Mac host setup'}
          </button>
          {!demo && (
            <button className="nav-item" onClick={explore}>
              <Smartphone size={16} />
              Explore simulated preview
            </button>
          )}
        </div>
      </aside>
      <main className="main" inert={!!modal}>
        <header className="topbar">
          <div className="workspace-context">
            <Monitor size={17} />
            <strong>{host?.name ?? 'No Mac selected'}</strong>
            {host && (
              <span className="host-address" title={host.url}>
                {host.url.replace('https://', '')}
              </span>
            )}
          </div>
          <div className="workspace-actions">
            <button
              className="button quiet"
              aria-label="Run simctl command"
              disabled={!host}
              onClick={() => setModal('command')}
              title="Run simctl commands (Ctrl+K / Cmd+K)"
            >
              <Terminal size={16} />
              <span>Command</span>
            </button>
            <button
              className="button quiet"
              aria-label="Diagnostics"
              onClick={() => setModal('diagnostics')}
            >
              <Activity size={16} />
              <span>Diagnostics</span>
            </button>
            <IconButton label="Connection and keyboard help" onClick={() => setModal('help')}>
              <CircleHelp size={18} />
            </IconButton>
            {host && !demo && (
              <details className="host-menu">
                <summary aria-label="Mac options" title="Mac options">
                  <ChevronDown size={16} />
                </summary>
                <button
                  onClick={() =>
                    void act('Forgetting Mac', async () => {
                      await stopStream();
                      await api!.forget(host.id);
                      setHost(undefined);
                      setInventory(empty);
                      setSelectedId('');
                      setHosts(await api!.hosts());
                    })
                  }
                >
                  Forget {host.name}
                </button>
                <p>Removes this computer’s saved pairing.</p>
              </details>
            )}
          </div>
        </header>
        {demo && (
          <div className="demo-banner">
            <span>
              <strong>Simulated preview</strong> • No real Mac or simulator is connected.
            </span>
            <button
              onClick={() => {
                setPairUrl('');
                setModal('pair');
              }}
            >
              Connect a Mac <ArrowRight size={14} />
            </button>
          </div>
        )}
        {failure && (
          <div className="error-banner" role="alert">
            <div>
              <strong>{failure.title}</strong>
              <p>{failure.next}</p>
              <details>
                <summary>Technical details</summary>
                <pre>{redactSecrets(error)}</pre>
              </details>
            </div>
            <button className="button secondary small" onClick={() => setModal('diagnostics')}>
              Diagnostics
            </button>
            <IconButton label="Dismiss error" onClick={() => setError('')}>
              <X size={16} />
            </IconButton>
          </div>
        )}
        <div className="main-body">
          {selected ? (
            <section className="viewer-panel" aria-label={`${selected.name} on ${host?.name}`}>
              <header className="viewer-heading">
                <div className="viewer-identity">
                  <Smartphone size={20} />
                  <div>
                    <h1>{selected.name}</h1>
                    <span>{selected.runtime}</span>
                  </div>
                </div>
                <span
                  className={`stream-badge ${stream === 'live' && !demo ? 'live' : ''}`}
                  role="status"
                >
                  <i />
                  {demo && stream === 'live'
                    ? 'Preview'
                    : stream === 'live'
                      ? 'Live'
                      : stream === 'connecting'
                        ? 'Connecting…'
                        : 'Disconnected'}
                </span>
                <div className="viewer-heading-actions">
                  {/* Session/window actions belong here: pop out, retry, cancel, return. */}
                  {stream === 'off' ? (
                    <button
                      className="button primary small"
                      onClick={() => void connect()}
                      disabled={!!busy}
                    >
                      <Power size={14} />
                      Start & connect
                    </button>
                  ) : (
                    <IconButton
                      label="Disconnect display"
                      disabled={!!busy}
                      onClick={() => void stopStream()}
                    >
                      <Unplug size={16} />
                    </IconButton>
                  )}
                  {!demo && api && (
                    <IconButton
                      label="Pop out display"
                      disabled={!!busy}
                      onClick={() =>
                        void act('Opening display window', () =>
                          api.popOut(host!.id, selected.udid, targetFps),
                        )
                      }
                    >
                      <ExternalLink size={16} />
                    </IconButton>
                  )}
                  <IconButton
                    label={controls ? 'Hide simulator controls' : 'Show simulator controls'}
                    active={controls}
                    onClick={() => setControls(!controls)}
                  >
                    <Settings2 size={17} />
                  </IconButton>
                  <IconButton
                    label={zoom ? 'Exit expanded view' : 'Expand display'}
                    active={zoom}
                    onClick={() => setZoom(!zoom)}
                  >
                    <Maximize2 size={17} />
                  </IconButton>
                </div>
              </header>
              {connectionStatus && (
                <div className="display-connection" role="status">
                  {connectionStatus}
                  {canRetry && (
                    <>
                      <button onClick={() => void act('Retrying connection', () => api!.retry())}>
                        Retry now
                      </button>
                      <button onClick={() => void stopStream()}>Cancel retries</button>
                    </>
                  )}
                </div>
              )}
              <div className="viewer-content">
                <div className="display-area">
                  {stream === 'off' ? (
                    <div className="display-empty">
                      <Smartphone size={38} strokeWidth={1.3} />
                      <h2>{selected.name} is disconnected</h2>
                      <p>Use Start & connect above to boot this simulator and open its display.</p>
                      <p className="field-hint">
                        Disconnecting leaves the simulator running on {host?.name}.
                      </p>
                    </div>
                  ) : (
                    <DeviceStage
                      demo={demo}
                      api={api}
                      connected={stream === 'live'}
                      metadata={metadata}
                      homeSignal={homeSignal}
                      onFps={setFps}
                      onError={reportError}
                    />
                  )}
                  {stream === 'connecting' && (
                    <div className="display-loading">
                      <Busy text={busy || 'Connecting display…'} />
                      <p>First boot can take a few minutes.</p>
                    </div>
                  )}
                </div>
                <aside className="inspector">
                  <div className="inspector-title">
                    <Settings2 size={15} /> Controls
                  </div>
                  <MediaControls
                    api={demo ? undefined : api}
                    connected={stream === 'live'}
                    maxFps={targetFps}
                    onError={reportError}
                  />
                  {!canControl && (
                    <p className="control-prerequisite">
                      Connect the display to use simulator controls.
                    </p>
                  )}
                  <div className="control-group">
                    <span className="control-label">Hardware</span>
                    <div className="control-grid">
                      {[
                        [House, 'Home', () => input({ type: 'button', button: 'HOME' })],
                        [LockKeyhole, 'Lock', () => input({ type: 'button', button: 'LOCK' })],
                        [
                          RotateCw,
                          'Rotate',
                          () => {
                            input({
                              type: 'rotate',
                              orientation:
                                metadata &&
                                (metadata.orientation?.startsWith('LANDSCAPE') ||
                                  metadata.rotation === 90 ||
                                  metadata.rotation === 270 ||
                                  metadata.width > metadata.height)
                                  ? 'PORTRAIT'
                                  : 'LANDSCAPE_LEFT',
                            });
                          },
                        ],
                        [Vibrate, 'Shake', () => input({ type: 'shake' })],
                      ].map(([Icon, label, action]) => {
                        const Glyph = Icon as typeof House;
                        return (
                          <button
                            key={label as string}
                            disabled={!canControl || !!busy}
                            onClick={action as () => void}
                          >
                            <Glyph size={18} />
                            <span>{label as string}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="control-inline">
                      <button
                        disabled={!canControl || !!busy}
                        onClick={() => input({ type: 'button', button: 'VOLUME_DOWN' })}
                      >
                        Volume −
                      </button>
                      <button
                        disabled={!canControl || !!busy}
                        onClick={() => input({ type: 'button', button: 'VOLUME_UP' })}
                      >
                        Volume +
                      </button>
                    </div>
                  </div>
                  <div className="control-group">
                    <span className="control-label">Tools</span>
                    <button
                      className="tool-row"
                      disabled={!canControl || demo || !!busy}
                      title={
                        demo
                          ? 'Connect a real Mac to save screenshots'
                          : 'Save a PNG from this simulator'
                      }
                      onClick={() =>
                        void act('Saving screenshot', async () => {
                          if (demo) {
                            notify('Connect a Mac to save a real screenshot.');
                            return;
                          }
                          if (await api!.saveScreenshot(host!.id, selected.udid))
                            notify('Screenshot saved');
                        })
                      }
                    >
                      <ArrowDownToLine size={16} />
                      Save screenshot<span>PNG</span>
                    </button>
                    <button
                      className="tool-row"
                      disabled={!canControl || demo || !!busy}
                      title={
                        demo
                          ? 'Connect a real Mac to install apps'
                          : 'Install a zipped simulator app'
                      }
                      onClick={() =>
                        void act('Installing app', async () => {
                          if (demo) {
                            notify('Connect a Mac to install a simulator app.');
                            return;
                          }
                          if (await api!.installApp(host!.id, selected.udid))
                            notify('App installed on the simulator');
                        })
                      }
                    >
                      <Plus size={16} />
                      Install app<span>.app.zip</span>
                    </button>
                    <button
                      className="tool-row"
                      disabled={!canControl || !!busy}
                      onClick={() => setModal('url')}
                    >
                      <Link2 size={16} />
                      Open URL
                      <ArrowUpRight size={13} />
                    </button>
                    <button
                      className="tool-row"
                      disabled={!canControl || !!busy}
                      onClick={() => setModal('text')}
                    >
                      <Keyboard size={16} />
                      Paste text
                      <ChevronRight size={13} />
                    </button>
                    <button
                      className="tool-row"
                      disabled={!canControl || !!busy}
                      onClick={() => setModal('location')}
                    >
                      <Globe2 size={16} />
                      Set location
                      <ChevronRight size={13} />
                    </button>
                  </div>
                  <div className="control-group">
                    <span className="control-label">iOS appearance</span>
                    <div className="segmented">
                      <button
                        disabled={!canControl || !!busy}
                        className={dark === false ? 'active' : ''}
                        onClick={() =>
                          void act('Setting appearance', async () => {
                            if (!demo)
                              await api!.request(
                                host!.id,
                                'POST',
                                `/devices/${selected.udid}/appearance`,
                                { appearance: 'light' },
                              );
                            setDark(false);
                          })
                        }
                      >
                        <Sun size={14} />
                        Light
                      </button>
                      <button
                        disabled={!canControl || !!busy}
                        className={dark ? 'active' : ''}
                        onClick={() =>
                          void act('Setting appearance', async () => {
                            if (!demo)
                              await api!.request(
                                host!.id,
                                'POST',
                                `/devices/${selected.udid}/appearance`,
                                { appearance: 'dark' },
                              );
                            setDark(true);
                          })
                        }
                      >
                        <Moon size={14} />
                        Dark
                      </button>
                    </div>
                  </div>
                  <div className="control-group">
                    <span className="control-label">Stream</span>
                    <label className="quality-label">
                      Requested frame rate
                      <select
                        aria-label="Requested frame rate"
                        value={targetFps}
                        disabled={!!busy || stream !== 'off'}
                        onChange={(e) => {
                          const rate = Number(e.target.value);
                          setTargetFps(rate);
                          if (stream === 'live') void connect(selected, rate);
                        }}
                      >
                        <option value={15}>15 fps</option>
                        <option value={30}>30 fps</option>
                        <option value={60}>60 fps</option>
                      </select>
                    </label>
                    <div className="quality-note">
                      <span
                        className={
                          demo ? 'amber-dot' : stream === 'live' ? 'green-dot' : 'gray-dot'
                        }
                      />
                      {demo
                        ? 'Demo has no live performance data'
                        : stream === 'live'
                          ? `${fps} frames decoded / second`
                          : 'Connect to measure performance'}
                    </div>
                  </div>
                  <button
                    className="shutdown"
                    disabled={selected.state !== 'Booted' || !!busy}
                    onClick={() => void shutdown()}
                  >
                    <Power size={14} />
                    Shut down simulator
                  </button>
                </aside>
              </div>
              <footer className="viewer-footer">
                <span>
                  <Keyboard size={14} />
                  Click the display to type.{' '}
                  <button onClick={() => setModal('help')}>Input help</button>
                </span>
                <span>
                  {demo
                    ? 'Simulated display'
                    : stream === 'live'
                      ? `TLS • ${fps} fps decoded`
                      : 'No active stream'}
                </span>
              </footer>
            </section>
          ) : (
            <section className="welcome-panel">
              <Radio size={42} strokeWidth={1.3} />
              <h1>{host ? 'Choose a simulator' : 'Connect to your Mac'}</h1>
              <p>
                {host
                  ? `Select a simulator from ${host.name}, or create one with an installed iOS runtime.`
                  : 'Start sharing in Sim Relay on the Mac with Xcode. Then choose it in the sidebar or enter its address.'}
              </p>
              <div>
                <button
                  className="button primary"
                  disabled={!!busy}
                  onClick={() => {
                    setPairUrl('');
                    setModal(host ? 'create' : 'pair');
                  }}
                >
                  <Plus size={16} />
                  {host ? 'Create simulator' : 'Connect a Mac'}
                </button>
                {!host && (
                  <button className="button secondary" onClick={explore}>
                    Explore preview
                  </button>
                )}
              </div>
              <button className="text-button" onClick={() => setModal('help')}>
                Setup and connection help
              </button>
            </section>
          )}
        </div>
      </main>
      {busy && (
        <div className="working-toast" role="status">
          <Busy text={busy + '…'} />
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal === 'diagnostics' && (
        <DiagnosticsModal
          api={api}
          host={host}
          stream={stream}
          fps={fps}
          failureStage={failure?.stage}
          onClose={closeModal}
        />
      )}
      {modal === 'pair' && (
        <PairModal
          api={api}
          initialUrl={pairUrl}
          onClose={closeModal}
          onPaired={(entry) => {
            if (entry.sessionOnly)
              notify('Paired for this session. Secure storage is unavailable.');
            setModal(null);
            void chooseHost(entry);
          }}
          onDemo={() => {
            setModal(null);
            explore();
          }}
        />
      )}
      {modal === 'create' && (
        <CreateModal
          inventory={inventory}
          hostName={host?.name}
          onClose={closeModal}
          onCreate={async (data) => {
            if (!host) throw new Error('Connect to a Mac first.');
            if (demo) {
              const device: Simulator = {
                udid: `demo-${Date.now()}`,
                name: data.name,
                state: 'Shutdown',
                runtime: inventory.runtimes.find((r) => r.identifier === data.runtime)!.name,
                deviceTypeIdentifier: data.deviceType,
              };
              setInventory((value) => ({ ...value, devices: [...value.devices, device] }));
              await stopStream();
              setSelectedId(device.udid);
            } else {
              const result = await api!.request<{ udid: string }>(
                host.id,
                'POST',
                '/devices',
                data,
              );
              await refreshInventory();
              await stopStream();
              setSelectedId(result.udid);
            }
            setModal(null);
            notify(demo ? 'Demo simulator created' : 'Simulator created');
          }}
        />
      )}
      {modal === 'host' && <HostModal api={api} onClose={closeModal} />}
      {modal === 'help' && (
        <Modal
          title="Setup and input help"
          subtitle="Connect a host, then use its simulator display."
          onClose={closeModal}
        >
          <div className="help-steps">
            <div>
              <span>1</span>
              <section>
                <h3>Start a host on your Mac</h3>
                <p>
                  Install Xcode and idb_companion, then choose “Share this Mac” in the Mac app, or
                  run <code>sim-relay-host</code>.
                </p>
              </section>
            </div>
            <div>
              <span>2</span>
              <section>
                <h3>Connect from your computer</h3>
                <p>
                  Choose a nearby Mac or enter its address. Compare its certificate fingerprint,
                  then enter its pairing code.
                </p>
              </section>
            </div>
            <div>
              <span>3</span>
              <section>
                <h3>Open a simulator display</h3>
                <p>
                  Create an iPhone or iPad with an installed iOS runtime. Click “Start & connect” to
                  stream and interact.
                </p>
              </section>
            </div>
          </div>
          <div className="info-box">
            <strong>Input in this version</strong>
            <p>
              Touch, drag, long press, keyboard, pinch, rotation, shake, and hardware buttons. Use
              Alt + drag or Ctrl + scroll to pinch. Two touchscreen contacts perform a pinch on
              lift. Continuous pinch, twist, and arbitrary multi-finger paths are unavailable. Click
              the display to type. Ctrl+K or Cmd+K opens simctl commands; / focuses search. Escape
              exits expanded view.
            </p>
          </div>
          <p className="modal-note">
            Use the same network, a direct Ethernet connection, or an SSH tunnel. No cloud service
            is required.
          </p>
        </Modal>
      )}
      {(modal === 'url' || modal === 'location' || modal === 'command' || modal === 'text') && (
        <ActionModal
          kind={modal}
          selected={selected}
          demo={demo}
          api={api}
          host={host}
          onClose={closeModal}
          notify={notify}
        />
      )}
    </div>
  );
}
