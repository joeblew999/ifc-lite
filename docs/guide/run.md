# Run IFClite

Four ways to use IFClite as an end user, in order of "least to install":

| Path | Install needed | Best for |
|---|---|---|
| [Web (browser)](#web) | none | Trying it, sharing links, lightweight viewing |
| [Desktop app](#desktop) | one .dmg / .msi / .AppImage | Daily use, large files, offline |
| [CLI](#cli) | one binary or `npm i -g` | Scripting, batch ops, CI |
| [Server](#server) | one binary or Docker | Self-hosted parsing for many users |

---

## Web

No install. Open in any modern browser:

- **Full viewer** → <https://ifc-lite-viewer.gedw99.workers.dev>
- **Embed (for iframes / dashboards)** → <https://ifc-lite-viewer-embed.gedw99.workers.dev>

Drag an IFC file onto the page and it's parsed and rendered in-browser via WebAssembly. No file leaves your machine.

Browser requirements: a modern Chromium / Firefox / Safari. WebGPU is preferred (Chrome / Edge desktop) but the renderer falls back to WebGL where WebGPU is unavailable.

---

## Desktop

A native window wrapping the same viewer, plus filesystem-native open / save and zero browser sandboxing limits — useful for very large IFCs.

Download the latest bundle from [GitHub Releases](https://github.com/joeblew999/ifc-lite/releases/latest):

| Platform | File |
|---|---|
| macOS (Intel + Apple Silicon, universal) | `IFC-Lite Viewer_*.dmg` |
| Windows x64 | `IFC-Lite Viewer_*.msi` |
| Linux x64 (AppImage) | `IFC-Lite Viewer_*.AppImage` |
| Linux x64 (Debian / Ubuntu) | `ifc-lite-viewer_*.deb` |

The bundles are produced by `.github/workflows/desktop-binaries.yml`. Builds without code-signing certificates trigger first-launch warnings on macOS and Windows; right-click → Open on Mac, "More info → Run anyway" on Windows.

Built locally instead:

```bash
mise install        # provisions toolchain
mise run build:desktop
# → apps/desktop/src-tauri/target/release/bundle/
```

---

## CLI

Headless toolkit for scripting IFC operations: parse, query, validate, export, IDS, BCF, generate, mutate.

```bash
# From npm (canonical)
npm install -g @ifc-lite/cli

# Quick check
ifc-lite info path/to/model.ifc
ifc-lite query path/to/model.ifc --type IfcWall --json
ifc-lite eval path/to/model.ifc "bim.query().byType('IfcWall').count()"
```

Discover the full API surface:

```bash
ifc-lite schema   # 16 namespaces, full SDK as JSON
```

See the [CLI guide](cli.md) for the complete command reference.

---

## Server

Native Rust HTTP server — hand it an IFC file, get back parsed entities + Parquet-encoded geometry. Runs the same parser as the WASM build, plus Parquet streaming and disk caching for repeat requests.

### Install via mise (recommended — auto-resolves your platform)

Add to `.mise.toml`:

```toml
[tools."http:ifc-lite-server"]
version = "0.1.0"

[tools."http:ifc-lite-server".platforms]
macos-arm64 = { url = "https://pub-889dce91ad7e4605b1fea650ae559d3f.r2.dev/server/v{{version}}/ifc-lite-server-darwin-arm64.tar.gz" }
macos-x64   = { url = "https://pub-889dce91ad7e4605b1fea650ae559d3f.r2.dev/server/v{{version}}/ifc-lite-server-darwin-x64.tar.gz" }
linux-arm64 = { url = "https://pub-889dce91ad7e4605b1fea650ae559d3f.r2.dev/server/v{{version}}/ifc-lite-server-linux-arm64.tar.gz" }
linux-x64   = { url = "https://pub-889dce91ad7e4605b1fea650ae559d3f.r2.dev/server/v{{version}}/ifc-lite-server-linux-x64.tar.gz" }
windows-x64 = { url = "https://pub-889dce91ad7e4605b1fea650ae559d3f.r2.dev/server/v{{version}}/ifc-lite-server-win32-x64.zip" }
```

Then:

```bash
mise install                       # downloads correct binary for your OS
mise exec -- ifc-lite-server       # binary in PATH for this project
```

Same artifacts hosted on Cloudflare R2 (no egress cost, edge-cached globally). `mise upgrade` pulls newer versions automatically when you bump the `version` field.

### Pre-built binary (manual download)

Download from [GitHub Releases](https://github.com/joeblew999/ifc-lite/releases/latest) — produced by `.github/workflows/server-binaries.yml`:

| Target | File |
|---|---|
| Linux x64 (glibc) | `ifc-lite-server-linux-x64.tar.gz` |
| Linux x64 (musl, static) | `ifc-lite-server-linux-x64-musl.tar.gz` |
| Linux arm64 | `ifc-lite-server-linux-arm64.tar.gz` |
| macOS x64 | `ifc-lite-server-darwin-x64.tar.gz` |
| macOS arm64 | `ifc-lite-server-darwin-arm64.tar.gz` |
| Windows x64 | `ifc-lite-server-win32-x64.zip` |

```bash
# Linux / macOS
tar -xzf ifc-lite-server-*-x64.tar.gz
PORT=8080 ./ifc-lite-server
curl http://localhost:8080/api/v1/health
```

Configure via env vars: `PORT` (default 8080), `CACHE_DIR` (default `./cache`), `MAX_FILE_SIZE_MB` (default 500), `WORKER_THREADS` (default 4). Full list in [`apps/server/src/config.rs`](https://github.com/louistrue/ifc-lite/blob/main/apps/server/src/config.rs).

### Docker

```bash
docker pull ghcr.io/louistrue/ifc-lite-server:latest
docker run -p 8080:8080 -v $PWD/cache:/app/cache ghcr.io/louistrue/ifc-lite-server:latest
```

### From source

```bash
mise install
mise run build:server
./target/release/ifc-lite-server
```

### Connecting the viewer to your server

By default the deployed viewer parses in-browser. To route through a server, host your own copy with these env vars baked in at build time:

```bash
# apps/viewer/.env.production
VITE_USE_SERVER=true
VITE_IFC_SERVER_URL=https://your-server.example.com
```

Then `mise run deploy:web` republishes to the same Cloudflare Worker, now server-backed.

---

## Secrets (Doppler → GitHub)

CI workflows (`cloudflare-deploy*.yml`, `desktop-binaries.yml`) read secrets from GitHub Actions secrets. The canonical store is **Doppler**; a mise task syncs Doppler → GitHub so you don't manually paste tokens into the GitHub UI.

```bash
# One-time setup
doppler login              # auth Doppler CLI to your account
doppler setup              # pick project + config for this directory
gh auth login              # auth gh CLI to GitHub

# Inspect
mise run secrets:list             # what's in the mapping table
mise run secrets:status           # Doppler keys vs GitHub repo secrets
mise run secrets:sync-github-dry  # dry-run the sync

# Push
mise run secrets:sync-github      # Doppler → GitHub repo Actions secrets
```

The mapping (Doppler key → GitHub secret name) lives in [`scripts/sync-github-secrets.sh`](https://github.com/joeblew999/ifc-lite/blob/main/scripts/sync-github-secrets.sh). Add lines as new workflows need new secrets. Optional desktop signing secrets (Apple cert, Tauri key) are commented out — uncomment when you have them in Doppler.

## Local "everything running together"

For development or when running both viewer and server on one machine:

```bash
mise run dev:all
# Viewer:  http://localhost:3000
# Server:  http://localhost:8080
# Logs:    pitchfork logs viewer | pitchfork logs server
# Stop:    pitchfork stop viewer server
```

The viewer's `apps/viewer/.env.local` (gitignored) points at `http://localhost:8080` so parse calls hit your local server, not the in-browser WASM. Production builds always default to in-browser WASM thanks to `apps/viewer/.env.production`.
