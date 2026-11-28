// Minimal service worker: makes the app installable and gives it a basic
// offline fallback for the app shell (HTML/CSS/JS). It never caches
// Supabase API calls or the CDN'd supabase-js library — those always hit
// the network so data stays live.
const CACHE = "waystation-shell-v135";
// Every page, script and stylesheet is precached (a page whose module is missing offline used to hang on its skeleton for good).
// Paths are relative to wherever the app is served (the site root on Vercel, a sub-folder on the GitHub Pages test copy).
const APP = (u) => new URL(String(u).replace(/^\//, ""), self.registration?.scope || self.location.href).href;
const SHELL = [
  "/",
  "/admin.html", "/buyers.html", "/campaigns.html", "/clients.html",
  "/deals.html", "/dials.html", "/finance.html", "/index.html",
  "/login.html", "/mailboxes.html", "/messages.html", "/profile.html",
  "/sellers.html", "/team.html", "/today.html", "/css/a11y.css", "/css/admin.css",
  "/css/aiChat.css", "/css/copyReview.css", "/css/dialsHome.css", "/css/dialCardLive.css", "/css/importWizard.css",
  "/css/messages-inbox.css", "/css/simple.css", "/css/style.css", "/js/accountsVisible.js",
  "/js/admin.js", "/js/adminAccounts.js", "/js/adminCalendly.js", "/js/adminCampaigns.js",
  "/js/adminLaunch.js", "/js/adminOnboarding.js", "/js/adminSettings.js", "/js/adminSuppression.js", "/js/advancedSettings.js", "/js/aiChat.js",
  "/js/aiChatSetup.js", "/js/auth.js", "/js/autodial.js", "/js/callAudio.js",
  "/js/callLeave.js", "/js/callPanel.js", "/js/callRecordings.js", "/js/callSession.js", "/js/callTranscript.js",
  "/js/callbackBanners.js", "/js/claudeConnect.js", "/js/claudeHelp.js", "/js/clientForm.js",
  "/js/clientCalls.js", "/js/clients.js", "/js/config.js", "/js/contactIcons.js", "/js/copyCommon.js",
  "/js/copyGate.js", "/js/copyLint.js", "/js/copyReview.js", "/js/copyReviewScreen.js",
  "/js/csvImport.js", "/js/dealSide.js", "/js/deletedTabs.js", "/js/dials.js",
  "/js/dialsHome.js", "/js/eventTime.js", "/js/finance.js", "/js/followUp.js",
  "/js/importWizard.js", "/js/layers.js", "/js/netError.js", "/js/resumeConfirm.js", "/js/intakeForm.js", "/js/introCall.js", "/js/mailboxScope.js",
  "/js/mainAdmin.js", "/js/messages.js", "/js/modalLock.js", "/js/noZoom.js",
  "/js/notice.js", "/js/notifications.js", "/js/offlineCache.js", "/js/pageHeaderMenu.js",
  "/js/phoneUtil.js", "/js/placeholders.js", "/js/profile.js", "/js/profileEmails.js",
  "/js/push.js", "/js/pwa.js", "/js/quickSend.js", "/js/reports.js",
  "/js/supabaseClient.js", "/js/teamScope.js", "/js/testCallGuard.js",
  "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    // one file at a time, so a single failed fetch does not throw away the whole shell
    caches.open(CACHE).then((cache) => Promise.all(SHELL.map((u) => cache.add(APP(u)).catch(() => {}))))
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
  //
  // The 8s timeout race guards against a different, more severe failure
  // mode than a normal offline/error response (already handled by .catch
  // below): a request made right as an iOS PWA resumes from being
  // backgrounded can hang forever instead of erroring out, because the OS
  // suspended the underlying network session while backgrounded and never
  // cleanly fails it on resume. Without a timeout, that leaves this
  // fetch() — and every page load it's blocking — stuck waiting on a
  // promise that was never going to settle, which matches real reports of
  // the app "not loading" until force-quit and reopened (the only thing
  // that tears down and rebuilds the stuck connection). A timeout makes
  // this fall through to the exact same cache fallback a real network
  // failure already takes below, instead of hanging indefinitely.
  const networkFetch = fetch(req, { cache: "no-store" });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000));
  event.respondWith(
    Promise.race([networkFetch, timeout])
      .then((res) => {
        if (res.ok) { // never keep a 404 / 500 as the offline copy
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((cached) => cached || caches.match(APP("index.html"))))
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
      icon: APP("icons/icon-192.png"),
      badge: APP("icons/icon-192.png"),
      // send-push sets payload.url (new-email pings open Messages);
      // anything without one keeps opening Profile as before.
      data: { url: payload.url || "/profile.html" },
    })
  );
});

// Tapping a push notification focuses an already-open tab if one exists,
// otherwise opens a new one straight to Profile.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = APP(event.notification.data?.url || "profile.html");
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // an open window goes to the notification's own link (e.g. the client Timeline), not just to the front
        if ("focus" in client) {
          return client.focus().then((c) => {
            const w = c || client;
            try { if (w.navigate && new URL(targetUrl, self.location.origin).href !== w.url) return w.navigate(targetUrl).catch(() => w.postMessage({ type: "open-url", url: targetUrl })); } catch { /* fall through */ }
            try { w.postMessage({ type: "open-url", url: targetUrl }); } catch { /* ignore */ }
          });
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
