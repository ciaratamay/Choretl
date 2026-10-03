// Bump this on every deploy. It's what retires the previous cache, and it's
// shown on the Home tab so you can tell at a glance which build is running.
const APP_VERSION = "v29";
const CACHE_NAME = `choretl-shell-${APP_VERSION}`;
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./icon-apple-180.png",
  "./turtle-wink.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Anything the app is actually built from — the page, its script, its styles,
// the manifest — is fetched fresh whenever there's a connection, and only
// falls back to the cached copy when there isn't. Cache-first was serving a
// stale build after a deploy until the browser happened to notice; this way a
// deploy shows up on the next load. Images don't change, so they stay
// cache-first and keep the app loading instantly.
const ALWAYS_FRESH = /\.(?:html|js|css|json)$/i;

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept Firebase/Google or any cross-origin API traffic —
  // those must always hit the network so sync stays live.
  if (url.origin !== self.location.origin) return;

  const freshFirst = request.mode === "navigate"
    || ALWAYS_FRESH.test(url.pathname)
    || url.pathname.endsWith("/");

  if (freshFirst) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((cached) =>
          cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) =>
      cached ||
      fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return res;
      }).catch(() => cached)
    )
  );
});
