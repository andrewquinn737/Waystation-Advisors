// Supabase Edge Function: admin-create-account
//
// Called from js/profile.js (Teams popup > "+" > "Account") when an admin
// signs someone up. This has to run server-side with the SERVICE ROLE key —
// supabase.auth.admin.createUser() creates a new auth user WITHOUT swapping
// the caller's own browser session over to that new account, which is what
// would happen if we just called supabase.auth.signUp() client-side (the
// admin would get logged out and logged in as the person they just created).
// The service role key is never sent to the browser — it only exists here,
// using the SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars Supabase
// injects into every Edge Function automatically (no manual secret setup
// needed, unlike CALENDLY_TOKEN in schedule-intro-call).
//
// Request body (JSON):
//   { full_name: string, email: string, phone?: string, password: string }
//
// Response: { ok: true, user_id } on success, or { error: string }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Server isn't configured yet (missing Supabase service credentials)." }, 500);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return jsonResponse({ error: "Missing authorization." }, 401);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Identify the caller from their access token, then confirm they're an
  // admin before doing anything — this is the real access-control check
  // (the RLS policies on `profiles`/`teams` only govern direct table access,
  // not what this function is allowed to do with the service role key).
  const { data: callerData, error: callerErr } = await admin.auth.getUser(jwt);
  if (callerErr || !callerData?.user) {
    return jsonResponse({ error: "Your session isn't valid — please sign in again." }, 401);
  }

  const { data: callerProfile, error: callerProfileErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", callerData.user.id)
    .single();
  if (callerProfileErr || callerProfile?.role !== "admin") {
    return jsonResponse({ error: "Only admins can create accounts." }, 403);
  }

  let body: { full_name?: string; email?: string; phone?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  const full_name = (body.full_name || "").trim();
  const email = (body.email || "").trim();
  const phone = (body.phone || "").trim();
  const password = body.password || "";

  if (!full_name || !email || !password) {
    return jsonResponse({ error: "Full name, email, and password are required." }, 400);
  }
  if (password.length < 6) {
    return jsonResponse({ error: "Password must be at least 6 characters." }, 400);
  }

  // handle_new_user() (see supabase/schema.sql) fires on this insert and
  // creates the matching `profiles` row automatically — role defaults to
  // 'intern', team_id defaults to null (Unassigned interns).
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, phone: phone || null },
  });
  if (createErr) {
    // Supabase auth surfaces a duplicate email as either a specific error
    // code or a message like "A user with this email address has already
    // been registered" depending on version — check both so js/profile.js
    // can reliably show its own inline red message instead of this raw one.
    const isDuplicateEmail =
      createErr.code === "email_exists" || /already\s+(been\s+)?registered|already\s+exists|already\s+in\s+use/i.test(createErr.message || "");
    if (isDuplicateEmail) {
      return jsonResponse({ error: createErr.message, code: "email_exists" }, 400);
    }
    return jsonResponse({ error: createErr.message }, 400);
  }

  // Best-effort: store the plaintext temp password (admin-only readable, see
  // profile_temp_passwords in supabase/schema.sql) so an admin can look it up
  // later from the Teams popup's key icon. This is supplementary — a failure
  // here shouldn't fail the whole account-creation request, since the actual
  // login account was already created successfully above.
  const { error: pwErr } = await admin
    .from("profile_temp_passwords")
    .upsert({ profile_id: created.user?.id, temp_password: password, updated_at: new Date().toISOString() });
  if (pwErr) {
    console.error("Failed to store temp password for", created.user?.id, pwErr.message);
  }

  return jsonResponse({ ok: true, user_id: created.user?.id });
});
