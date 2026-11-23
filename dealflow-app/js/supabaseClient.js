import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// The library's built-in retry waits 1 s, 2 s, 4 s between attempts, so a dead connection took 7+ s per request before anything could
// say so (round 5: skeletons stayed up half a minute). Retries are done here instead, in the same spirit but short: a reads-only
// quick second try after a dropped connection (the PWA-resume glitch), and a few spaced tries when the server answers 503 (busy).
// Writes are never repeated.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function appFetch(input, init) {
  const method = String(init?.method || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
  const reads = method === "GET" || method === "HEAD";
  for (let n = 0; ; n++) {
    try {
      const res = await fetch(input, init);
      if (reads && res.status === 503 && n < 3) { await res.text().catch(() => {}); await sleep(600 * (n + 1)); continue; }
      return res;
    } catch (e) {
      if (!reads || n >= 1 || e?.name === "AbortError") throw e;
      await sleep(400);
    }
  }
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: appFetch }, db: { retry: false } });
