// Minimal service worker: makes the app installable and gives it a basic
// offline fallback for the app shell (HTML/CSS/JS). It never caches
// Supabase API calls or the CDN'd supabase-js library — those always hit
// the network so data stays live.
const CACHE = "waystation-shell-v3";
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

  // { cache: "no-store" } forces this fetch to skip the browser's own HTTP
  // disk cache and always hit the network — without it, a plain fetch(req)
  // can be silently satisfied out of HTTP cache (depending on Vercel's
  // response cache-control headers) even though this handler LOOKS like
  // network-first. That's exactly what let real users keep running an old
  // cached copy of dials.js for hours after a fix had already shipped and
  // was confirmed live server-side — this closes that gap for good.
  event.respondWith(
    fetch(req, { cache: "no-store" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("/index.html")))
  );
});
