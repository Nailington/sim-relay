import { recordingActionCancelled } from '../shared/recording-protection';
import { useEffect, useRef, useState } from 'react';
import { App } from './App';
import { DisplayWindow } from './DisplayWindow';
import {
  createBrowserApi,
  disposeBrowserApi,
  resetBrowserApi,
  signOutBrowserApi,
  webCall,
} from './browser-api';
import {
  announceBrowserAccount,
  browserAccountSnapshot,
  browserAccountUser,
  watchBrowserAccount,
} from './browser-account';
import type { DesktopApi } from '../shared/types';
import './browser.css';

export function BrowserGate() {
  const [mode, setMode] = useState<'loading' | 'demo' | 'login' | 'workspace'>('loading');
  const [user, setUser] = useState(''),
    [password, setPassword] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmReset, setConfirmReset] = useState(false);
  const relay = useRef<DesktopApi | undefined>(undefined);
  const generation = useRef(0);
  const announcing = useRef(false);
  const [workspaceKey, setWorkspaceKey] = useState('');
  const closeWorkspace = () => {
    const old = relay.current;
    disposeBrowserApi(old);
    if (window.relay === old) window.relay = undefined;
    relay.current = undefined;
  };
  const announce = (name?: string) => {
    announcing.current = true;
    try {
      announceBrowserAccount(name);
    } finally {
      announcing.current = false;
    }
  };
  const open = (name: string, renew = false) => {
    closeWorkspace();
    if (renew || browserAccountUser() !== name) announce(name);
    const api = createBrowserApi(name, () => {
      if (relay.current !== api) return;
      generation.current++;
      closeWorkspace();
      setConfirmReset(false);
      setMode('login');
      setError('Your sign-in changed. Sign in again to continue.');
    });
    relay.current = api;
    window.relay = api;
    setUser(name);
    setWorkspaceKey(crypto.randomUUID());
    setConfirmReset(false);
    setError('');
    setMode('workspace');
  };
  useEffect(() => {
    let active = true;
    const lifetime = new AbortController();
    let seen = browserAccountSnapshot();
    const refresh = () => {
      const attempt = ++generation.current;
      closeWorkspace();
      setMode('loading');
      const snapshot = browserAccountSnapshot();
      void fetch('/api/session', { credentials: 'same-origin', signal: lifetime.signal })
        .then((response) => response.json())
        .then((value) => {
          if (!active || attempt !== generation.current) return;
          if (snapshot !== browserAccountSnapshot()) {
            refresh();
            return;
          }
          if (value.mode !== 'web') setMode('demo');
          else if (value.user) open(value.user);
          else setMode('login');
        })
        .catch(() => {
          if (active && attempt === generation.current) {
            setMode(import.meta.env.DEV ? 'demo' : 'login');
            setError('Cannot reach the hosting service. Check your connection and sign in again.');
          }
        });
    };
    watchBrowserAccount((snapshot) => {
      if (snapshot === seen) return;
      seen = snapshot;
      if (announcing.current) return;
      generation.current++;
      closeWorkspace();
      setConfirmReset(false);
      setPassword('');
      if (browserAccountUser(snapshot)) refresh();
      else {
        setMode('login');
        setError('');
      }
    }, lifetime.signal);
    refresh();
    return () => {
      active = false;
      generation.current++;
      lifetime.abort();
      closeWorkspace();
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
            if (busy) return;
            setBusy(true);
            setError('');
            const attempt = ++generation.current;
            closeWorkspace();
            announce();
            void webCall<{ user: string }>('login', { user, password })
              .then((value) => {
                if (attempt !== generation.current) return;
                setPassword('');
                open(value.user, true);
              })
              .catch((failure: Error) => {
                if (attempt === generation.current) setError(failure.message);
              })
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
            const api = relay.current;
            if (!api) return;
            setBusy(true);
            setError('');
            void signOutBrowserApi(api)
              .then(() => {
                if (!relay.current) setMode('login');
              })
              .catch((failure: Error) => {
                if (!recordingActionCancelled(failure) && (!relay.current || relay.current === api))
                  setError(failure.message);
              })
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
              const api = relay.current;
              if (!api) return;
              void resetBrowserApi(api)
                .then(() => location.reload())
                .catch((failure: Error) => {
                  if (!recordingActionCancelled(failure))
                    setError(
                      'Browser storage could not be cleared. Clear this site’s data in your browser settings.',
                    );
                });
            }}
          >
            Clear this browser’s setup
          </button>
          <button onClick={() => setConfirmReset(false)}>Keep setup</button>
        </div>
      )}
      <div className="browser-app">
        {new URLSearchParams(location.search).has('display') ? (
          <DisplayWindow key={workspaceKey} />
        ) : (
          <App key={workspaceKey} />
        )}
      </div>
    </div>
  );
}
