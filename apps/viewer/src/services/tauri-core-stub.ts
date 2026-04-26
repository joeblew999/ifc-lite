/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Build-time stub for @tauri-apps/api/core. Both the web viewer and the
// desktop frontend alias their import of @tauri-apps/api/core to this file
// so vite/rollup can bundle without resolving the real Tauri APIs.
//
// At runtime:
//  - Web build:    these throw / are no-ops (Tauri isn't available).
//  - Desktop build: the real Tauri runtime injects globals; the desktop
//                   wrapper code branches around the stub before calling.
//
// Add new exports here whenever a Tauri plugin imports a new symbol from
// @tauri-apps/api/core (e.g. plugin-updater needs Resource + Channel).

export async function invoke(): Promise<never> {
  throw new Error('Tauri core API is unavailable in the browser build');
}

// Used by plugin-updater (and most plugins that own native handles).
export class Resource {
  rid = 0;
  close(): void {}
}

// Used by plugin-updater for download progress streaming.
export class Channel<T = unknown> {
  id = 0;
  set onmessage(_handler: ((message: T) => void) | undefined) {
    // no-op in stub
  }
}
