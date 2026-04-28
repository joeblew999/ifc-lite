// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Cloudflare Worker entrypoint for the viewer deployment.
//
// Static assets are served by the Workers Static Assets binding (`ASSETS`).
// This Worker handles only `/api/*` routes:
//
//   /api/bsdd/<path>                    → proxy to api.bsdd.buildingsmart.org
//   /api/epsg/<path>                    → proxy to epsg.io
//   /api/updater/<target>/<arch>/<ver>  → Tauri updater manifest (R2 URLs, GH API for version)
//   /api/releases/<tag>/<filename>      → streams updater bundle from R2 (ifc-lite-bin)
//   /api/me                             → current user via Service Binding to auth-better-worker
//   /api/me/org                         → current user's active org membership (org_id, role, etc) — null if no active org
//
// Other /api/* paths (chat, geocode, streetview, server-parse) return 404
// until ported.

interface Env {
  ASSETS: Fetcher;
  // Service Binding to plat-trunk's auth-better-worker. Internal CF call,
  // no public DNS hop, no egress cost. Forwards the browser session cookie.
  AUTH: Fetcher;
  // D1 telemetry store — ifc-lite-telemetry (d7f1c6da-e4c0-46d8-b1bd-2f434382c542)
  TELEMETRY_DB: D1Database;
  // R2 bucket for desktop release bundles — ifc-lite-bin.
  // Objects stored at releases/<tag>/<filename>, e.g.:
  //   releases/v1.1.9/IFC-Lite-Viewer-aarch64-apple-darwin.app.tar.gz
  //   releases/v1.1.9/IFC-Lite-Viewer-aarch64-apple-darwin.app.tar.gz.sig
  RELEASES: R2Bucket;
}

const PROXIES: Record<string, string> = {
  '/api/bsdd/': 'https://api.bsdd.buildingsmart.org/',
  '/api/epsg/': 'https://epsg.io/',
};

const RELEASES_REPO = 'joeblew999/ifc-lite';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Tauri updater route. The desktop app polls this on startup with its
    // current version; we return either 204 (no update) or a JSON manifest
    // describing the newer bundle to download.
    if (url.pathname.startsWith('/api/updater/')) {
      return handleUpdater(request, url.pathname, env);
    }

    // R2 release-bundle passthrough. CI uploads updater payloads to the
    // ifc-lite-bin bucket under releases/<tag>/<filename>. The desktop app
    // downloads its update from here instead of GitHub CDN.
    if (url.pathname.startsWith('/api/releases/')) {
      return handleReleasesDownload(url.pathname, env);
    }

    // Desktop telemetry ingest — batched log events from the Tauri app.
    // Workers Logs: each event is console.log'd → queryable via query_worker_observability MCP.
    // D1: each event is inserted into `events` → queryable via d1_database_query MCP.
    if (url.pathname === '/api/v0/events') {
      return handleTelemetry(request, env);
    }

    // Current-user lookup via Service Binding to auth-better-worker.
    // Cookie is sent by the browser (because of crossSubDomainCookies on
    // .ubuntusoftware.net) and forwarded internally to auth-better.
    if (url.pathname === '/api/me') {
      const user = await getAuthUser(request, env);
      if (!user) return new Response('not signed in', { status: 401 });
      return Response.json(user);
    }

    // Active org membership (RBAC primitive). Returns the row from
    // Better Auth's `member` table for the current session's active org:
    //   { id, organizationId, userId, role, createdAt, ... }
    // Returns 401 if not signed in, null body if signed in but no active
    // org. Use `member.role` for role-based authz checks; use the
    // organizationId as a tenant boundary for resource queries.
    if (url.pathname === '/api/me/org') {
      const member = await getOrgMember(request, env);
      return Response.json(member);
    }

    for (const [prefix, target] of Object.entries(PROXIES)) {
      if (url.pathname.startsWith(prefix)) {
        const upstream = new URL(
          url.pathname.slice(prefix.length) + url.search,
          target,
        );
        const init: RequestInit = {
          method: request.method,
          headers: stripHopHeaders(request.headers),
          body: request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : request.body,
          redirect: 'follow',
        };
        const upstreamResp = await fetch(upstream.toString(), init);
        const resp = new Response(upstreamResp.body, upstreamResp);
        resp.headers.set('access-control-allow-origin', '*');
        return resp;
      }
    }

    return env.ASSETS.fetch(request);
  },
};

interface TelemetryEvent {
  app_version: string;
  os: string;
  arch: string;
  level: string;
  message: string;
  timestamp: string;
  session_id: string;
  device_id: string;
}

async function handleTelemetry(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });

  let events: TelemetryEvent[];
  try {
    const body = await request.json();
    if (!Array.isArray(body) || body.length === 0) return new Response(null, { status: 204 });
    if (body.length > 100) return new Response('too many events', { status: 413 });
    events = body as TelemetryEvent[];
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  // Workers Logs — 7-day hot window, queryable via query_worker_observability MCP.
  for (const ev of events) {
    console.log(JSON.stringify({ telemetry: true, ...ev }));
  }

  // D1 — permanent queryable store via d1_database_query MCP.
  try {
    const stmt = env.TELEMETRY_DB.prepare(
      'INSERT INTO events (app_version, os, arch, level, message, timestamp, session_id, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const batch = events.map((ev) =>
      stmt.bind(
        ev.app_version ?? '',
        ev.os ?? '',
        ev.arch ?? '',
        ev.level ?? 'info',
        (ev.message ?? '').slice(0, 2000),
        ev.timestamp ?? new Date().toISOString(),
        ev.session_id ?? '',
        ev.device_id ?? '',
      ),
    );
    await env.TELEMETRY_DB.batch(batch);
  } catch (err) {
    // Non-fatal — don't fail the desktop app if D1 is unavailable.
    console.error('telemetry D1 insert failed', String(err));
  }

  return new Response(null, { status: 204 });
}

// Resolve the current session via Service Binding. The hostname in the URL
// is irrelevant — Service Bindings route by service name, not DNS — but
// the Request constructor needs a valid URL. Better Auth basePath is
// `/auth/api`, so the get-session endpoint is `/auth/api/get-session`.
async function getAuthUser(req: Request, env: Env): Promise<unknown | null> {
  const authReq = new Request('https://auth-internal/auth/api/get-session', {
    method: 'GET',
    headers: { cookie: req.headers.get('cookie') ?? '' },
  });
  const res = await env.AUTH.fetch(authReq);
  if (!res.ok) return null;
  const data = await res.json() as { user?: unknown } | null;
  return data?.user ?? null;
}

// Resolve the current user's active org membership via Service Binding.
// Better Auth's organization plugin endpoint: /auth/api/organization/get-active-member.
// Returns the row from the `member` table for the active org:
//   { id, organizationId, userId, role, createdAt, ... }
// Use `member.role` for role-based authz checks. Returns null if the user
// isn't signed in, or signed in but has no active org yet (just-signed-up
// users have no orgs until they create one or accept an invite).
//
// Pattern for any future protected route:
//   const member = await getOrgMember(request, env);
//   if (!member) return new Response('not in any org', { status: 403 });
//   if (member.role !== 'admin') return new Response('admin only', { status: 403 });
async function getOrgMember(req: Request, env: Env): Promise<{
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt?: string;
} | null> {
  const authReq = new Request('https://auth-internal/auth/api/organization/get-active-member', {
    method: 'GET',
    headers: { cookie: req.headers.get('cookie') ?? '' },
  });
  const res = await env.AUTH.fetch(authReq);
  if (!res.ok) return null;
  const data = await res.json();
  // Better Auth returns the member object directly when there's an active org,
  // or null when there isn't. Type-narrow defensively.
  if (data && typeof data === 'object' && 'role' in data) {
    return data as { id: string; organizationId: string; userId: string; role: string; createdAt?: string };
  }
  return null;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

// Manifest written to R2 at releases/latest.json by CI (and by
// release:desktop-r2 for local dev builds). Lets the Worker return a new
// version WITHOUT needing a GitHub release — key for fast local iteration.
interface R2LatestManifest {
  version: string;
  pub_date: string;
  notes: string;
  // Maps platform key (darwin-aarch64, linux-x86_64, windows-x86_64) to
  // the updater bundle filename (without path — the Worker prepends the tag).
  platforms: Record<string, string>;
}

async function handleReleasesDownload(pathname: string, env: Env): Promise<Response> {
  // pathname = /api/releases/<tag>/<filename>
  // Strips the /api/releases/ prefix to get the R2 key: releases/<tag>/<filename>
  const r2Key = 'releases/' + pathname.replace(/^\/api\/releases\//, '');
  const obj = await env.RELEASES.get(r2Key);
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  headers.set('content-type', obj.httpMetadata?.contentType ?? 'application/octet-stream');
  if (obj.size) headers.set('content-length', String(obj.size));
  headers.set('etag', obj.httpEtag);
  headers.set('access-control-allow-origin', '*');
  return new Response(obj.body, { headers });
}

async function handleUpdater(request: Request, pathname: string, env: Env): Promise<Response> {
  // pathname = /api/updater/<target>/<arch>/<current_version>
  const parts = pathname.replace(/^\/api\/updater\//, '').split('/');
  if (parts.length < 3) return new Response('bad request', { status: 400 });
  const [target, arch, currentVersion] = parts;

  const platform = `${target}-${arch}`; // e.g. darwin-aarch64, linux-x86_64
  const current = currentVersion.replace(/^v/, '').replace(/-.*$/, '');
  const base = new URL(request.url);

  // ── R2-first path ──────────────────────────────────────────────────────────
  // CI and `mise run release:desktop-r2` both write releases/latest.json.
  // When present it lets us serve an update without a GitHub release, which
  // makes local dev iteration fast: build → push R2 → install old → auto-update.
  const latestObj = await env.RELEASES.get('releases/latest.json');
  if (latestObj) {
    const manifest = await latestObj.json<R2LatestManifest>();
    const latestVersion = manifest.version.replace(/^v/, '').replace(/-.*$/, '');

    if (compareSemver(latestVersion, current) > 0) {
      const filename = manifest.platforms[platform];
      if (filename) {
        const tag = `v${manifest.version}`;
        const sigObj = await env.RELEASES.get(`releases/${tag}/${filename}.sig`);
        if (sigObj) {
          return Response.json({
            version: manifest.version,
            pub_date: manifest.pub_date,
            notes: manifest.notes,
            url: `${base.origin}/api/releases/${tag}/${filename}`,
            signature: await sigObj.text(),
          });
        }
      }
    } else {
      return new Response(null, { status: 204 }); // R2 says we're up to date
    }
  }

  // ── GitHub fallback ────────────────────────────────────────────────────────
  // Used when releases/latest.json doesn't exist or the .sig is missing in R2.
  const ghResp = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
    headers: { 'user-agent': 'ifc-lite-updater', 'accept': 'application/vnd.github+json' },
  });
  if (!ghResp.ok) return new Response('upstream error', { status: 502 });
  const release = await ghResp.json() as { tag_name: string; assets: ReleaseAsset[]; published_at: string; body?: string };

  const latestVersion = release.tag_name.replace(/^v/, '').replace(/-.*$/, '');
  if (compareSemver(latestVersion, current) <= 0) {
    return new Response(null, { status: 204 });
  }

  const wanted = pickAssetForPlatform(release.assets, platform);
  if (!wanted) return new Response(null, { status: 204 });

  // Use R2 for the .sig if available (avoids GitHub CDN hop).
  const r2SigKey = `releases/${release.tag_name}/${wanted.name}.sig`;
  const sigObj = await env.RELEASES.get(r2SigKey);
  let signature: string;
  let downloadUrl: string;
  if (sigObj) {
    signature = await sigObj.text();
    downloadUrl = `${base.origin}/api/releases/${release.tag_name}/${wanted.name}`;
  } else {
    const sigAsset = release.assets.find((a) => a.name === `${wanted.name}.sig`);
    signature = sigAsset
      ? await fetch(sigAsset.browser_download_url).then((r) => (r.ok ? r.text() : ''))
      : '';
    downloadUrl = wanted.browser_download_url;
  }

  return Response.json({
    version: latestVersion,
    pub_date: release.published_at,
    notes: release.body?.slice(0, 500) ?? '',
    url: downloadUrl,
    signature,
  });
}

function pickAssetForPlatform(assets: ReleaseAsset[], platform: string): ReleaseAsset | undefined {
  // Restrict to desktop bundles only — release also contains server bins
  // and they share .tar.gz extensions which would otherwise match.
  const desktopAssets = assets.filter((a) => /^IFC[-_]Lite/i.test(a.name));

  const platformAliases: Record<string, string[]> = {
    'darwin-x86_64': ['darwin-x64', 'x86_64-apple-darwin', 'macos-x64', 'x64.app'],
    'darwin-aarch64': ['darwin-arm64', 'aarch64-apple-darwin', 'macos-arm64', 'aarch64.app'],
    'darwin-universal': ['universal-apple-darwin', 'darwin-universal', 'universal.app'],
    'linux-x86_64': ['linux-x64', 'amd64', 'x86_64-unknown-linux'],
    'linux-aarch64': ['linux-arm64', 'aarch64-unknown-linux'],
    'windows-x86_64': ['win32-x64', 'x86_64-pc-windows', 'windows-x64', 'x64-setup', 'x64_en'],
  };
  const candidates = platformAliases[platform] ?? [platform];

  // Prefer Tauri-updater bundles (in-place patchable) over installers.
  // .app.tar.gz / .AppImage.tar.gz / .msi.zip are produced when
  // createUpdaterArtifacts: true is set in tauri.conf.json.
  const updaterExts = ['.app.tar.gz', '.AppImage.tar.gz', '.msi.zip'];
  for (const ext of updaterExts) {
    for (const alias of candidates) {
      const hit = desktopAssets.find((a) => a.name.toLowerCase().includes(alias.toLowerCase()) && a.name.endsWith(ext));
      if (hit) return hit;
    }
  }
  return undefined;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (da !== 0) return da;
  }
  return 0;
}

function stripHopHeaders(src: Headers): Headers {
  const out = new Headers(src);
  for (const h of [
    'host',
    'cf-connecting-ip',
    'cf-ipcountry',
    'cf-ray',
    'cf-visitor',
    'cf-worker',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-real-ip',
  ]) {
    out.delete(h);
  }
  return out;
}
