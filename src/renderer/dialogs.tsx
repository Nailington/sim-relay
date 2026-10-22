import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  Monitor,
  Plus,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type {
  DesktopApi,
  HostEntry,
  HostStatus,
  Inventory,
  Probe,
  Simulator,
} from '../shared/types';
import { Busy, Modal } from './components';
import { parseCommand } from './input';

export function PairModal({
  api,
  initialUrl,
  onClose,
  onPaired,
  onDemo,
}: {
  api?: DesktopApi;
  initialUrl: string;
  onClose(): void;
  onPaired(host: HostEntry): void;
  onDemo(): void;
}) {
  const [url, setUrl] = useState(initialUrl),
    [token, setToken] = useState(''),
    [probe, setProbe] = useState<Probe>(),
    [verified, setVerified] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!api) {
      setError(
        'Direct connections are available in the desktop app. Run npm run dev, or install a packaged app.',
      );
      return;
    }
    setBusy(true);
    try {
      if (!probe) setProbe(await api.probe(url));
      else onPaired(await api.pair(probe, token));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={probe ? `Pair with ${probe.info.name}` : 'Connect a Mac'}
      subtitle={
        probe
          ? 'Verify this Mac before sharing access.'
          : 'Choose a Mac on your network or enter its address.'
      }
      onClose={onClose}
    >
      <form onSubmit={submit}>
        {!probe ? (
          <>
            <label className="field">
              Mac host address
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-mac.local:49300"
                required
                autoComplete="url"
              />
            </label>
            <p className="field-hint">
              Find this address in the Mac’s host setup. Direct IP addresses and SSH tunnels work
              too.
            </p>
            <div className="info-box">
              <Monitor size={20} />
              <p>
                On your Mac, start sharing in Sim Relay or run <code>npm run host</code>. Keep the
                host running while you connect.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="fingerprint">
              <span>HOST CERTIFICATE · SHA-256</span>
              <code>{probe.fingerprint}</code>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
              />
              This fingerprint matches the one shown on my Mac.
            </label>
            <label className="field">
              Pairing token
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Copy from your Mac’s host setup"
                required
                autoComplete="off"
              />
            </label>
            <p className="field-hint">
              The token grants control of this Mac’s simulators. Saved tokens use your operating
              system’s secure storage; without it, pairing lasts for this session.
            </p>
            {(!probe.info.companion || !probe.info.xcode) && (
              <p className="inline-error">
                The host needs {!probe.info.xcode ? 'Xcode' : 'idb_companion'} before it can stream
                simulators.
              </p>
            )}
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            onClick={
              probe
                ? () => {
                    setProbe(undefined);
                    setToken('');
                    setVerified(false);
                  }
                : onDemo
            }
          >
            {probe ? 'Change address' : 'Explore demo'}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || (!!probe && !verified)}
          >
            {busy ? (
              <Busy text="Connecting…" />
            ) : probe ? (
              <>
                Pair Mac <ShieldCheck size={15} />
              </>
            ) : (
              <>
                Find Mac <ArrowRight size={15} />
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CreateModal({
  inventory,
  onClose,
  onCreate,
}: {
  inventory: Inventory;
  onClose(): void;
  onCreate(data: { name: string; deviceType: string; runtime: string }): Promise<void>;
}) {
  const [runtime, setRuntime] = useState(inventory.runtimes[0]?.identifier ?? '');
  const runtimeInfo = inventory.runtimes.find((r) => r.identifier === runtime);
  const types = inventory.devicetypes.filter(
    (d) =>
      !runtimeInfo?.supportedDeviceTypes ||
      runtimeInfo.supportedDeviceTypes.some((t) => t.identifier === d.identifier),
  );
  const [deviceType, setDeviceType] = useState(types[0]?.identifier ?? ''),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="A fresh simulator."
      subtitle="Create an iPhone or iPad on the selected Mac."
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onCreate({
              name: name.trim() || types.find((d) => d.identifier === deviceType)!.name,
              deviceType,
              runtime,
            });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!inventory.runtimes.length ? (
          <div className="info-box">
            <p>
              No iOS runtimes are installed on this Mac. Open Xcode → Settings → Components on the
              Mac and install an iOS runtime, then refresh.
            </p>
          </div>
        ) : (
          <>
            <label className="field">
              iOS runtime
              <select
                value={runtime}
                onChange={(e) => {
                  setRuntime(e.target.value);
                  const r = inventory.runtimes.find((r) => r.identifier === e.target.value);
                  const t = inventory.devicetypes.find(
                    (d) =>
                      !r?.supportedDeviceTypes ||
                      r.supportedDeviceTypes.some((t) => t.identifier === d.identifier),
                  );
                  setDeviceType(t?.identifier ?? '');
                }}
              >
                {inventory.runtimes.map((r) => (
                  <option key={r.identifier} value={r.identifier}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Device
              <select value={deviceType} onChange={(e) => setDeviceType(e.target.value)}>
                {types.map((d) => (
                  <option key={d.identifier} value={d.identifier}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Simulator name <span>optional</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={types.find((d) => d.identifier === deviceType)?.name ?? 'My simulator'}
                maxLength={100}
              />
            </label>
            <p className="field-hint">
              Uses the selected Mac’s CPU and storage. The simulator stays on that Mac after you
              disconnect.
            </p>
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !runtime || !deviceType}>
            {busy ? (
              <Busy text="Creating…" />
            ) : (
              <>
                <Plus size={15} />
                Create simulator
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function HostModal({ api, onClose }: { api?: DesktopApi; onClose(): void }) {
  const [status, setStatus] = useState<HostStatus>({ running: false }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    api
      ?.hostStatus()
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, [api]);
  const isMac = api?.platform === 'darwin';
  return (
    <Modal
      title="Share this Mac."
      subtitle="Make its iOS simulators available to your other computers."
      onClose={onClose}
    >
      {isMac ? (
        <>
          {!status.running ? (
            <>
              <div className="info-box">
                <ShieldCheck size={20} />
                <p>
                  Sharing lets paired clients manage simulators and run simulator commands as your
                  user. Only share the pairing token with people you trust.
                </p>
              </div>
              <p className="modal-note">
                Requires Xcode, an installed iOS runtime, and idb_companion. The app must stay open
                while sharing.
              </p>
            </>
          ) : (
            <>
              <div className="sharing-status">
                <span className="green-dot" />
                Sharing is on
              </div>
              <label className="field">
                Host address
                <input readOnly value={status.addresses?.[0] ?? status.url} />
              </label>
              <label className="field">
                Pairing token
                <div className="copy-field">
                  <input readOnly type="password" value={status.token} />
                  <button
                    aria-label="Copy pairing token"
                    onClick={() => {
                      void api!
                        .copyText(status.token!)
                        .then(() => setCopied(true))
                        .catch(() => setError('Select the token field and copy it manually.'));
                    }}
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              </label>
              <div className="fingerprint">
                <span>VERIFY THIS FINGERPRINT ON YOUR CLIENT</span>
                <code>{status.fingerprint}</code>
              </div>
              <p className="modal-note">
                Xcode: {status.info?.xcode ? 'ready' : 'not found'} · Input service:{' '}
                {status.info?.companion ? 'ready' : 'not found'}
              </p>
            </>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button className="button secondary" onClick={onClose}>
              Close
            </button>
            <button
              disabled={busy}
              className={`button ${status.running ? 'danger' : 'primary'}`}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  if (status.running) {
                    await api!.stopHost();
                    setStatus({ running: false });
                  } else setStatus(await api!.startHost());
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Busy /> : status.running ? 'Stop sharing' : 'Start sharing'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="info-box">
            <Monitor size={24} />
            <p>
              Hosting runs on macOS. Open Sim Relay on your Mac and choose “Set up a Mac host,” or
              use the command line steps below.
            </p>
          </div>
          <div className="code-block">
            <code>
              brew tap facebook/fb
              <br />
              brew install idb-companion
              <br />
              npm install
              <br />
              npm run host
            </code>
          </div>
          <p className="modal-note">
            Run these in this project on the Mac. Install Xcode and an iOS runtime first. Then
            return here and connect using the Mac’s address and token.
          </p>
        </>
      )}
    </Modal>
  );
}

export function ActionModal({
  kind,
  selected,
  demo,
  api,
  host,
  onClose,
  notify,
}: {
  kind: 'url' | 'command' | 'location' | 'text';
  selected?: Simulator;
  demo: boolean;
  api?: DesktopApi;
  host?: HostEntry;
  onClose(): void;
  notify(message: string): void;
}) {
  const [text, setText] = useState(kind === 'command' ? 'list devices' : ''),
    [latitude, setLatitude] = useState('37.3349'),
    [longitude, setLongitude] = useState('-122.0090'),
    [output, setOutput] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={
        kind === 'command'
          ? 'The command panel.'
          : kind === 'url'
            ? 'Open a URL.'
            : kind === 'text'
              ? 'Paste text into iOS.'
              : 'Set a location.'
      }
      subtitle={
        kind === 'command'
          ? 'Run simctl commands on the selected Mac.'
          : `Send to ${selected?.name ?? 'your simulator'}.`
      }
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            if (kind === 'command') {
              const args = parseCommand(text).map((a) =>
                a === '$DEVICE' ? (selected?.udid ?? a) : a,
              );
              if (demo)
                setOutput(
                  `Demo mode: xcrun simctl ${args.join(' ')}\n\nConnect a Mac to execute commands.`,
                );
              else
                setOutput(
                  (
                    await api!.request<{ output: string }>(host!.id, 'POST', '/command', {
                      args,
                      confirmed,
                    })
                  ).output || 'Command completed.',
                );
            } else if (demo) {
              notify('Demo action. Connect a Mac to send it to iOS.');
              onClose();
            } else if (kind === 'text') {
              await api!.request(host!.id, 'POST', `/devices/${selected!.udid}/text`, { text });
              for (const [code, phase] of [
                [227, 'down'],
                [25, 'down'],
                [25, 'up'],
                [227, 'up'],
              ] as const)
                api!.input({ type: 'key', code, phase });
              notify('Text sent to the focused field in iOS');
              onClose();
            } else if (kind === 'url') {
              await api!.request(host!.id, 'POST', `/devices/${selected!.udid}/url`, { url: text });
              notify('URL opened on the simulator');
              onClose();
            } else {
              await api!.request(host!.id, 'POST', `/devices/${selected!.udid}/location`, {
                latitude: Number(latitude),
                longitude: Number(longitude),
              });
              notify('Simulator location updated');
              onClose();
            }
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {kind === 'command' ? (
          <>
            <label className="field">
              simctl arguments
              <input
                className="monospace"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setConfirmed(false);
                }}
                required
                spellCheck={false}
              />
            </label>
            <p className="field-hint">
              Use <code>$DEVICE</code> for the selected simulator. Arguments are sent directly,
              without a shell. Paths refer to files on the Mac.
            </p>
            <div className="command-examples">
              {[
                'list devices',
                'launch $DEVICE com.apple.Preferences',
                'install $DEVICE "/path/on/mac/MyApp.app"',
                'help',
              ].map((example) => (
                <button
                  type="button"
                  key={example}
                  onClick={() => {
                    setText(example);
                    setConfirmed(false);
                  }}
                >
                  {example}
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Allow this command to change or delete simulator data.
            </label>
            {output && (
              <pre className="command-output" tabIndex={0}>
                {output}
              </pre>
            )}
          </>
        ) : kind === 'text' ? (
          <>
            <label className="field">
              Text
              <textarea
                rows={6}
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={16000}
                required
              />
            </label>
            <p className="field-hint">
              Focus a text field in iOS before opening this panel. This updates the simulator
              clipboard and sends Command + V. Unicode text is supported.
            </p>
          </>
        ) : kind === 'url' ? (
          <label className="field">
            URL or app deep link
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="https://example.com or myapp://screen"
              required
              autoComplete="url"
            />
          </label>
        ) : (
          <div className="field-row">
            <label className="field">
              Latitude
              <input
                type="number"
                step="any"
                min={-90}
                max={90}
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                required
              />
            </label>
            <label className="field">
              Longitude
              <input
                type="number"
                step="any"
                min={-180}
                max={180}
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                required
              />
            </label>
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Close
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Busy text="Sending…" />
            ) : kind === 'command' ? (
              <>
                <Terminal size={14} />
                Run command
              </>
            ) : kind === 'url' ? (
              'Open URL'
            ) : kind === 'text' ? (
              'Paste text'
            ) : (
              'Set location'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
