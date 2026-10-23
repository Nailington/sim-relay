import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BrowserGate } from './BrowserGate';
import './style.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{window.relay ? <App /> : <BrowserGate />}</React.StrictMode>,
);
