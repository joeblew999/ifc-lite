// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::cell::OnceCell;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use tauri_plugin_log::{fern, Target, TargetKind};

const INGEST_URL: &str =
    "https://ifc-lite-viewer.gedw99.workers.dev/api/v0/events";

const BATCH_SECS: u64 = 3;
const BATCH_MAX: usize = 25;
// Maximum events persisted offline before we start dropping oldest.
const QUEUE_MAX: usize = 500;
// Sleep duration in the panic hook to give the shipper time to POST.
const PANIC_FLUSH_WAIT: Duration = Duration::from_secs(5);

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Event {
    app_version: String,
    os: String,
    arch: String,
    level: String,
    message: String,
    timestamp: String,
    session_id: String,
    device_id: String,
}

enum Msg {
    Event(Event),
    // Error/warn: shipper flushes immediately instead of waiting for the timer.
    FlushNow(Event),
}

pub fn build_plugin<R: tauri::Runtime>(
    session_id: String,
    device_id: String,
    queue_path: PathBuf,
) -> tauri::plugin::TauriPlugin<R> {
    let app_version: &'static str = env!("CARGO_PKG_VERSION");
    let os: &'static str = std::env::consts::OS;
    let arch: &'static str = std::env::consts::ARCH;

    let (tx, rx) = mpsc::channel::<Msg>();

    // Stash a sender for the panic hook (registered in lib.rs).
    let panic_tx = tx.clone();
    PANIC_TX.with(|cell| { let _ = cell.set(panic_tx); });

    thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());

        let mut batch: Vec<Event> = Vec::new();

        // Attempt to ship batch + any persisted offline events.
        // Returns true on success, false if offline (events written to queue).
        let ship = |client: &reqwest::blocking::Client,
                    batch: &mut Vec<Event>,
                    queue_path: &PathBuf| {
            if batch.is_empty() {
                return;
            }
            // Prepend any events that failed to ship in a previous run.
            let mut to_send = drain_queue(queue_path);
            to_send.append(batch);

            match client.post(INGEST_URL).json(&to_send).send() {
                Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 204 => {
                    // Online — queue is now empty, batch shipped.
                }
                _ => {
                    // Offline or server error — persist for next attempt.
                    persist_queue(&to_send, queue_path);
                    *batch = Vec::new();
                }
            }
            batch.clear();
        };

        loop {
            match rx.recv_timeout(Duration::from_secs(BATCH_SECS)) {
                Ok(Msg::Event(event)) => {
                    batch.push(event);
                    while let Ok(msg) = rx.try_recv() {
                        match msg {
                            Msg::Event(e) => batch.push(e),
                            Msg::FlushNow(e) => { batch.push(e); ship(&client, &mut batch, &queue_path); }
                        }
                        if batch.len() >= BATCH_MAX { ship(&client, &mut batch, &queue_path); }
                    }
                }
                Ok(Msg::FlushNow(event)) => {
                    batch.push(event);
                    ship(&client, &mut batch, &queue_path);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    ship(&client, &mut batch, &queue_path);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    ship(&client, &mut batch, &queue_path);
                    break;
                }
            }
            if batch.len() >= BATCH_MAX {
                ship(&client, &mut batch, &queue_path);
            }
        }
    });

    let dispatch = fern::Dispatch::new().chain(fern::Output::call(move |record| {
        let event = Event {
            app_version: app_version.to_string(),
            os: os.to_string(),
            arch: arch.to_string(),
            level: record.level().to_string().to_lowercase(),
            message: record.args().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            session_id: session_id.clone(),
            device_id: device_id.clone(),
        };
        let msg = if record.level() <= log::Level::Warn {
            Msg::FlushNow(event)
        } else {
            Msg::Event(event)
        };
        let _ = tx.send(msg);
    }));

    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::Dispatch(dispatch)),
        ])
        .level(log::LevelFilter::Info)
        .build()
}

// ---------------------------------------------------------------------------
// Offline queue — JSONL file, one serialised Event per line.
// Read drains the file (removes it). Write appends, capped at QUEUE_MAX.
// ---------------------------------------------------------------------------

fn drain_queue(path: &PathBuf) -> Vec<Event> {
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    let events: Vec<Event> = std::io::BufReader::new(file)
        .lines()
        .filter_map(|l| l.ok())
        .filter_map(|l| serde_json::from_str::<Event>(&l).ok())
        .collect();
    let _ = std::fs::remove_file(path);
    events
}

fn persist_queue(events: &[Event], path: &PathBuf) {
    // Read existing queued events, append new ones, cap at QUEUE_MAX.
    let mut existing = drain_queue(path);
    existing.extend_from_slice(events);
    if existing.len() > QUEUE_MAX {
        existing.drain(0..existing.len() - QUEUE_MAX);
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        for ev in &existing {
            if let Ok(line) = serde_json::to_string(ev) {
                let _ = writeln!(file, "{}", line);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Panic hook support
// ---------------------------------------------------------------------------

thread_local! {
    static PANIC_TX: OnceCell<mpsc::Sender<Msg>> = const { OnceCell::new() };
}

/// Register as `std::panic::set_hook(Box::new(telemetry::on_panic))`.
/// Ships the panic message then blocks the panicking thread for PANIC_FLUSH_WAIT
/// so the shipper thread can complete its POST before the process exits.
pub fn on_panic(info: &std::panic::PanicHookInfo<'_>) {
    PANIC_TX.with(|cell| {
        if let Some(tx) = cell.get() {
            let event = Event {
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                os: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                level: "error".into(),
                message: format!("panic: {}", info),
                timestamp: chrono::Utc::now().to_rfc3339(),
                session_id: String::new(),
                device_id: String::new(),
            };
            let _ = tx.send(Msg::FlushNow(event));
        }
    });
    thread::sleep(PANIC_FLUSH_WAIT);
}
