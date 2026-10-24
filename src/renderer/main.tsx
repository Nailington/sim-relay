import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BrowserGate } from './BrowserGate';
import { DisplayWindow } from './DisplayWindow';
import './style.css';
import './display.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.relay ? (
      new URLSearchParams(location.search).has('display') ? <DisplayWindow /> : <App />
    ) : <BrowserGate />}
  </React.StrictMode>,
);
