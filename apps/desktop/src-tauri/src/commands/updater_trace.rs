// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Bridge: JS updater steps → Rust log:: → telemetry → D1.
/// Called via invoke('log_updater_event', { level, message }).
#[tauri::command]
pub fn log_updater_event(level: String, message: String) {
    match level.as_str() {
        "warn" => log::warn!("updater: {}", message),
        "error" => log::error!("updater: {}", message),
        _ => log::info!("updater: {}", message),
    }
}
