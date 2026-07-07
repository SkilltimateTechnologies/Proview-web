/* Proview offline app-shell service worker.
 *
 * Why this exists: an in-progress exam must survive an internet drop AND a
 * page refresh while offline. The exam-runner already rebuilds the running
 * session from localStorage, but that code can only run if the SPA itself
 * boots — and a plain refresh while offline fails to fetch index.html + the
 * hashed JS/CSS bundles, leaving a blank page. This worker caches the app
 * shell so the SPA always loads offline; the app then restores exam state.
 */
const CACHE = "proview-shell-v2";

self.addEventListener("install", (event) => {
  // Pre-cache the app shell so the very first offline refresh has index.html.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/index.html"]).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// The client hands us the exact set of app-shell assets it loaded (index.html
// + hashed JS/CSS/fonts). We pre-cache them while online so an offline refresh
// can boot the SPA. Those initial requests never hit our fetch handler because
// the worker was not yet controlling the page, so this warm-up is essential.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "CACHE_ASSETS" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        data.urls.map((u) =>
          fetch(u, { cache: "no-cache" })
            .then((res) => (res && res.ok ? cache.put(u, res.clone()) : undefined))
            .catch(() => {}),
        ),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests. Everything else (POST, cross-origin,
  // /api calls) must always hit the network — never cache dynamic exam data.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api")) return;

  // Navigation requests (a page load / refresh): network-first so the student
  // gets fresh HTML online, but fall back to the cached app shell offline so
  // the SPA still boots and can resume the exam from localStorage.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put("/index.html", fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          const cached = (await cache.match("/index.html")) || (await cache.match(req));
          if (cached) return cached;
          throw new Error("offline and no cached app shell");
        }
      })(),
    );
    return;
  }

  // Static assets (hashed JS/CSS/images/fonts): stale-while-revalidate. Serve
  // from cache instantly when present, and refresh the cache in the background.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => undefined);
      return cached || (await network) || Response.error();
    })(),
  );
});
