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
import { invoke } from '@tauri-apps/api/core';

async function trace(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
  console.log(`[updater/${level}] ${message}`);
  try {
    await invoke('log_updater_event', { level, message });
  } catch {
    // If the IPC itself fails, we still have console output above.
  }
}

export async function checkForUpdatesOnStartup(): Promise<void> {
  await trace('info', 'checkForUpdatesOnStartup: entered');
  try {
    await trace('info', 'check(): calling tauri-plugin-updater check()');
    const update = await check();
    await trace('info', `check(): returned, update=${update ? JSON.stringify({ version: update.version, date: update.date }) : 'null'}`);

    if (!update) {
      await trace('info', 'up to date — no update available');
      return;
    }

    await trace('info', `new version available: ${update.version} (${update.date})`);
    await trace('info', 'downloadAndInstall(): starting');

    await update.downloadAndInstall(async (event) => {
      switch (event.event) {
        case 'Started':
          await trace('info', `download started, contentLength=${event.data.contentLength ?? '?'}`);
          break;
        case 'Progress':
          // High-frequency — skip tracing to avoid flooding D1.
          break;
        case 'Finished':
          await trace('info', 'download finished');
          break;
      }
    });

    await trace('info', 'downloadAndInstall(): complete, calling relaunch()');
    await relaunch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await trace('error', `updater threw: ${msg}`);
  }
}
