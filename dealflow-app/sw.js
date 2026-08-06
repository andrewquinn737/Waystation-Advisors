// Minimal service worker: makes the app installable and gives it a basic
// offline fallback for the app shell (HTML/CSS/JS). It never caches
// Supabase API calls or the CDN'd supabase-js library — those always hit
// the network so data stays live.
const CACHE = "waystation-shell-v8";
const SHELL = [
  "/", "/index.html", "/login.html", "/profile.html", "/clients.html",
  "/dials.html", "/finance.html", "/css/style.css",
  "/js/auth.js", "/js/profile.js", "/js/clients.js", "/js/dials.js",
  "/js/finance.js", "/js/config.js", "/js/supabaseClient.js", "/js/push.js",
  "/js/offlineCache.js", "/js/eventTime.js",
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

  // Stale-while-revalidate: answer instantly from our own Cache Storage
  // (a disk lookup, no network round trip) when we have something, while a
  // real network fetch runs in the background to refresh that entry for
  // NEXT time. This is different from a plain browser-HTTP-cache hit — we
  // still hit the network on every single load via { cache: "no-store" }
  // (which skips the browser's HTTP disk cache and can't be silently
  // satisfied without a real request, same protection as before), it just
  // no longer blocks the response on that round trip finishing first.
  //
  // Tradeoff vs. the old network-first-with-no-store approach: right after
  // a deploy, the very next load of a changed file can still serve the
  // previous version (whatever was cached from the last visit) instead of
  // the new one — but the background fetch that same load updates the
  // cache, so the load right after that is fresh. That's a world apart
  // from the original incident this no-store fix targeted (real users
  // stuck on an old dials.js for HOURS because the browser's own HTTP
  // cache satisfied every request without ever reaching the network at
  // all) — this always reaches the network, it just doesn't make you wait
  // for it before you can see anything.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);

      if (cached) {
        // Background refresh only — this response has exactly one reader
        // (cache.put), so hand it over directly instead of cloning it.
        // response.clone() splits the body into two independent streams;
        // if only one of the two ever gets read, iOS/Safari's
        // ReadableStream implementation can corrupt what actually lands
        // in Cache Storage, silently writing a 0-byte entry instead of
        // the real page. That's what caused pages to intermittently show
        // as an empty "Document — Zero KB" needing an app picker instead
        // of rendering. Not cloning here means there's only ever one
        // reader, so that failure mode can't happen.
        event.waitUntil(
          fetch(req, { cache: "no-store" })
            .then((res) => cache.put(req, res))
            .catch(() => {})
        );
        return cached;
      }

      // Nothing cached yet (first-ever visit to this file) — this
      // response genuinely needs two independent readers (the page AND
      // the cache), so clone() is required, and safe, since both halves
      // actually get fully consumed here.
      try {
        const res = await fetch(req, { cache: "no-store" });
        cache.put(req, res.clone());
        return res;
      } catch {
        return caches.match("/index.html");
      }
    })
  );
});

// Real Web Push (see js/push.js for the subscribe side, and the send-push
// Edge Function for the send side). The payload is always
// { title, body } JSON — see send-push/index.ts.
self.addEventListener("push", (event) => {
  let payload = { title: "Waystation Advisors", body: "" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Non-JSON payload (shouldn't happen — send-push always sends JSON) —
    // fall back to the plain text body rather than dropping the notification.
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: "/profile.html" },
    })
  );
});

// Tapping a push notification focuses an already-open tab if one exists,
// otherwise opens a new one straight to Profile.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/profile.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
