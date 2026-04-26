// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Cloudflare Worker entrypoint for the viewer deployment.
//
// Static assets are served by the Workers Static Assets binding (`ASSETS`).
// This Worker only handles `/api/*` routes — equivalents of the Vercel
// rewrites the viewer's source code expects:
//
//   /api/bsdd/<path>     → https://api.bsdd.buildingsmart.org/<path>
//   /api/epsg/<path>     → https://epsg.io/<path>
//
// Other /api/* paths (chat, geocode, streetview, server-parse) are not yet
// wired here; they return 404 until you decide whether to port them.

interface Env {
  ASSETS: Fetcher;
}

const PROXIES: Record<string, string> = {
  '/api/bsdd/': 'https://api.bsdd.buildingsmart.org/',
  '/api/epsg/': 'https://epsg.io/',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    for (const [prefix, target] of Object.entries(PROXIES)) {
      if (url.pathname.startsWith(prefix)) {
        const upstream = new URL(
          url.pathname.slice(prefix.length) + url.search,
          target,
        );
        // Forward the request, stripping CF-specific headers Cloudflare
        // would otherwise echo back upstream.
        const init: RequestInit = {
          method: request.method,
          headers: stripHopHeaders(request.headers),
          body: request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : request.body,
          redirect: 'follow',
        };
        const upstreamResp = await fetch(upstream.toString(), init);
        // Pass response through with permissive CORS (the viewer is on a
        // different host than the proxied APIs).
        const resp = new Response(upstreamResp.body, upstreamResp);
        resp.headers.set('access-control-allow-origin', '*');
        return resp;
      }
    }

    // Anything else — fall through to static assets (the viewer SPA).
    return env.ASSETS.fetch(request);
  },
};

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
