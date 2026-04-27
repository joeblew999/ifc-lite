/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Application entry point
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import 'maplibre-gl/dist/maplibre-gl.css';

// In Tauri only — bridge unhandled JS errors into the Rust log pipeline → D1.
// Guard ensures this is a no-op when the viewer runs as a plain web app.
if (typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined') {
  import('@tauri-apps/api/core').then(({ invoke }) => {
    window.addEventListener('unhandledrejection', (e) => {
      invoke('log_updater_event', { level: 'error', message: `unhandled-rejection: ${String(e.reason)}` }).catch(() => {});
    });
    window.onerror = (_msg, src, line, _col, err) => {
      invoke('log_updater_event', { level: 'error', message: `js-error: ${err?.message ?? String(_msg)} at ${src}:${line}` }).catch(() => {});
    };
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
