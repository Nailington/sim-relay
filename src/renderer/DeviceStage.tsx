import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Bluetooth,
  CalendarDays,
  Camera,
  CloudSun,
  Compass,
  Folder,
  Heart,
  Image,
  Mail,
  Map,
  MessageCircle,
  Music2,
  Phone,
  Settings,
  Signal,
  Wifi,
} from 'lucide-react';
import type { DesktopApi, InputEvent, StreamMeta, Point } from '../shared/types';
import { displayDimensions, fitDisplay, surfacePoint } from '../shared/display';
import { keyCode, normalizedPoint } from './input';
import { subscribeVideo } from './media-playback';

const apps = [
  ['Messages', MessageCircle, '#28c469'],
  ['Calendar', CalendarDays, '#fff'],
  ['Photos', Image, '#f6789b'],
  ['Camera', Camera, '#cbd1d5'],
  ['Weather', CloudSun, '#178bf2'],
  ['Maps', Map, '#56b897'],
  ['Clock', Activity, '#151518'],
  ['Settings', Settings, '#8e959c'],
  ['Mail', Mail, '#3288ef'],
  ['Health', Heart, '#fff'],
  ['Files', Folder, '#fff'],
  ['Safari', Compass, '#fff'],
] as const;
function DemoPhone({ homeSignal }: { homeSignal: number }) {
  const [page, setPage] = useState('');
  useEffect(() => setPage(''), [homeSignal]);
  return (
    <div className="demo-phone">
      <div className="ios-status">
        <b>9:41</b>
        <span>
          <Signal size={12} />
          <Wifi size={13} />
          <i className="battery" />
        </span>
      </div>
      <div className="island" />
      {page ? (
        <div className="demo-app">
          <button onClick={() => setPage('')}>
            <ArrowLeft size={16} /> Home
          </button>
          <h2>{page}</h2>
          <p>Interactive preview</p>
          <div className="ios-list">
            <div>
              <span className="avatar">SR</span>
              <span>
                Sim Relay<small>Demo workspace</small>
              </span>
            </div>
            {['Wi-Fi', 'Bluetooth', 'Display & Brightness', 'Accessibility', 'General'].map(
              (item, i) => (
                <button key={item} onClick={() => setPage(item)}>
                  {i === 0 ? (
                    <Wifi size={18} />
                  ) : i === 1 ? (
                    <Bluetooth size={18} />
                  ) : (
                    <Settings size={18} />
                  )}{' '}
                  {item}
                  <span>›</span>
                </button>
              ),
            )}
          </div>
          <p className="demo-explain">
            This preview is simulated.
            <br />
            Connect a Mac to interact with iOS.
          </p>
        </div>
      ) : (
        <>
          <div className="ios-widget">
            <span>Cupertino</span>
            <strong>21°</strong>
            <CloudSun size={36} />
            <small>
              Mostly sunny
              <br />
              H:24° L:16°
            </small>
          </div>
          <div className="app-grid">
            {apps.map(([name, Icon, color]) => (
              <button key={name} onClick={() => setPage(name)}>
                <span
                  style={{
                    background: color,
                    color: color === '#fff' ? '#428af0' : name === 'Camera' ? '#25292c' : '#fff',
                  }}
                >
                  {name === 'Calendar' ? (
                    <span className="calendar-icon">
                      <small>THU</small>22
                    </span>
                  ) : (
                    <Icon size={27} strokeWidth={name === 'Settings' ? 2 : 1.8} />
                  )}
                </span>
                <small>{name}</small>
              </button>
            ))}
          </div>
          <div className="ios-pages">
            ● <span>● ●</span>
          </div>
          <div className="ios-dock">
            {[
              [Phone, '#2ac968'],
              [Compass, '#fff'],
              [MessageCircle, '#2ac968'],
              [Music2, '#f04a6e'],
            ].map(([Icon, color], i) => {
              const Glyph = Icon as typeof Phone;
              return (
                <button
                  aria-label={['Phone', 'Safari', 'Messages', 'Music'][i]}
                  key={i}
                  style={{
                    background: color as string,
                    color: color === '#fff' ? '#168af3' : 'white',
                  }}
                  onClick={() => setPage(['Phone', 'Safari', 'Messages', 'Music'][i])}
                >
                  <Glyph size={26} />
                </button>
              );
            })}
          </div>
        </>
      )}
      <div className="home-indicator" />
    </div>
  );
}

export function DeviceStage({
  demo,
  api,
  connected,
  metadata,
  homeSignal,
  onFps,
  onError,
}: {
  demo: boolean;
  api?: DesktopApi;
  connected: boolean;
  metadata?: StreamMeta;
  homeSignal: number;
  onFps(value: number): void;
  onError(message: string): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [touch, setTouch] = useState<Point>();
  const contacts = useRef(
    new globalThis.Map<number, { point: Point; origin: Point; alt: boolean }>(),
  );
  const pinch = useRef<{ center: Point; distance: number; scale: number } | undefined>(undefined);
  const keys = useRef(new Set<number>()),
    wheelAt = useRef(0),
    moveAt = useRef(0);
  const meta = useRef(metadata);
  meta.current = metadata;
  const send = (event: InputEvent) => {
    if (connected && !demo) api?.input(event);
  };
  const release = () => {
    // Send the host an explicit release; it tracks the authoritative held contact/key set.
    if (connected && !demo) api?.input({ type: 'release' });
    contacts.current.clear();
    pinch.current = undefined;
    keys.current.clear();
    setTouch(undefined);
  };
  const pointAt = (e: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) =>
    normalizedPoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
  const source = (point: Point) => surfacePoint(point, meta.current?.rotation);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    release();
  }, [metadata?.rotation, metadata?.width, metadata?.height]);
  useEffect(() => {
    if (demo || !api || !connected) return;
    const off = subscribeVideo(
      api,
      () => canvas.current,
      onFps,
      onError,
      () => meta.current?.rotation ?? 0,
    );
    const hidden = () => {
      if (document.hidden) release();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      off();
      release();
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [api, connected, demo]);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !connected || demo) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (contacts.current.size || Date.now() - wheelAt.current < 120) return;
      wheelAt.current = Date.now();
      const center = normalizedPoint(event.clientX, event.clientY, el.getBoundingClientRect());
      if (event.ctrlKey || event.metaKey)
        send({
          type: 'pinch',
          center: source(center),
          scale: event.deltaY > 0 ? 0.8 : 1.25,
          duration: 0.12,
        });
      else
        send({
          type: 'swipe',
          start: source(center),
          end: source({
            x: Math.max(0, Math.min(1, center.x - event.deltaX / 700)),
            y: Math.max(0, Math.min(1, center.y - event.deltaY / 700)),
          }),
          duration: 0.12,
        });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [api, connected, demo]);
  const display = fitDisplay(size.width, size.height, metadata);
  const ratio = displayDimensions(metadata).width / displayDimensions(metadata).height;
  const finishPointer = (id: number, point: Point) => {
    const current = contacts.current.get(id);
    if (!current) return;
    contacts.current.delete(id);
    if (pinch.current) {
      send({ type: 'pinch', center: source(pinch.current.center), scale: pinch.current.scale });
      contacts.current.clear();
      pinch.current = undefined;
    } else if (current.alt)
      send({
        type: 'pinch',
        center: source(current.origin),
        scale: Math.max(0.25, Math.min(4, Math.exp((current.origin.y - point.y) * 3))),
      });
    else send({ type: 'touch', phase: 'up', point: source(point) });
    setTouch(undefined);
  };
  return (
    <div className="device-stage relay-stage" ref={stage}>
      <div
        className="relay-screen"
        style={{ width: display.width, height: display.height, aspectRatio: ratio }}
      >
        {demo ? (
          <div
            className="demo-scale"
            style={{ width: 280, height: 280 / ratio, transform: `scale(${display.width / 280})` }}
          >
            <DemoPhone homeSignal={homeSignal} />
          </div>
        ) : (
          <canvas
            ref={canvas}
            tabIndex={connected ? 0 : -1}
            aria-label="Remote simulator screen. Drag to swipe; hold to long press. Alt and drag or Control and scroll to pinch. Two touch contacts perform a pinch when lifted; independent multi-touch and twist are unavailable. Type while focused to use the keyboard."
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              if (
                !connected ||
                contacts.current.size >= 2 ||
                (e.pointerType === 'mouse' && e.button !== 0)
              )
                return;
              e.preventDefault();
              e.currentTarget.focus();
              e.currentTarget.setPointerCapture(e.pointerId);
              const point = pointAt(e);
              contacts.current.set(e.pointerId, { point, origin: point, alt: e.altKey });
              setTouch(point);
              if (contacts.current.size === 2) {
                send({ type: 'release' });
                const [a, b] = [...contacts.current.values()].map((c) => c.point);
                pinch.current = {
                  center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
                  distance: Math.max(0.001, Math.hypot(a.x - b.x, (a.y - b.y) / ratio)),
                  scale: 1,
                };
              } else if (!e.altKey) send({ type: 'touch', phase: 'down', point: source(point) });
            }}
            onPointerMove={(e) => {
              const current = contacts.current.get(e.pointerId);
              if (!current) return;
              const point = pointAt(e);
              current.point = point;
              setTouch(point);
              if (pinch.current) {
                const [a, b] = [...contacts.current.values()].map((c) => c.point);
                if (a && b)
                  pinch.current.scale = Math.max(
                    0.25,
                    Math.min(
                      4,
                      Math.hypot(a.x - b.x, (a.y - b.y) / ratio) / pinch.current.distance,
                    ),
                  );
              } else if (!current.alt && e.timeStamp - moveAt.current >= 16) {
                moveAt.current = e.timeStamp;
                send({ type: 'touch', phase: 'move', point: source(point) });
              }
            }}
            onPointerUp={(e) => finishPointer(e.pointerId, pointAt(e))}
            onPointerCancel={release}
            onLostPointerCapture={(e) => {
              if (contacts.current.has(e.pointerId)) release();
            }}
            onBlur={release}
            onKeyDown={(e) => {
              if (!connected) return;
              const code = keyCode(e.code);
              if (code !== undefined) {
                e.preventDefault();
                if (!keys.current.has(code)) {
                  keys.current.add(code);
                  send({ type: 'key', code, phase: 'down' });
                }
              }
            }}
            onKeyUp={(e) => {
              const code = keyCode(e.code);
              if (code !== undefined) {
                e.preventDefault();
                keys.current.delete(code);
                send({ type: 'key', code, phase: 'up' });
              }
            }}
          />
        )}
        {touch && (
          <span
            className="touch-indicator"
            style={{ left: `${touch.x * 100}%`, top: `${touch.y * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}
