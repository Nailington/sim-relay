import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from './components';
import type { DesktopApi, HostEntry, HostInfo } from '../shared/types';
import {
  releasesUrl,
  upgradeGuidance,
  type InstallationMethod,
  type UpdateChannel,
  type UpdateResult,
} from '../shared/updates';
import metadata from '../../package.json';

interface Preferences {
  automatic: boolean;
  channel: UpdateChannel;
  installation: InstallationMethod;
}
function preferences(key: string): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      automatic: value.automatic === true,
      channel: value.channel === 'preview' ? 'preview' : 'stable',
      installation: ['homebrew', 'nix', 'installer', 'other'].includes(value.installation)
        ? value.installation
        : 'other',
    };
  } catch {
    return { automatic: false, channel: 'stable', installation: 'other' };
  }
}
export function useUpdates(api?: DesktopApi) {
  const key = api?.updatePreferencesKey ?? 'sim-relay.updates.v1';
  const [settings, setSettings] = useState(() => preferences(key));
  const [result, setResult] = useState<UpdateResult>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  const check = useCallback(async () => {
    if (!api?.checkUpdates) return;
    const current = ++sequence.current;
    setChecking(true);
    setError('');
    try {
      const next = await api.checkUpdates(settings.channel);
      if (!mounted.current || current !== sequence.current) return;
      setResult(next);
      try {
        localStorage.setItem(
          key + '.last',
          JSON.stringify({ channel: settings.channel, checkedAt: next.checkedAt }),
        );
      } catch {
        setError('Update preferences could not be saved. Allow local storage for this app.');
      }
    } catch {
      if (mounted.current && current === sequence.current)
        setError('Could not check for updates. Check your connection and try again.');
    } finally {
      if (mounted.current && current === sequence.current) setChecking(false);
    }
  }, [api, key, settings.channel]);
  useEffect(() => {
    if (!settings.automatic || !api?.checkUpdates) return;
    const automatic = () => {
      let last: { channel?: string; checkedAt?: string } = {};
      try {
        const value: unknown = JSON.parse(localStorage.getItem(key + '.last') ?? '{}');
        if (value && typeof value === 'object') last = value;
      } catch {
        /* Check once if corrupt. */
      }
      const elapsed = Date.now() - Date.parse(last.checkedAt ?? '');
      if (
        last.channel !== settings.channel ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed >= 24 * 60 * 60 * 1000
      )
        void check();
    };
    automatic();
    const timer = setInterval(automatic, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [api, check, key, settings.automatic, settings.channel]);
  const configure = (next: Preferences) => {
    if (next.channel !== settings.channel) {
      sequence.current++;
      setChecking(false);
      setResult(undefined);
    }
    setSettings(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setError('');
    } catch {
      setError(
        'These preferences apply only until this window closes. Local storage is unavailable.',
      );
    }
  };
  return { settings, configure, result, checking, error, check };
}

export function UpdatesModal({
  api,
  host,
  updates,
  onClose,
}: {
  api?: DesktopApi;
  host?: HostEntry;
  updates: ReturnType<typeof useUpdates>;
  onClose(): void;
}) {
  const [hostInfo, setHostInfo] = useState<HostInfo>();
  const [hostError, setHostError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setHostInfo(undefined);
    setHostError('');
    if (api && host?.source === 'saved')
      void api
        .request<HostInfo>(host.id, 'GET', '/info')
        .then((info) => {
          if (!cancelled) setHostInfo(info);
        })
        .catch(() => {
          if (!cancelled)
            setHostError(
              'The paired Mac version could not be checked. Keep it sharing, then reopen Updates.',
            );
        });
    return () => {
      cancelled = true;
    };
  }, [api, host?.id, host?.source]);
  const { settings, configure, result, checking, error } = updates;
  const browser = api?.platform === 'web' || api?.platform === 'browser';
  const message =
    result?.state === 'available'
      ? 'A newer version is available.'
      : result?.state === 'current'
        ? 'No newer version is available on this channel.'
        : result?.state === 'incompatible'
          ? 'A newer release exists, but it has no installer for this OS and architecture. Review its release notes.'
          : result?.message;
  return (
    <Modal title="Updates" subtitle="Check releases and choose how to upgrade." onClose={onClose}>
      <p>
        {browser ? 'Loaded browser workspace' : 'Desktop client'}:{' '}
        <strong>{metadata.version}</strong>
      </p>
      {result && (
        <p>
          {browser ? 'Hosting service' : 'Installed client'}: {result.currentVersion}
          <br />
          {result.latestVersion && (
            <>
              Latest {result.channel === 'stable' ? 'stable' : 'including previews'}:{' '}
              <strong>{result.latestVersion}</strong>
              <br />
            </>
          )}
          Checked {new Date(result.checkedAt).toLocaleString()}
        </p>
      )}
      {message && (
        <p className={result?.state === 'unavailable' ? 'inline-error' : 'info-box'} role="status">
          {message}
        </p>
      )}
      <label className="field">
        Release channel
        <select
          value={settings.channel}
          onChange={(event) =>
            configure({ ...settings, channel: event.target.value as UpdateChannel })
          }
        >
          <option value="stable">Stable releases</option>
          <option value="preview">Stable and prerelease versions</option>
        </select>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.automatic}
          disabled={!api?.checkUpdates}
          onChange={(event) => configure({ ...settings, automatic: event.target.checked })}
        />
        Check automatically once a day
      </label>
      <p className="field-hint">
        Off by default. Checks contact GitHub for public release information. Pairing details and
        Mac addresses are not sent. Updates are installed through your existing installation method.
      </p>
      <label className="field">
        {browser ? 'Hosting service installation' : 'Installation method'}
        <select
          value={settings.installation}
          onChange={(event) =>
            configure({ ...settings, installation: event.target.value as InstallationMethod })
          }
        >
          <option value="other">Other or not sure</option>
          <option value="homebrew">Homebrew on the Mac</option>
          <option value="nix">Nix</option>
          <option value="installer">Official installer</option>
        </select>
      </label>
      {result?.installation === 'nix' && settings.installation !== 'nix' && (
        <p className="info-box">
          This executable is in the Nix store. Use your Nix deployment to update it.
        </p>
      )}
      <p className="field-hint">
        {upgradeGuidance(result?.installation === 'nix' ? 'nix' : settings.installation, browser)}
      </p>
      {host?.source === 'saved' && (
        <section className="info-box update-host-info">
          <strong>Paired Mac: {host.name}</strong>
          {hostInfo ? (
            <p>
              Host {hostInfo.version}, protocol {hostInfo.protocolVersion ?? 1}. The client supports
              protocols 1 and 2.{' '}
              {hostInfo.clientAuthorization
                ? 'Each device pairs separately with the current single-use code.'
                : 'This older host uses one shared code; updating the host requires each device to pair again.'}
            </p>
          ) : (
            <p>{hostError || 'Checking host version…'}</p>
          )}
          <p>
            Update clients first, save recordings, then upgrade and restart the Mac host. Keep its
            state directory and certificate. Pair again when requested using the current code from
            Share this Mac or <code>sim-relay-host pairing</code>.
          </p>
        </section>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!api?.checkUpdates && (
        <p className="field-hint">
          Install the updated desktop app or browser service to check from this window.
        </p>
      )}
      <div className="modal-actions">
        <button
          className="button secondary"
          onClick={() => void api?.openUpdateLink?.(result?.notesUrl ?? releasesUrl)}
          disabled={!api?.openUpdateLink}
        >
          Official release notes
        </button>
        <button
          className="button primary"
          disabled={!api?.checkUpdates || checking}
          onClick={() => void updates.check()}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
    </Modal>
  );
}
