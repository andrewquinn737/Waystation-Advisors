import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// Invoked only by the notifications_send_push Postgres trigger (see
// supabase/schema.sql / the push_notifications_infra migration), via
// pg_net's net.http_post() -- never called directly by any client. Since
// that call has no end-user JWT to verify (it's a server-to-server call
// from inside our own database), this function is deployed with
// verify_jwt=false and instead checks the x-internal-secret header against
// app_secrets.internal_call_secret, which only the trigger function knows
// (it reads it from the same locked-down table).
//
// app_secrets is a stand-in for real Edge Function secrets: there was no
// tool available to set a private env var directly, so the VAPID keypair
// and this shared secret live in a table with RLS enabled and zero
// policies -- unreachable via PostgREST/anon or authenticated clients, only
// readable here via the service-role key.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: secretRows, error: secretsErr } = await admin
    .from("app_secrets")
    .select("key, value")
    .in("key", ["vapid_public_key", "vapid_private_key", "vapid_subject", "internal_call_secret"]);
  if (secretsErr) {
    console.error("Failed to load app_secrets", secretsErr);
    return new Response("Internal error", { status: 500 });
  }
  const secrets = Object.fromEntries((secretRows || []).map((r) => [r.key, r.value]));

  const providedSecret = req.headers.get("x-internal-secret");
  if (!providedSecret || providedSecret !== secrets.internal_call_secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { user_id, message } = await req.json();
  if (!user_id || !message) {
    return new Response("Missing user_id/message", { status: 400 });
  }

  webpush.setVapidDetails(secrets.vapid_subject, secrets.vapid_public_key, secrets.vapid_private_key);

  const { data: subs, error: subsErr } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", user_id);
  if (subsErr) {
    console.error("Failed to load push_subscriptions", subsErr);
    return new Response("Internal error", { status: 500 });
  }

  const payload = JSON.stringify({ title: "Waystation Advisors", body: message });

  const results = await Promise.allSettled(
    (subs || []).map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (err: any) {
        // 404/410 = the push service says this subscription is gone (user
        // uninstalled, revoked permission, etc.) -- clean it up so we stop
        // trying it forever. Any other error (network blip, etc.) is left
        // alone so a transient failure doesn't delete a good subscription.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await admin.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          throw err;
        }
      }
    })
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length) console.error("Some push sends failed", failures);

  return new Response(JSON.stringify({ sent: (subs || []).length, failed: failures.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
