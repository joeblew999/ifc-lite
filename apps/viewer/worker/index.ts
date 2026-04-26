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
//   /api/updater/<target>/<arch>/<ver>  → Tauri updater manifest from latest GH release
//
// Other /api/* paths (chat, geocode, streetview, server-parse) return 404
// until ported.

interface Env {
  ASSETS: Fetcher;
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
      return handleUpdater(url.pathname);
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

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

async function handleUpdater(pathname: string): Promise<Response> {
  // pathname = /api/updater/<target>/<arch>/<current_version>
  const parts = pathname.replace(/^\/api\/updater\//, '').split('/');
  if (parts.length < 3) return new Response('bad request', { status: 400 });
  const [target, arch, currentVersion] = parts;

  // Fetch latest release from GitHub.
  const ghResp = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
    headers: { 'user-agent': 'ifc-lite-updater', 'accept': 'application/vnd.github+json' },
  });
  if (!ghResp.ok) return new Response('upstream error', { status: 502 });
  const release = await ghResp.json() as { tag_name: string; assets: ReleaseAsset[]; published_at: string; body?: string };

  // Strip leading 'v' and any '-suffix' for semver compare.
  const latestVersion = release.tag_name.replace(/^v/, '').replace(/-.*$/, '');
  const current = currentVersion.replace(/^v/, '').replace(/-.*$/, '');
  if (compareSemver(latestVersion, current) <= 0) {
    return new Response(null, { status: 204 }); // no update
  }

  // Map Tauri's <target>/<arch> to the bundle filename suffix we ship.
  const platform = `${target}-${arch}`; // e.g. darwin-aarch64, linux-x86_64, windows-x86_64
  const wanted = pickAssetForPlatform(release.assets, platform);
  if (!wanted) return new Response(null, { status: 204 });

  const sigAsset = release.assets.find((a) => a.name === `${wanted.name}.sig`);
  const signature = sigAsset
    ? await fetch(sigAsset.browser_download_url).then((r) => (r.ok ? r.text() : ''))
    : '';

  return Response.json({
    version: latestVersion,
    pub_date: release.published_at,
    notes: release.body?.slice(0, 500) ?? '',
    url: wanted.browser_download_url,
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
