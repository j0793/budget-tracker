// Caches the app so it opens offline. Only the app's own files are cached;
// your data is in IndexedDB and never passes through here.
// Bump VERSION when you change any file so phones pick up the update.
const VERSION = "v4";
const CACHE = `budget-${VERSION}`;
const FILES = ["./", "index.html", "backend.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("budget-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// serve from cache right away, refresh the cache in the background
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
