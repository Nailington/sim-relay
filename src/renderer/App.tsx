import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Globe2,
  House,
  Keyboard,
  Laptop,
  Link2,
  LockKeyhole,
  Maximize2,
  Monitor,
  Moon,
  Plus,
  Power,
  Radio,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Sun,
  Tablet,
  Terminal,
  Unplug,
  Vibrate,
  Wifi,
  X,
} from 'lucide-react';
import type { HostEntry, Inventory, Simulator, StreamMeta, InputEvent } from '../shared/types';
import { Busy, IconButton, Modal } from './components';
import { DeviceStage } from './DeviceStage';
import { demoHosts, demoInventory } from './demo';
import { PairModal, CreateModal, HostModal, ActionModal } from './dialogs';

const empty: Inventory = { devices: [], runtimes: [], devicetypes: [] };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type ModalKind =
  'pair' | 'create' | 'host' | 'help' | 'url' | 'command' | 'location' | 'text' | null;

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
  const [metadata, setMetadata] = useState<StreamMeta>();
  const [fps, setFps] = useState(0);
  const [targetFps, setTargetFps] = useState(30);
  const [homeSignal, setHomeSignal] = useState(0);
  const [dark, setDark] = useState(false);
  const [zoom, setZoom] = useState(false);
  const selected = inventory.devices.find((d) => d.udid === selectedId);
  const currentHost = useRef(host?.id);
  currentHost.current = host?.id;
  const connectionAttempt = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
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
  }, [host, modal]);
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
  const refreshInventory = async (entry = host) => {
    if (!entry || entry.source === 'demo') return;
    const value = await api!.request<Inventory>(entry.id, 'GET', '/devices');
    if (currentHost.current === entry.id) setInventory(value);
    return value;
  };
  const stopStream = async () => {
    connectionAttempt.current++;
    await api?.disconnect();
    setStream('off');
    setMetadata(undefined);
    setFps(0);
  };
  const chooseHost = async (entry: HostEntry) => {
    if (busy) return;
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
    <div className={`app ${zoom ? 'expanded' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <Radio size={23} />
          </span>
          <div>
            sim relay<span>YOUR MAC. ANYWHERE.</span>
          </div>
          <span className="version">α</span>
        </div>
        <div className="workspace-switch">
          <div className="workspace-avatar">P</div>
          <span>
            Personal workspace<small>Local & direct connections</small>
          </span>
          <ChevronDown size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <button
          className="nav-item selected"
          onClick={() => {
            setZoom(false);
          }}
        >
          <Smartphone size={17} />
          Simulators<span>{inventory.devices.length}</span>
        </button>
        <button className="nav-item" onClick={() => setModal('command')} disabled={!host}>
          <Terminal size={17} />
          Command panel<kbd>⌘ K</kbd>
        </button>
        <div className="host-heading">
          <span className="nav-label">MAC HOSTS</span>
          <IconButton
            label="Add Mac"
            onClick={() => {
              setPairUrl('');
              setModal('pair');
            }}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        <div className="host-list">
          {allHosts.map((entry) => (
            <button
              key={entry.id}
              className={`host-item ${host?.id === entry.id ? 'selected' : ''}`}
              onClick={() => void chooseHost(entry)}
              disabled={!!busy}
            >
              <span className="host-glyph">
                {entry.name.includes('Book') ? <Laptop size={22} /> : <Monitor size={22} />}
                <i className={entry.source === 'discovered' ? 'discovered-dot' : ''} />
              </span>
              <span>
                {entry.name}
                <small>
                  {entry.source === 'demo'
                    ? 'Demo host'
                    : entry.source === 'saved'
                      ? entry.sessionOnly
                        ? 'Paired · this session'
                        : 'Paired Mac'
                      : 'Nearby · pair to connect'}
                </small>
              </span>
              {host?.id === entry.id && <ChevronRight size={14} />}
            </button>
          ))}
          {!allHosts.length && (
            <p className="discover-empty">
              <Wifi size={20} />
              Looking for Macs on your network<small>Start sharing on a Mac to find it here.</small>
            </p>
          )}
        </div>
        <button
          className="add-host"
          onClick={() => {
            setPairUrl('');
            setModal('pair');
          }}
        >
          <Plus size={15} /> Connect a Mac
        </button>
        <div className="sidebar-bottom">
          <div className="host-promo">
            <span className="mini-brand">
              <Cable size={18} />
            </span>
            <strong>Put your Mac to work.</strong>
            <p>Share its simulators with any computer on your network.</p>
            <button onClick={() => setModal('host')}>
              Set up a Mac host <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="nav-item" onClick={() => setModal('help')}>
            <CircleHelp size={17} />
            Getting started
            <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-foot">
            <span className="green-dot" />
            Local first. Cloud free.<span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>Simulators</strong>
          </div>
          <div>
            <span className={`connection-badge ${demo ? 'demo' : ''}`}>
              <span className={demo ? 'amber-dot' : host ? 'green-dot' : 'gray-dot'} />
              {demo ? 'Demo workspace' : host ? 'Paired host' : 'No Mac connected'}
            </span>
            <IconButton label="Connection help" onClick={() => setModal('help')}>
              <CircleHelp size={17} />
            </IconButton>
            <div className="profile-avatar">P</div>
          </div>
        </header>
        <div className="main-body">
          <section className="page-heading">
            <div className="eyebrow">
              <span className="little-line" /> THE REMOTE SIMULATOR WORKSPACE
            </div>
            <div className="heading-row">
              <div>
                <h1>Big ideas. Any screen.</h1>
                <p>Your iOS simulators, right here. Powered by your Mac.</p>
              </div>
              <button
                className="button primary"
                onClick={() => {
                  if (!host) setModal('pair');
                  else setModal('create');
                }}
                disabled={!!busy}
              >
                <Plus size={16} />
                {host ? 'New simulator' : 'Connect a Mac'}
              </button>
            </div>
          </section>
          {demo && (
            <div className="demo-banner">
              <Sparkles size={15} />
              <span>You’re exploring a demo. Connect your Mac for live simulators.</span>
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
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <IconButton label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </IconButton>
            </div>
          )}
          <section className="host-strip">
            <div className="host-strip-icon">
              <Monitor size={21} />
            </div>
            <div>
              <strong>{host?.name ?? 'Your next workspace starts with a Mac'}</strong>
              <span>
                {host
                  ? host.url.replace('https://', '')
                  : 'Discover a nearby Mac or connect directly with its address.'}
              </span>
            </div>
            <div className="host-strip-right">
              {host ? (
                <>
                  <span className="subtle-badge">
                    <span className={demo ? 'amber-dot' : 'green-dot'} />
                    {demo ? 'Preview' : host.sessionOnly ? 'This session' : 'Paired'}
                  </span>
                  <span className="vertical-rule" />
                  <Wifi size={15} />
                  <span>{demo ? 'Demo network' : 'Direct connection'}</span>
                  <IconButton
                    label="Refresh simulators"
                    disabled={!!busy}
                    onClick={() =>
                      void act('Refreshing', async () => {
                        if (demo) {
                          await delay(300);
                          notify('Demo simulators refreshed');
                        } else await refreshInventory();
                      })
                    }
                  >
                    <RefreshCw size={15} />
                  </IconButton>
                  {!demo && (
                    <IconButton
                      label="Forget this Mac"
                      disabled={!!busy}
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
                      <Unplug size={15} />
                    </IconButton>
                  )}
                </>
              ) : (
                <button className="button secondary small" onClick={explore}>
                  Explore demo <ArrowRight size={14} />
                </button>
              )}
            </div>
          </section>
          <section className="devices-section">
            <div className="section-toolbar">
              <div className="tabs">
                <button
                  className={filter === 'all' ? 'active' : ''}
                  onClick={() => setFilter('all')}
                >
                  All simulators <span>{inventory.devices.length}</span>
                </button>
                <button
                  className={filter === 'running' ? 'active' : ''}
                  onClick={() => setFilter('running')}
                >
                  Running{' '}
                  <span>{inventory.devices.filter((d) => d.state === 'Booted').length}</span>
                </button>
              </div>
              <label className="search">
                <Search size={15} />
                <input
                  ref={searchInput}
                  aria-label="Search simulators"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a simulator…"
                />
                <kbd>/</kbd>
              </label>
            </div>
            <div className="device-cards">
              {filtered.map((device) => (
                <button
                  key={device.udid}
                  className={`device-card ${selectedId === device.udid ? 'active' : ''}`}
                  onClick={() => void selectDevice(device)}
                  disabled={!!busy}
                >
                  <span className="device-miniature">
                    {device.name.includes('iPad') ? (
                      <Tablet size={35} strokeWidth={1.1} />
                    ) : (
                      <Smartphone size={34} strokeWidth={1.1} />
                    )}
                  </span>
                  <span className="device-card-copy">
                    <strong>{device.name}</strong>
                    <small>
                      {device.runtime} <span>·</span>{' '}
                      {device.name.includes('iPad') ? 'iPad' : 'iPhone'}
                    </small>
                    <span className={`device-state ${device.state === 'Booted' ? 'running' : ''}`}>
                      <i />
                      {device.state === 'Booted'
                        ? 'Running'
                        : device.state === 'Shutdown'
                          ? 'Powered off'
                          : device.state}
                    </span>
                  </span>
                  {selectedId === device.udid && (
                    <span className="selected-check">
                      <Check size={11} />
                    </span>
                  )}
                </button>
              ))}
              {host && (
                <button
                  className="new-device-card"
                  onClick={() => setModal('create')}
                  disabled={!!busy}
                >
                  <span>
                    <Plus size={18} />
                  </span>
                  <strong>Create a simulator</strong>
                  <small>Make room for another idea.</small>
                </button>
              )}
            </div>
            {!filtered.length && host && (
              <p className="empty-list">
                {query || filter !== 'all'
                  ? 'No simulators match this view.'
                  : 'No iOS simulators yet. Create one using an installed iOS runtime.'}
              </p>
            )}
          </section>
          {selected ? (
            <section className="viewer-panel">
              <header className="viewer-heading">
                <span className="viewer-device-icon">
                  <Smartphone size={18} />
                </span>
                <div>
                  <strong>{selected.name}</strong>
                  <span>{selected.runtime}</span>
                </div>
                <span className={`stream-badge ${stream === 'live' ? 'live' : ''}`}>
                  <i />
                  {demo && stream === 'live'
                    ? 'Demo display'
                    : stream === 'live'
                      ? 'Live display'
                      : stream === 'connecting'
                        ? 'Connecting'
                        : 'Display disconnected'}
                </span>
                <div className="viewer-heading-actions">
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
                  <IconButton
                    label={zoom ? 'Exit expanded view' : 'Expand display'}
                    active={zoom}
                    onClick={() => setZoom(!zoom)}
                  >
                    <Maximize2 size={16} />
                  </IconButton>
                </div>
              </header>
              <div className="viewer-content">
                <div className="display-area">
                  {stream === 'off' ? (
                    <div className="display-empty">
                      <span>
                        <Smartphone size={40} strokeWidth={1} />
                      </span>
                      <h2>A little closer to your next idea.</h2>
                      <p>Start this simulator and connect its display.</p>
                      <button
                        className="button primary"
                        disabled={!!busy}
                        onClick={() => void connect()}
                      >
                        <Power size={15} />
                        Start & connect
                      </button>
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
                      <Busy text="Connecting to your simulator…" />
                      <p>First boot can take a few minutes.</p>
                    </div>
                  )}
                </div>
                <aside className="inspector">
                  <div className="inspector-title">
                    <Settings2 size={15} /> Simulator controls
                  </div>
                  <div className="control-group">
                    <span className="control-label">HARDWARE</span>
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
                                metadata && metadata.width > metadata.height
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
                            disabled={!canControl}
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
                        disabled={!canControl}
                        onClick={() => input({ type: 'button', button: 'VOLUME_DOWN' })}
                      >
                        Volume −
                      </button>
                      <button
                        disabled={!canControl}
                        onClick={() => input({ type: 'button', button: 'VOLUME_UP' })}
                      >
                        Volume +
                      </button>
                    </div>
                  </div>
                  <div className="control-group">
                    <span className="control-label">QUICK ACTIONS</span>
                    <button
                      className="tool-row"
                      disabled={!canControl}
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
                      disabled={!canControl || !!busy}
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
                      disabled={!canControl}
                      onClick={() => setModal('url')}
                    >
                      <Link2 size={16} />
                      Open URL
                      <ArrowUpRight size={13} />
                    </button>
                    <button
                      className="tool-row"
                      disabled={!canControl}
                      onClick={() => setModal('text')}
                    >
                      <Keyboard size={16} />
                      Paste text
                      <ChevronRight size={13} />
                    </button>
                    <button
                      className="tool-row"
                      disabled={!canControl}
                      onClick={() => setModal('location')}
                    >
                      <Globe2 size={16} />
                      Set location
                      <ChevronRight size={13} />
                    </button>
                    <button
                      className="tool-row"
                      disabled={!host}
                      onClick={() => setModal('command')}
                    >
                      <Terminal size={16} />
                      Run simctl command
                      <ChevronRight size={13} />
                    </button>
                  </div>
                  <div className="control-group">
                    <span className="control-label">APPEARANCE</span>
                    <div className="segmented">
                      <button
                        disabled={!canControl || !!busy}
                        className={!dark ? 'active' : ''}
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
                    <span className="control-label">STREAM QUALITY</span>
                    <label className="quality-label">
                      Requested frame rate
                      <select
                        aria-label="Requested frame rate"
                        value={targetFps}
                        disabled={!!busy}
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
                  <div className="inspector-bottom">
                    <ShieldCheck size={17} />
                    <span>
                      {demo ? 'A preview of your workspace' : 'Encrypted from Mac to client'}
                      <small>
                        {demo ? 'No real device is connected' : 'TLS · pinned host certificate'}
                      </small>
                    </span>
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
                  Click the display to use your keyboard
                </span>
                <span>
                  {demo ? 'SIMULATED PREVIEW' : 'MJPEG / TLS'}
                  <span className="green-dot" />
                  {demo ? 'No Mac connected' : host?.name}
                </span>
              </footer>
            </section>
          ) : (
            <section className="welcome-panel">
              <div className="welcome-illustration">
                <div>
                  <Monitor size={60} strokeWidth={1} />
                </div>
                <span className="connection-line" />
                <div>
                  <Laptop size={52} strokeWidth={1} />
                </div>
                <span className="floating-phone">
                  <Smartphone size={38} strokeWidth={1.2} />
                  <i className="green-dot" />
                </span>
              </div>
              <span className="eyebrow">ONE MAC. ALL YOUR COMPUTERS.</span>
              <h2>Your simulator has a new home.</h2>
              <p>
                Run iOS on your Mac. See, touch, and test it from
                <br />
                macOS, Windows, or Linux.
              </p>
              <div>
                <button
                  className="button primary"
                  onClick={() => {
                    setPairUrl('');
                    setModal('pair');
                  }}
                >
                  <Plus size={16} />
                  Connect a Mac
                </button>
                <button className="button secondary" onClick={explore}>
                  Explore demo <ArrowRight size={15} />
                </button>
              </div>
              <div className="welcome-features">
                <span>
                  <Wifi size={15} />
                  Local network
                </span>
                <span>
                  <Cable size={15} />
                  Direct connection
                </span>
                <span>
                  <ShieldCheck size={15} />
                  Private by design
                </span>
              </div>
            </section>
          )}
          <footer className="page-footer">
            <span>Built for the way you build.</span>
            <span>
              <Code2 size={13} />
              macOS · Windows · Linux
            </span>
          </footer>
        </div>
      </main>
      {busy && (
        <div className="working-toast" role="status">
          <Busy text={busy} />
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
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
          title="Your Mac, within reach."
          subtitle="One host Mac. Any desktop computer."
          onClose={closeModal}
        >
          <div className="help-steps">
            <div>
              <span>1</span>
              <section>
                <h3>Start a host on your Mac</h3>
                <p>
                  Install Xcode and idb_companion, then use “Set up a Mac host” in the Mac app, or
                  run <code>npm run host</code>.
                </p>
              </section>
            </div>
            <div>
              <span>2</span>
              <section>
                <h3>Connect from your computer</h3>
                <p>
                  Choose a nearby Mac or enter its address. Compare its certificate fingerprint,
                  then enter its pairing token.
                </p>
              </section>
            </div>
            <div>
              <span>3</span>
              <section>
                <h3>Pick a simulator and build</h3>
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
              Alt + drag or Ctrl + scroll to pinch. Arbitrary multi-finger paths, audio, and full
              Mac desktop control are not implemented yet.
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
