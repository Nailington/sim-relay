import { useEffect, useState } from 'react';
import { App } from './App';
import { clearBrowserWorkspace, createBrowserApi, webCall } from './browser-api';
import './browser.css';

export function BrowserGate() {
  const [mode, setMode] = useState<'loading' | 'demo' | 'login' | 'workspace'>('loading');
  const [user, setUser] = useState(''),
    [password, setPassword] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmReset, setConfirmReset] = useState(false);
  const open = (name: string) => {
    window.relay = createBrowserApi(name);
    setUser(name);
    setMode('workspace');
  };
  useEffect(() => {
    let active = true;
    void fetch('/api/session', { credentials: 'same-origin' })
      .then((response) => response.json())
      .then((value) => {
        if (!active) return;
        if (value.mode !== 'web') setMode('demo');
        else if (value.user) open(value.user);
        else setMode('login');
      })
      .catch(() => {
        if (active) setMode('demo');
      });
    return () => {
      active = false;
    };
  }, []);
  if (mode === 'loading')
    return (
      <main className="browser-sign-in">
        <p role="status">Opening Sim Relay…</p>
      </main>
    );
  if (mode === 'demo') return <App />;
  if (mode === 'login')
    return (
      <main className="browser-sign-in">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            void webCall<{ user: string }>('login', { user, password })
              .then((value) => {
                setPassword('');
                open(value.user);
              })
              .catch((failure: Error) => setError(failure.message))
              .finally(() => setBusy(false));
          }}
        >
          <h1>Sim Relay</h1>
          <p>Sign in to connect to your Macs from this browser.</p>
          <label>
            Username
            <input
              autoComplete="username"
              value={user}
              onChange={(event) => setUser(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="browser-storage-note">
            Saved Macs and their access credentials stay in this browser profile. Use a private
            profile on a shared device.
          </p>
        </form>
      </main>
    );
  return (
    <div className="browser-workspace">
      <header className="browser-account">
        <span>Browser workspace · {user}</span>
        <button onClick={() => setConfirmReset(!confirmReset)}>Clear saved setup</button>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError('');
            void window.relay
              ?.disconnect()
              .then(() => webCall('logout'))
              .then(() => {
                window.relay = undefined;
                setMode('login');
              })
              .catch((failure: Error) => setError(failure.message))
              .finally(() => setBusy(false));
          }}
        >
          Sign out
        </button>
      </header>
      {error && (
        <p className="browser-account-error" role="alert">
          {error}
        </p>
      )}
      {confirmReset && (
        <div className="browser-reset" role="alert">
          <p>
            Remove saved Macs, pairing credentials, and preferences from this browser for {user}?
            Other browsers keep their setups. The Mac can revoke this browser’s access separately.
          </p>
          <button
            onClick={() => {
              void window.relay
                ?.disconnect()
                .then(() => clearBrowserWorkspace(user))
                .then(() => location.reload())
                .catch(() =>
                  setError(
                    'Browser storage could not be cleared. Clear this site’s data in your browser settings.',
                  ),
                );
            }}
          >
            Clear this browser’s setup
          </button>
          <button onClick={() => setConfirmReset(false)}>Keep setup</button>
        </div>
      )}
      <div className="browser-app">
        <App />
      </div>
    </div>
  );
}
