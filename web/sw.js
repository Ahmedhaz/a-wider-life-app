// Minimal service worker: makes the app installable and keeps the shell available offline.
// Today's data is fetched live; the client queues nothing yet (phase three adds the answer queue).
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/apple-touch-icon.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open("awl-shell-v2").then((c) => c.addAll(SHELL)).catch(() => {})));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).pathname.startsWith("/v1/")) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
