// Standalone connection for the temporary page: no sign-in, no session. Access is by a private key that travels in the
// x-wp-key header (the database checks it, see schema.sql). The key is saved in this browser the first time the private
// link (.../waproject/#key=...) is opened.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://jabjrhkhnbabfihodqie.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphYmpyaGtobmJhYmZpaG9kcWllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMjY3MDYsImV4cCI6MjA5OTgwMjcwNn0._YzzFLG4Y0iF9cFQ9lbv2cUu3L76x-JJSpkmu5-YIy0";

export function readKey() {
  try {
    const m = /[#&]key=([A-Za-z0-9]+)/.exec(location.hash);
    if (m) { localStorage.setItem("wp_key", m[1]); history.replaceState(null, "", location.pathname + location.search); }
    return localStorage.getItem("wp_key") || "";
  } catch { return ""; }
}
export const accessKey = readKey();
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { "x-wp-key": accessKey } },
});
