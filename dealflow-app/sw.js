// Minimal service worker: makes the app installable and gives it a basic
// offline fallback for the app shell (HTML/CSS/JS). It never caches
// Supabase API calls or the CDN'd supabase-js library — those always hit
// the network so data stays live.
const CACHE = "waystation-shell-v2";
const SHELL = [
  "/", "/index.html", "/login.html", "/profile.html", "/clients.html",
  "/dials.html", "/finance.html", "/css/style.css",
  "/js/auth.js", "/js/profile.js", "/js/clients.js", "/js/dials.js",
  "/js/finance.js", "/js/config.js", "/js/supabaseClient.js",
  "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only manage our own same-origin shell files. Everything else
  // (Supabase API, jsdelivr CDN) goes straight to the network untouched.
  if (url.origin !== self.location.origin || req.method !== "GET") return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("/index.html")))
  );
});
