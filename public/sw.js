/**
 * Time Tracer service worker — an offline app-shell for the client-only app.
 *
 * Hand-rolled (no build-time precache manifest) so it works with hashed asset
 * filenames: the app shell is cached on install, same-origin static assets are
 * served stale-while-revalidate, and navigations fall back to the cached shell
 * when offline so deep links keep booting.
 *
 * It deliberately ignores cross-origin requests, so calls to the GitHub /
 * GitLab / Bitbucket / Azure DevOps APIs (and any self-hosted instance) are
 * never intercepted or cached — repository content still goes straight to the
 * provider and nowhere else.
 */
const VERSION = 'v1';
const CACHE = `time-tracer-${VERSION}`;
const APP_SHELL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Best-effort precache of the shell; a host that only serves "/" still works.
      try {
        await cache.add(APP_SHELL);
      } catch {
        try {
          const root = await fetch('/');
          if (root.ok) await cache.put(APP_SHELL, root);
        } catch {
          /* offline at install — runtime caching will fill in later */
        }
      }
      try {
        await cache.add('/manifest.webmanifest');
      } catch {
        /* non-fatal */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Only same-origin assets are cached — never the provider APIs / repo content.
  if (url.origin !== self.location.origin) return;
  // Let the browser manage the worker script's own updates.
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

/** Navigations: fresh when online, the cached shell when offline (SPA fallback). */
async function networkFirstShell(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    // All app routes resolve to index.html (SPA fallback) — keep the shell fresh.
    if (response && response.ok) cache.put(APP_SHELL, response.clone());
    return response;
  } catch {
    const cached = await cache.match(APP_SHELL);
    return cached || Response.error();
  }
}

/** Static assets: serve cached immediately, refresh the cache in the background. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.status === 200) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}
