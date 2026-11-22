// Fill these in from your Supabase project (Project Settings > API).
// This "anon" key is safe to expose publicly — real protection comes from
// the Row Level Security policies in supabase/schema.sql, not from hiding
// this key.
// Environment switch. Default is LIVE. Only Vercel preview/branch URLs for this
// project (waystation-advisors-<hash|git-branch>-waystation-advisors.vercel.app)
// and localhost use the TEST project. So test-branch previews never touch live
// data, and merging this file into main cannot point production at test.
const HOST = typeof location !== "undefined" ? location.hostname : "";
const IS_TEST = /^waystation-advisors-[a-z0-9-]+-waystation-advisors\.vercel\.app$/.test(HOST)
  || HOST === "localhost" || HOST === "127.0.0.1";
const IS_PROD = !IS_TEST;
export const APP_ENV = IS_PROD ? "live" : "test";
export const SUPABASE_URL = IS_PROD ? "https://jabjrhkhnbabfihodqie.supabase.co" : "https://aglqusdpkwdidoiaavub.supabase.co";
export const SUPABASE_ANON_KEY = IS_PROD
  ? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphYmpyaGtobmJhYmZpaG9kcWllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjY3MDYsImV4cCI6MjA5OTgwMjcwNn0._YzzFLG4Y0iF9cFQ9lbv2cUu3L76x-JJSpkmu5-YIy0"
  : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFnbHF1c2Rwa3dkaWRvaWFhdnViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyMDU1NDgsImV4cCI6MjExMDc4MTU0OH0.hE5yrTZJnlHED2H4wu8w8pcLvg18JyvGpfsMvWLReoo";

// Public key for the Web Push VAPID keypair (see js/push.js) — safe to
// expose publicly, same trust level as the anon key above. The matching
// private key lives server-side only, in the app_secrets table (readable
// only by the send-push Edge Function's service-role client).
// The test project has its own keypair (private half in the TEST project's app_secrets), so test pushes never share live keys.
export const VAPID_PUBLIC_KEY = IS_PROD
  ? "BKmi1-1Ytinb51D-iqCLXs7jbB4KaG4NDKiiCuXVGkIGZuvqHK88tUb3UC9Ugsp50z9ZDanL9Q64QjFDp3DS82w"
  : "BF0sSAqn2OxZDtGty5Xf49DUSHJavThiYFTf2u-X_ni6kSgge90fFmHfV44HAJQpOON2PpIg1iYXkl5SkFnnZ2E";

// Warm the connection to whichever project this page really uses (static <link>s used to hard-code the LIVE host).
try {
  if (typeof document !== "undefined") {
    const l = document.createElement("link");
    l.rel = "preconnect"; l.href = SUPABASE_URL; l.crossOrigin = "";
    document.head.appendChild(l);
  }
} catch { /* not a browser page */ }
