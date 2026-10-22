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
import { keyCode, normalizedPoint } from './input';

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
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 500, height: 550 });
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  const pointer = useRef<{ id: number; point: Point; origin: Point; pinch: boolean } | undefined>(
    undefined,
  );
  const keys = useRef(new Set<number>());
  const wheelAt = useRef(0);
  const moveAt = useRef(0);
  const [touch, setTouch] = useState<Point>();
  const send = (event: InputEvent) => {
    if (connected && !demo) api?.input(event);
  };
  const release = () => {
    if (pointer.current && !pointer.current.pinch)
      send({ type: 'touch', phase: 'up', point: pointer.current.point });
    pointer.current = undefined;
    setTouch(undefined);
    for (const code of keys.current) send({ type: 'key', phase: 'up', code });
    keys.current.clear();
  };
  useEffect(() => {
    if (demo || !api || !connected) return;
    let disposed = false,
      busy = false,
      latest: Uint8Array | undefined,
      count = 0;
    const paint = async () => {
      if (busy || !latest || disposed) return;
      busy = true;
      const frame = latest;
      latest = undefined;
      try {
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(frame)], { type: 'image/jpeg' }),
        );
        const el = canvas.current;
        if (!disposed && el) {
          if (el.width !== bitmap.width || el.height !== bitmap.height) {
            el.width = bitmap.width;
            el.height = bitmap.height;
          }
          el.getContext('2d')?.drawImage(bitmap, 0, 0);
          count++;
        }
        bitmap.close();
      } catch {
        if (!disposed) onError('Cannot decode the simulator video. Reconnect to try again.');
      } finally {
        busy = false;
        if (latest && !disposed) void paint();
      }
    };
    const off = api.onFrame((frame) => {
      latest = frame;
      void paint();
    });
    const timer = setInterval(() => {
      onFps(count);
      count = 0;
    }, 1000);
    window.addEventListener('blur', release);
    return () => {
      disposed = true;
      off();
      clearInterval(timer);
      release();
      window.removeEventListener('blur', release);
    };
  }, [api, connected, demo]);
  const ratio = metadata ? metadata.width / metadata.height : 402 / 874;
  const displayHeight = Math.max(100, Math.min(size.height - 75, (size.width - 40) / ratio));
  return (
    <div ref={stage} className="device-stage">
      <div className="stage-grid" />
      <div
        className="phone-wrap"
        style={{ width: displayHeight * ratio + 10, height: displayHeight + 10 }}
      >
        <div className="phone-frame" style={{ aspectRatio: ratio }}>
          {demo ? (
            <div
              className="demo-scale"
              style={{
                width: 280,
                height: 280 / ratio,
                transform: `scale(${(displayHeight * ratio) / 280})`,
              }}
            >
              <DemoPhone homeSignal={homeSignal} />
            </div>
          ) : (
            <canvas
              ref={canvas}
              tabIndex={connected ? 0 : -1}
              aria-label="Remote simulator screen. Click or drag to touch. Use Alt and drag or Control and scroll to pinch. Type while focused to use the keyboard."
              style={{ aspectRatio: ratio }}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (!connected || pointer.current) return;
                e.preventDefault();
                e.currentTarget.focus();
                e.currentTarget.setPointerCapture(e.pointerId);
                const point = normalizedPoint(
                  e.clientX,
                  e.clientY,
                  e.currentTarget.getBoundingClientRect(),
                );
                pointer.current = { id: e.pointerId, point, origin: point, pinch: e.altKey };
                setTouch(point);
                if (!e.altKey) send({ type: 'touch', phase: 'down', point });
              }}
              onPointerMove={(e) => {
                if (!pointer.current || pointer.current.id !== e.pointerId) return;
                const point = normalizedPoint(
                  e.clientX,
                  e.clientY,
                  e.currentTarget.getBoundingClientRect(),
                );
                pointer.current.point = point;
                setTouch(point);
                if (!pointer.current.pinch && e.timeStamp - moveAt.current >= 16) {
                  moveAt.current = e.timeStamp;
                  send({ type: 'touch', phase: 'move', point });
                }
              }}
              onPointerUp={(e) => {
                const current = pointer.current;
                if (!current || current.id !== e.pointerId) return;
                const point = normalizedPoint(
                  e.clientX,
                  e.clientY,
                  e.currentTarget.getBoundingClientRect(),
                );
                if (current.pinch)
                  send({
                    type: 'pinch',
                    center: current.origin,
                    scale: Math.max(0.25, Math.min(4, Math.exp((current.origin.y - point.y) * 3))),
                  });
                else send({ type: 'touch', phase: 'up', point });
                pointer.current = undefined;
                setTouch(undefined);
              }}
              onPointerCancel={release}
              onLostPointerCapture={release}
              onBlur={release}
              onKeyDown={(e) => {
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
              onWheel={(e) => {
                if (!connected || Date.now() - wheelAt.current < 120) return;
                wheelAt.current = Date.now();
                const center = normalizedPoint(
                  e.clientX,
                  e.clientY,
                  e.currentTarget.getBoundingClientRect(),
                );
                if (e.ctrlKey || e.metaKey)
                  send({ type: 'pinch', center, scale: e.deltaY > 0 ? 0.8 : 1.25, duration: 0.12 });
                else
                  send({
                    type: 'swipe',
                    start: center,
                    end: {
                      x: Math.max(0, Math.min(1, center.x - e.deltaX / 700)),
                      y: Math.max(0, Math.min(1, center.y - e.deltaY / 700)),
                    },
                    duration: 0.12,
                  });
              }}
            />
          )}{' '}
          {touch && (
            <span
              className="touch-indicator"
              style={{ left: `${touch.x * 100}%`, top: `${touch.y * 100}%` }}
            />
          )}
        </div>
        <div className="phone-shadow" />
      </div>
      <div className="stage-caption">
        <span className="keycap">drag</span> Swipe <i /> <span className="keycap">alt + drag</span>{' '}
        Pinch <i /> <span className="keycap">click & hold</span> Long press
      </div>
    </div>
  );
}
