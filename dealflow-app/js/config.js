// Fill these in from your Supabase project (Project Settings > API).
// This "anon" key is safe to expose publicly — real protection comes from
// the Row Level Security policies in supabase/schema.sql, not from hiding
// this key.
export const SUPABASE_URL = "https://jabjrhkhnbabfihodqie.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphYmpyaGtobmJhYmZpaG9kcWllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjY3MDYsImV4cCI6MjA5OTgwMjcwNn0._YzzFLG4Y0iF9cFQ9lbv2cUu3L76x-JJSpkmu5-YIy0";

// Public key for the Web Push VAPID keypair (see js/push.js) — safe to
// expose publicly, same trust level as the anon key above. The matching
// private key lives server-side only, in the app_secrets table (readable
// only by the send-push Edge Function's service-role client).
export const VAPID_PUBLIC_KEY = "BKmi1-1Ytinb51D-iqCLXs7jbB4KaG4NDKiiCuXVGkIGZuvqHK88tUb3UC9Ugsp50z9ZDanL9Q64QjFDp3DS82w";
