import { useState, type FormEvent } from 'react';
import { ArrowRight, ArrowUpRight, Monitor, Plus, ShieldCheck, Terminal } from 'lucide-react';
import type { DesktopApi, HostEntry, Inventory, Probe, Simulator } from '../shared/types';
import { Busy, Modal } from './components';
import { explainFailure, redactSecrets } from '../shared/diagnostics';
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
      const failure = explainFailure(e, probe ? 'authentication' : 'network');
      setError(`${failure.title}. ${failure.next}`);
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
        {!api && (
          <p className="info-box">
            Connections require the desktop app. This browser preview cannot reach a real Mac.
            Install Sim Relay, or run npm run dev from the project.
          </p>
        )}
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
                On your Mac, choose “Share this Mac” in Sim Relay or run <code>sim-relay-host</code>
                . Keep the host running while you connect.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="fingerprint">
              <span>Host certificate (SHA-256)</span>
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
              Pairing code
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
              {probe.info.clientAuthorization
                ? 'The one-time code authorizes this computer to control the Mac’s simulators. Its saved credential uses your operating system’s secure storage; without it, pairing lasts for this session.'
                : 'This older host uses a shared pairing code. Saved pairing data uses your operating system’s secure storage; without it, pairing lasts for this session. Update the host for separate client authorization.'}
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
            {redactSecrets(error)}
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
            disabled={busy || !api || (!!probe && !verified)}
          >
            {busy ? (
              <Busy text={probe ? 'Pairing…' : 'Checking address…'} />
            ) : probe ? (
              <>
                Pair Mac <ShieldCheck size={15} />
              </>
            ) : (
              <>
                Check address <ArrowRight size={15} />
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
  hostName,
  onClose,
  onCreate,
}: {
  inventory: Inventory;
  hostName?: string;
  onClose(): void;
  onCreate(data: { name: string; deviceType: string; runtime: string }): Promise<void>;
}) {
  const runtimes = inventory.runtimes.filter((r) => r.isAvailable);
  const [runtime, setRuntime] = useState(runtimes[0]?.identifier ?? '');
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
      title="Create simulator"
      subtitle={`Create an iPhone or iPad on ${hostName ?? 'the selected Mac'}.`}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onCreate({
              name:
                name.trim() || types.find((d) => d.identifier === deviceType)?.name || 'Simulator',
              deviceType,
              runtime,
            });
          } catch (e) {
            const failure = explainFailure(e, 'action');
            setError(
              `${failure.title}. ${failure.next} Technical details: ${redactSecrets((e as Error).message)}`,
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {!runtimes.length ? (
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
                {runtimes.map((r) => (
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
            {!types.length && (
              <p className="inline-error">
                No device types support this runtime. Choose another runtime, or install its
                simulator components in Xcode on the Mac.
              </p>
            )}
            <p className="field-hint">
              Uses the selected Mac’s CPU and storage. The simulator stays on that Mac after you
              disconnect.
            </p>
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {redactSecrets(error)}
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

export { HostManagement as HostModal } from './HostManagement';

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
          ? 'Run simctl command'
          : kind === 'url'
            ? 'Open URL'
            : kind === 'text'
              ? 'Paste text'
              : 'Set location'
      }
      subtitle={
        kind === 'command'
          ? `Run on ${host?.name ?? 'the selected Mac'}${selected ? ` • $DEVICE is ${selected.name}` : ''}.`
          : `${selected?.name ?? 'No simulator selected'} on ${host?.name ?? 'the selected Mac'}${demo ? ' (simulated preview)' : ''}.`
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
            const failure = explainFailure(e, 'action');
            setError(
              `${failure.title}. ${failure.next} Technical details: ${redactSecrets((e as Error).message)}`,
            );
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
            {redactSecrets(error)}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Close
          </button>
          <button
            className="button primary"
            disabled={busy || !host || (kind !== 'command' && !selected)}
          >
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
