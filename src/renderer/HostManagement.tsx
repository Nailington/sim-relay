import { recordingActionCancelled } from '../shared/recording-protection';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Eye, EyeOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { Modal, Busy } from './components';
import { redactSecrets } from '../shared/diagnostics';
import type { DesktopApi } from '../shared/types';
import type {
  HostAuthorizedClient,
  HostClientPermissions,
  HostManagementApi,
  HostManagementStatus,
  HostServiceSettings,
} from '../shared/host-management';
import './host-management.css';

const stateLabel = {
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Running and ready',
  unhealthy: 'Registered but not ready',
  failed: 'Status unavailable',
};
export function HostManagement({ api, onClose }: { api?: DesktopApi; onClose(): void }) {
  const management = api?.hostManagement;
  const [status, setStatus] = useState<HostManagementStatus>();
  const [draft, setDraft] = useState<HostServiceSettings>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [code, setCode] = useState(''),
    [revealed, setRevealed] = useState(false);
  const [clients, setClients] = useState<HostAuthorizedClient[]>([]),
    [clientsLoaded, setClientsLoaded] = useState(false);
  const [editing, setEditing] = useState<HostAuthorizedClient>(),
    [revoke, setRevoke] = useState<string>();
  const mounted = useRef(true),
    loading = useRef(false),
    changing = useRef(false),
    showCode = useRef(false),
    epoch = useRef(0);
  const isMac = api?.platform === 'darwin';
  const refresh = useCallback(
    async (includeClients = false) => {
      if (!management || loading.current || changing.current) return;
      loading.current = true;
      const generation = epoch.current;
      try {
        const observed = await management.status();
        if (!mounted.current || changing.current || generation !== epoch.current) return;
        setStatus(observed);
        setDraft((previous) => previous ?? observed.settings);
        if (observed.state !== 'ready') {
          setCode('');
          setRevealed(false);
          showCode.current = false;
          setClients([]);
          setClientsLoaded(false);
        } else {
          if (showCode.current) {
            const current = await management.pairing();
            if (mounted.current && generation === epoch.current && showCode.current)
              setCode(current.token);
          }
          if (includeClients || clientsLoaded) {
            const current = await management.clients();
            if (mounted.current && generation === epoch.current && !changing.current) {
              setClients(current);
              setClientsLoaded(true);
            }
          }
        }
      } catch (e) {
        if (mounted.current && generation === epoch.current) {
          setStatus((s) => (s ? { ...s, state: 'failed' } : s));
          setCode('');
          setRevealed(false);
          showCode.current = false;
          setError(redactSecrets((e as Error).message));
        }
      } finally {
        loading.current = false;
      }
    },
    [management, clientsLoaded],
  );
  useEffect(() => {
    mounted.current = true;
    if (isMac) void refresh();
    const timer = isMac ? setInterval(() => void refresh(), 3000) : undefined;
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [isMac, refresh]);
  async function perform(action: () => Promise<unknown>, message = '') {
    if (changing.current) return;
    changing.current = true;
    epoch.current++;
    setBusy(true);
    setError('');
    setNotice('');
    setCode('');
    setRevealed(false);
    showCode.current = false;
    try {
      await action();
      if (mounted.current && message) setNotice(message);
    } catch (e) {
      if (mounted.current && !recordingActionCancelled(e))
        setError(redactSecrets((e as Error).message));
    } finally {
      changing.current = false;
      if (mounted.current) {
        setBusy(false);
        void refresh(clientsLoaded);
      }
    }
  }
  const background = status?.mode === 'background';
  const ready = status?.state === 'ready';
  return (
    <Modal
      title="Share this Mac"
      subtitle="Manage the host on this Mac. Remote display connections are separate."
      onClose={onClose}
    >
      {!isMac ? (
        <div className="info-box">
          <ShieldCheck size={20} />
          <p>
            Hosting requires a Mac with Xcode and idb_companion. Open Sim Relay on the Mac and
            choose “Share this Mac.” Run <code>sim-relay-host status</code> or{' '}
            <code>sim-relay-host pairing</code> there to retrieve its current details.
          </p>
        </div>
      ) : !management ? (
        <p className="inline-error">Update the desktop app to manage the persistent host.</p>
      ) : (
        <div className="host-management">
          <div className="host-service-heading">
            <div>
              <strong role="status">
                {busy
                  ? status?.state === 'starting'
                    ? 'Starting background host…'
                    : 'Applying host changes…'
                  : status
                    ? stateLabel[status.state]
                    : error
                      ? 'Status unavailable'
                      : 'Checking host…'}
              </strong>
              <small>
                {!status
                  ? 'Checking the local service'
                  : status?.mode === 'foreground'
                    ? 'Foreground sharing in Terminal'
                    : background
                      ? 'Persistent background service'
                      : 'Persistent background service is stopped'}
              </small>
            </div>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => {
                setError('');
                void refresh(clientsLoaded);
              }}
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
          {status && (
            <p className="field-hint">
              Observed{' '}
              <time dateTime={status.observedAt}>
                {new Date(status.observedAt).toLocaleTimeString()}
              </time>
              . Refreshes every 3 seconds.
            </p>
          )}
          {status?.message && <p className="inline-error">{status.message}</p>}
          {status?.mode === 'foreground' && (
            <p className="modal-note">
              This host runs in Terminal. Press Ctrl+C there before starting a background service.
              Closing this app leaves that host unchanged.
            </p>
          )}
          <div className="host-service-actions">
            <button
              className="button primary"
              disabled={busy || !status || ready || status.registered}
              onClick={() =>
                void perform(async () => {
                  setStatus((s) => (s ? { ...s, state: 'starting' } : s));
                  await management.action('start');
                }, 'Background host started. You can close this app.')
              }
            >
              Start background host
            </button>
            <button
              className="button secondary"
              disabled={busy || !background}
              onClick={() =>
                void perform(
                  () => management.action('restart'),
                  'Background host restarted. Saved settings and authorizations retained.',
                )
              }
            >
              Restart
            </button>
            <button
              className="button danger"
              disabled={busy || !background}
              onClick={() =>
                void perform(
                  () => management.action('stop'),
                  'Background host stopped. Start at login is disabled.',
                )
              }
            >
              Stop host
            </button>
          </div>
          <p className="field-hint">
            The background host stays running when this app closes. Stop host also disables starting
            at login.
          </p>
          {status && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={status.settings.startAtLogin}
                  disabled={busy}
                  onChange={(e) =>
                    void perform(
                      () => management.setLogin(e.target.checked),
                      'Login preference saved. Current sharing is unchanged.',
                    )
                  }
                />
                Start background host when I log in
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={status.keepAwake?.enabled ?? false}
                  disabled={busy || (!!status.registered && !ready)}
                  onChange={(e) =>
                    void perform(
                      () => management.keepAwake(e.target.checked),
                      'Idle-sleep preference saved.',
                    )
                  }
                />
                Prevent idle system sleep during active sessions
              </label>
              <p className="field-hint">
                Uses more power while sessions are active. The display can sleep. Explicit sleep and
                lid behavior still follow macOS settings.
              </p>
              <p className="host-power-status">
                Idle-sleep assertion:{' '}
                <strong>
                  {status.keepAwake?.active
                    ? 'active'
                    : status.keepAwake?.enabled
                      ? 'waiting for an active session'
                      : 'off'}
                </strong>
                {status.keepAwake?.activeSessions !== undefined
                  ? ` · ${status.keepAwake.activeSessions} active ${status.keepAwake.activeSessions === 1 ? 'session' : 'sessions'}`
                  : ''}
              </p>
              {status.keepAwake?.error && <p className="inline-error">{status.keepAwake.error}</p>}
              {status.keepAwake?.warning && (
                <p className="inline-error">{status.keepAwake.warning}</p>
              )}
            </>
          )}
          {ready && (
            <section className="host-management-section" aria-labelledby="host-pairing-title">
              <h3 id="host-pairing-title">Connect another computer</h3>
              <p className="modal-note">
                Pairing gives a client access according to its permissions. Review access below
                after pairing.
              </p>
              <label className="field">
                Host addresses
                <textarea
                  readOnly
                  rows={Math.min(3, Math.max(1, status.host?.addresses?.length ?? 1))}
                  value={
                    status.host?.addresses?.join('\n') || status.host?.url || 'No address available'
                  }
                />
              </label>
              <p className="field-hint">
                Host version {status.host?.info?.version ?? 'unknown'} · Xcode{' '}
                {status.host?.info?.xcode ? 'ready' : 'not found'} · Input service{' '}
                {status.host?.info?.companion ? 'ready' : 'not found'}
              </p>
              <label className="field">
                Current pairing code
                <input
                  readOnly
                  type={revealed ? 'text' : 'password'}
                  value={code}
                  placeholder="Hidden until revealed"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="host-service-actions">
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      if (revealed) {
                        setCode('');
                        setRevealed(false);
                        showCode.current = false;
                      } else {
                        const current = await management.pairing();
                        if (mounted.current) {
                          setCode(current.token);
                          setRevealed(true);
                          showCode.current = true;
                        }
                      }
                    })
                  }
                >
                  {revealed ? <EyeOff size={14} /> : <Eye size={14} />}{' '}
                  {revealed ? 'Hide code' : 'Reveal current code'}
                </button>
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      () => management.copyPairing(),
                      'Current pairing code copied. Share it only with the next client you trust.',
                    )
                  }
                >
                  <Copy size={14} />
                  Copy current code
                </button>
              </div>
              <p className="field-hint">
                The code changes after each successful pairing. Reveal and copy always retrieve the
                current code from this host.
              </p>
              <div className="fingerprint">
                <span>Compare this SHA-256 fingerprint on the client</span>
                <code>{status.host?.fingerprint ?? 'Unavailable'}</code>
              </div>
            </section>
          )}
          <details className="host-management-section">
            <summary>Service settings</summary>
            <p className="field-hint">
              GUI and CLI use these same settings and authorization state. Stop the host before
              changing them.
            </p>
            {draft && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(async () => {
                    const observed = await management.saveSettings({
                      ...draft,
                      startAtLogin: status?.settings.startAtLogin ?? false,
                    });
                    if (mounted.current) {
                      setStatus(observed);
                      setDraft(observed.settings);
                    }
                  }, 'Service settings saved.');
                }}
              >
                <fieldset
                  disabled={busy || ready || !!status?.registered}
                  className="host-settings-fields"
                >
                  <label className="field">
                    State directory
                    <input
                      required
                      value={draft.directory}
                      onChange={(e) => setDraft({ ...draft, directory: e.target.value })}
                      spellCheck={false}
                    />
                  </label>
                  <div className="field-row">
                    <label className="field">
                      Bind address
                      <input
                        required
                        value={draft.bind}
                        onChange={(e) => setDraft({ ...draft, bind: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      Port
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        required
                        value={draft.port}
                        onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <label className="field">
                    idb_companion path <span>optional</span>
                    <input
                      value={draft.companionPath}
                      onChange={(e) => setDraft({ ...draft, companionPath: e.target.value })}
                      placeholder="Use the installed companion"
                      spellCheck={false}
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={draft.hostAudio}
                      onChange={(e) => setDraft({ ...draft, hostAudio: e.target.checked })}
                    />
                    Allow sharing all Mac playback audio
                  </label>
                  <p className="field-hint">
                    Audio includes every app on this Mac. Each client still needs audio permission
                    and must explicitly start audio sharing.
                  </p>
                  <label className="field">
                    Audio helper path <span>optional</span>
                    <input
                      value={draft.audioHelper}
                      onChange={(e) => setDraft({ ...draft, audioHelper: e.target.value })}
                      spellCheck={false}
                    />
                  </label>
                  <button className="button secondary small" type="submit">
                    Save service settings
                  </button>
                </fieldset>
              </form>
            )}
            <p className="field-hint">
              On this Mac: <code>sim-relay-host status</code>, <code>sim-relay-host settings</code>,{' '}
              <code>sim-relay-host pairing</code>. A different SIM_RELAY_STATE_DIR is rejected when
              it does not match this saved service.
            </p>
          </details>
          {ready && (
            <section className="host-management-section" aria-labelledby="host-clients-title">
              <div className="host-service-heading">
                <h3 id="host-clients-title">Authorized clients</h3>
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => void refresh(true)}
                >
                  Refresh clients
                </button>
              </div>
              <p className="field-hint">
                Managed locally on this Mac. Revoking access disconnects the client’s active
                displays and requires it to pair again.
              </p>
              {!clientsLoaded ? (
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => void refresh(true)}
                >
                  Show authorized clients
                </button>
              ) : !clients.length ? (
                <p className="modal-note">
                  No authorized clients. Pair another computer using the current code.
                </p>
              ) : (
                <ul className="host-client-list">
                  {clients.map((client) => (
                    <li key={client.id}>
                      <strong>{client.name}</strong>
                      <small>
                        {client.permissions?.role ?? 'Permissions unavailable'} ·{' '}
                        {client.activeSessions} active{' '}
                        {client.activeSessions === 1 ? 'display' : 'displays'}
                      </small>
                      <small>
                        Paired {new Date(client.createdAt).toLocaleString()}. Last seen{' '}
                        {client.lastSeenAt
                          ? new Date(client.lastSeenAt).toLocaleString()
                          : 'not connected this run'}
                        .
                      </small>
                      <code>{client.id}</code>
                      {editing?.id === client.id ? (
                        <ClientAccess
                          client={editing}
                          api={management}
                          disabled={busy}
                          onClose={() => setEditing(undefined)}
                          onSave={(permissions) =>
                            void perform(async () => {
                              await management.permissions(
                                client.id,
                                editing.permissionRevision,
                                permissions,
                              );
                              if (mounted.current) setEditing(undefined);
                            }, 'Client permissions saved. Its displays disconnected; reconnect to apply access.')
                          }
                        />
                      ) : (
                        <div className="host-service-actions">
                          {client.permissions && (
                            <button
                              className="button secondary small"
                              disabled={busy}
                              onClick={() => {
                                setEditing(client);
                                setRevoke(undefined);
                              }}
                            >
                              Edit access
                            </button>
                          )}
                          {revoke === client.id ? (
                            <>
                              <button
                                className="button danger small"
                                disabled={busy}
                                onClick={() =>
                                  void perform(async () => {
                                    await management.revoke(client.id);
                                    if (mounted.current) setRevoke(undefined);
                                  }, 'Client access revoked. Its active displays disconnected. Re-pairing is required.')
                                }
                              >
                                Revoke and disconnect
                              </button>
                              <button
                                className="button secondary small"
                                disabled={busy}
                                onClick={() => setRevoke(undefined)}
                              >
                                Keep access
                              </button>
                            </>
                          ) : (
                            <button
                              className="button secondary small"
                              disabled={busy}
                              onClick={() => setRevoke(client.id)}
                            >
                              Revoke access…
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="host-management-notice" role="status">
              <Check size={14} />
              {notice}
            </p>
          )}
          {busy && <Busy text="Applying changes…" />}
        </div>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

function ClientAccess({
  client,
  disabled,
  onClose,
  onSave,
}: {
  client: HostAuthorizedClient;
  api: HostManagementApi;
  disabled: boolean;
  onClose(): void;
  onSave(permissions: HostClientPermissions): void;
}) {
  const [permissions, setPermissions] = useState(client.permissions);
  const [devices, setDevices] = useState(
    client.permissions.devices === 'all' ? '' : client.permissions.devices.join('\n'),
  );
  const flags: [keyof Omit<HostClientPermissions, 'role' | 'devices'>, string][] = [
    ['installation', 'Install apps'],
    ['destructive', 'Change or delete simulator data'],
    ['rawSimctl', 'Run raw simctl commands'],
    ['screenshots', 'Capture screenshots'],
    ['recordings', 'Record simulator video'],
    ['hostAudio', 'Receive all Mac playback audio'],
  ];
  return (
    <form
      className="host-client-access"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...permissions,
          devices: permissions.devices === 'all' ? 'all' : devices.split(/[\s,]+/).filter(Boolean),
        });
      }}
    >
      <label className="field">
        Role
        <select
          disabled={disabled}
          value={permissions.role}
          onChange={(e) =>
            setPermissions({
              ...permissions,
              role: e.target.value as HostClientPermissions['role'],
            })
          }
        >
          <option value="viewer">Viewer</option>
          <option value="controller">Controller</option>
        </select>
      </label>
      <p className="field-hint">
        Viewers can watch permitted simulators. Controllers can send input and perform enabled
        actions. Each simulator allows one active display at a time.
      </p>
      <label className="checkbox">
        <input
          disabled={disabled}
          type="checkbox"
          checked={permissions.devices === 'all'}
          onChange={(e) =>
            setPermissions({ ...permissions, devices: e.target.checked ? 'all' : [] })
          }
        />
        Allow all simulators, including new ones
      </label>
      {permissions.devices !== 'all' && (
        <label className="field">
          Allowed simulator IDs
          <textarea
            rows={3}
            disabled={disabled}
            value={devices}
            onChange={(e) => setDevices(e.target.value)}
            placeholder="One simulator UUID per line. Leave empty to allow none."
            spellCheck={false}
          />
        </label>
      )}
      <div className="host-client-flags">
        {flags.map(([key, label]) => (
          <label key={key} className="checkbox">
            <input
              type="checkbox"
              disabled={disabled}
              checked={permissions[key]}
              onChange={(e) => setPermissions({ ...permissions, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      <p className="field-hint">
        Role and device limits still apply to each enabled action. Saving disconnects this client’s
        active displays. A changed revision is rejected; refresh and reopen Edit access before
        retrying.
      </p>
      <div className="host-service-actions">
        <button type="submit" className="button primary small" disabled={disabled}>
          Save access and disconnect
        </button>
        <button
          type="button"
          className="button secondary small"
          disabled={disabled}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
