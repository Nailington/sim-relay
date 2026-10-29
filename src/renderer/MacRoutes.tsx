import { useState } from 'react';
import type { DesktopApi, HostEntry } from '../shared/types';
import { macAddresses, MAX_MAC_ADDRESSES } from '../shared/mac-routes';
import { redactSecrets } from '../shared/diagnostics';
import { recordingActionCancelled } from '../shared/recording-protection';
import { Busy, Modal } from './components';
import './mac-routes.css';

/** Address management stays separate from simulator selection and pairing. */
export function MacRoutes({
  api,
  host,
  onChanged,
  onClose,
}: {
  api: DesktopApi;
  host: HostEntry;
  onChanged(host: HostEntry): void;
  onClose(): void;
}) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const addresses = macAddresses(host);
  const edit = async (action: 'add' | 'remove' | 'prefer', url: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const update =
        action === 'add'
          ? api.addAddress
          : action === 'remove'
            ? api.removeAddress
            : api.preferAddress;
      if (!update) throw new Error('Update Sim Relay to manage Mac addresses.');
      onChanged(await update(host.id, url));
      if (action === 'add') setAddress('');
      setMessage(
        action === 'add'
          ? 'Address verified and saved.'
          : action === 'remove'
            ? 'Address removed.'
            : 'Preferred address saved. Reconnect to use it.',
      );
    } catch (failure) {
      if (!recordingActionCancelled(failure))
        setError(redactSecrets((failure as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Mac addresses" subtitle={host.name} onClose={onClose}>
      <p className="modal-note">
        Add LAN, Tailscale, or tunnel addresses for this Mac. Each address must present its paired
        certificate before it can be saved.
      </p>
      <fieldset className="mac-routes" disabled={busy}>
        <legend>Preferred address</legend>
        {addresses.map((url) => (
          <div className="mac-route" key={url}>
            <label>
              <input
                type="radio"
                name="preferred-mac-address"
                checked={host.url === url}
                onChange={() => void edit('prefer', url)}
              />
              <span>
                <span className="mac-route-url">{url}</span>
                {host.currentRoute === url && (
                  <small>Currently in use{url !== host.url ? ' (fallback)' : ''}</small>
                )}
              </span>
            </label>
            <button
              className="button quiet"
              disabled={addresses.length === 1}
              aria-label={`Remove ${url}`}
              onClick={() => void edit('remove', url)}
            >
              Remove
            </button>
          </div>
        ))}
      </fieldset>
      <p className="field-hint">
        If an address is unreachable, Sim Relay tries the other saved addresses. Changing the
        preferred address or removing the active address disconnects the display.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void edit('add', address);
        }}
      >
        <label className="field">
          New HTTPS address
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://studio-mac.local:49300"
            maxLength={2048}
            required
            spellCheck={false}
            disabled={busy || addresses.length >= MAX_MAC_ADDRESSES}
          />
        </label>
        <p className="field-hint">
          Save up to {MAX_MAC_ADDRESSES} addresses. In a browser, the hosting service owner must
          allow each address first. To replace an address, verify its replacement, then remove the
          old address.
        </p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Close
          </button>
          <button
            className="button primary"
            disabled={busy || !address.trim() || addresses.length >= MAX_MAC_ADDRESSES}
          >
            {busy ? <Busy text="Verifying address…" /> : 'Verify and add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
