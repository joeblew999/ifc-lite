// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

mod commands;
mod telemetry;

use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// Reads a stable device ID from disk, creating it on first run.
/// Lives at the OS-appropriate app-support directory so it survives
/// app updates but is per-machine (not per-user-account).
fn ifc_lite_data_dir() -> Option<std::path::PathBuf> {
    let base = if cfg!(target_os = "macos") {
        std::env::var("HOME").ok().map(|h| format!("{}/Library/Application Support/ifc-lite", h))
    } else if cfg!(target_os = "windows") {
        std::env::var("APPDATA").ok().map(|a| format!("{}/ifc-lite", a))
    } else {
        std::env::var("HOME").ok().map(|h| format!("{}/.local/share/ifc-lite", h))
    };
    base.map(std::path::PathBuf::from)
}

fn telemetry_queue_path() -> std::path::PathBuf {
    ifc_lite_data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("ifc-lite"))
        .join("telemetry-queue.jsonl")
}

fn get_or_create_device_id() -> String {
    let Some(dir) = ifc_lite_data_dir() else {
        return uuid::Uuid::new_v4().to_string();
    };

    let path = dir.join("device-id");

    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&path, &id);
    id
}


async fn rust_updater_check<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    log::info!("updater: check started");

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::error!("updater: build error: {}", e);
            return;
        }
    };

    log::info!("updater: calling check()");
    match updater.check().await {
        Err(e) => {
            log::error!("updater: check error: {}", e);
        }
        Ok(None) => {
            log::info!("updater: up to date");
        }
        Ok(Some(update)) => {
            let date = update.date.map(|d| d.to_string()).unwrap_or_else(|| "unknown".into());
            log::info!("updater: available version={} date={}", update.version, date);
            log::info!("updater: starting download");

            // Actual API (v2.10.1):
            //   on_chunk:    FnMut(chunk_bytes: usize, total_bytes: Option<u64>)
            //   on_finished: FnOnce()
            let mut downloaded: usize = 0;
            let mut last_pct: u8 = 0;
            let result = update
                .download_and_install(
                    |chunk, total| {
                        downloaded += chunk;
                        // Only log at 10% milestones to avoid flooding telemetry.
                        if let Some(t) = total {
                            let pct = ((downloaded as f64 / t as f64) * 10.0) as u8;
                            if pct > last_pct {
                                last_pct = pct;
                                log::info!("updater: progress {}% ({}B / {}B)", pct * 10, downloaded, t);
                            }
                        }
                    },
                    || {
                        log::info!("updater: download complete, installing");
                    },
                )
                .await;

            match result {
                Ok(()) => {
                    // warn triggers FlushNow in the telemetry shipper for immediate POST.
                    // Sleep lets the shipper thread complete the HTTP POST before process exits.
                    log::warn!("updater: install complete, restarting");
                    tokio::time::sleep(std::time::Duration::from_secs(12)).await;
                    app.restart();
                }
                Err(e) => {
                    log::error!("updater: install error: {}", e);
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Catch panics before the process unwinds — flows through fern dispatch
    // into the telemetry shipper thread which is still alive at panic time.
    std::panic::set_hook(Box::new(telemetry::on_panic));

    let session_id = uuid::Uuid::new_v4().to_string();
    let device_id = get_or_create_device_id();
    let queue_path = telemetry_queue_path();

    tauri::Builder::default()
        .plugin(telemetry::build_plugin(session_id.clone(), device_id, queue_path))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::ifc::parse_ifc_buffer,
            commands::ifc::get_geometry,
            commands::ifc::get_geometry_streaming,
            commands::cache::get_cached,
            commands::cache::set_cached,
            commands::cache::clear_cache,
            commands::cache::delete_cache_entry,
            commands::cache::get_cache_stats,
            commands::file_dialog::open_ifc_file,
            commands::updater_trace::log_updater_event,
        ])
        .setup(move |app| {
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                let _ = std::fs::create_dir_all(&cache_dir);
            }
            log::info!("ifc-lite-desktop ready, session={}", session_id);

            // Drive the updater entirely from Rust so every step is captured
            // by the telemetry pipeline — no JS/IPC bridge needed.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                rust_updater_check(handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
