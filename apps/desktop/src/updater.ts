/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Silent auto-update on launch.
//
// Polls the Tauri-updater endpoint configured in tauri.conf.json. When a
// newer version is available, downloads + installs in the background and
// relaunches the app. No UI prompt — the user gets the new version on
// next launch. Failures are logged but don't block startup.

import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export async function checkForUpdatesOnStartup(): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      console.log('[updater] up to date');
      return;
    }
    console.log(`[updater] new version available: ${update.version} (${update.date})`);
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          console.log(`[updater] download started, ${event.data.contentLength ?? '?'} bytes`);
          break;
        case 'Progress':
          // Silent — could surface as a toast if you want UI feedback.
          break;
        case 'Finished':
          console.log('[updater] download complete, relaunching');
          break;
      }
    });
    await relaunch();
  } catch (err) {
    // Network failures, signature mismatches, missing endpoint — all log
    // and continue rather than block app startup.
    console.warn('[updater] check failed (non-fatal):', err);
  }
}
