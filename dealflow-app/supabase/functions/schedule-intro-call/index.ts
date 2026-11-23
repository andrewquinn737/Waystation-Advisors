// Supabase Edge Function: schedule-intro-call
//
// Called from js/introCall.js via `supabase.functions.invoke("schedule-intro-call", ...)`.
// Holds the Calendly credentials SERVER-SIDE (as secrets set in the Supabase
// dashboard) so the public static frontend never sees or stores them.
//
// Required secrets (set via `supabase secrets set` or the Supabase dashboard
// under Project Settings > Edge Functions > Secrets):
//   CALENDLY_TOKEN          — a Calendly Personal Access Token with at least
//                             the `scheduled_events:write` scope.
//   CALENDLY_EVENT_TYPE_URI — the full API URI of the "30min" intro-call
//                             event type, e.g.
//                             https://api.calendly.com/event_types/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
//                             (see the deployment notes for how to find this
//                             without ever typing the token into a chat).
//
// Request body (JSON), sent by the frontend:
//   {
//     client_id | dial_id: uuid   (the client / dial the call is for; the caller must own it, lead its owner, or be an admin)
//     client_name: string,
//     client_email: string,
//     (intern_email is ignored: the guest is always the signed-in caller's own profile email)
//     date: "YYYY-MM-DD",
//     time: "HH:MM"       (24-hour, local to `timezone`),
//     timezone: string    (IANA zone, e.g. "America/New_York"),
//   }
//
// Response (JSON): { ok: true, calendly_event_uri } on success, or
// { error: string } on failure (still returned with a 200/4xx as appropriate
// so the frontend can show a friendly message).

import { createClient } from "npm:@supabase/supabase-js@2";

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

// Converts a wall-clock date/time in an arbitrary IANA time zone to a UTC
// Date, using only Intl (no external tz database needed). Standard technique:
// format an initial UTC guess in the target zone, measure the offset, adjust.
function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(guessUtcMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;

  const asIfUtcInZoneMs = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  const offsetMs = asIfUtcInZoneMs - guessUtcMs;
  return new Date(guessUtcMs - offsetMs);
}

// Business rule: calls can only be booked Monday-Friday, 8:00 AM - 9:30 PM
// Mountain Time — enforced here (not just client-side in js/introCall.js)
// since client-side validation can be bypassed.
function isWithinBookableHours(utcDate: Date): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(utcDate)) map[p.type] = p.value;
  const weekday = map.weekday;
  const totalMin = Number(map.hour) * 60 + Number(map.minute);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  return isWeekday && totalMin >= 8 * 60 && totalMin <= 21 * 60 + 30;
}


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
// Best-effort per-person limit (instances are short lived, so this stops a loop, not a determined abuser; Calendly has its own limits).
const hits = new Map<string, number[]>();
function limited(uid: string): boolean {
  const now = Date.now(), recent = (hits.get(uid) || []).filter((t) => now - t < 60_000);
  recent.push(now); hits.set(uid, recent);
  return recent.length > 8;
}

// The caller must be a signed-in person (not just the public anon key) who owns the client / dial, leads its owner, or is an admin.
async function authorize(req: Request, body: Record<string, unknown>): Promise<{ email: string | null } | Response> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return jsonResponse({ error: "Sign in first." }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: u, error: ue } = await admin.auth.getUser(jwt);
  if (ue || !u?.user) return jsonResponse({ error: "Your session isn't valid. Please sign in again." }, 401);
  const { data: me } = await admin.from("profiles").select("id, role, email, team_id").eq("id", u.user.id).maybeSingle();
  if (!me) return jsonResponse({ error: "No account found for this login." }, 403);
  const clientId = typeof body.client_id === "string" ? body.client_id : "", dialId = typeof body.dial_id === "string" ? body.dial_id : "";
  if (!UUID.test(clientId) && !UUID.test(dialId)) return jsonResponse({ error: "client_id or dial_id is required." }, 400);
  let ownerId: string | null = null;
  if (UUID.test(clientId)) ownerId = (await admin.from("clients").select("created_by").eq("id", clientId).maybeSingle()).data?.created_by ?? null;
  else ownerId = (await admin.from("dials").select("created_by").eq("id", dialId).maybeSingle()).data?.created_by ?? null;
  if (!ownerId) return jsonResponse({ error: "That client was not found." }, 404);
  let ok = ownerId === me.id || me.role === "admin";
  if (!ok && me.role === "team_lead") {
    const { data: owner } = await admin.from("profiles").select("team_id, role").eq("id", ownerId).maybeSingle();
    const { data: teams } = await admin.rpc("my_team_ids", { uid: me.id });
    ok = !!owner?.team_id && ["intern", "independent_lead"].includes(owner.role) && Array.isArray(teams) && teams.includes(owner.team_id);
  }
  if (!ok) return jsonResponse({ error: "You can only schedule calls for your own clients." }, 403);
  if (limited(me.id)) return jsonResponse({ error: "Too many requests. Wait a minute and try again." }, 429);
  return { email: me.email || null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: {
    client_id?: string;
    dial_id?: string;
    client_name?: string;
    client_email?: string;
    date?: string;
    time?: string;
    timezone?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }
  const who = await authorize(req, body as Record<string, unknown>);
  if (who instanceof Response) return who;

  // Credentials: edge-function env secrets first, else the ones an admin saved under Admin > Settings > Connect Calendly
  // (app_secrets via the calendly_connect RPC). Automatic booking is simply "off" until one of them exists.
  let CALENDLY_TOKEN = Deno.env.get("CALENDLY_TOKEN");
  let CALENDLY_EVENT_TYPE_URI = Deno.env.get("CALENDLY_EVENT_TYPE_URI");
  if (!CALENDLY_TOKEN || !CALENDLY_EVENT_TYPE_URI) {
    try {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data } = await admin.from("app_secrets").select("key, value").in("key", ["CALENDLY_TOKEN", "CALENDLY_EVENT_TYPE_URI"]);
      for (const r of data || []) {
        if (r.key === "CALENDLY_TOKEN" && !CALENDLY_TOKEN) CALENDLY_TOKEN = r.value;
        if (r.key === "CALENDLY_EVENT_TYPE_URI" && !CALENDLY_EVENT_TYPE_URI) CALENDLY_EVENT_TYPE_URI = r.value;
      }
    } catch { /* fall through to the "not connected" answer */ }
  }
  if (!CALENDLY_TOKEN || !CALENDLY_EVENT_TYPE_URI) {
    return jsonResponse(
      { error: "Calendly isn't connected yet. An admin can connect it under Admin > Settings > Connect Calendly; until then enter the time by hand.", not_connected: true },
      200
    );
  }

  const { client_name, client_email, date, time, timezone } = body;
  const intern_email = who.email;   // never taken from the request
  if (!client_email || !EMAIL.test(client_email) || !date || !time || !timezone) {
    return jsonResponse({ error: "Missing required fields (client email, date, time, or time zone)." }, 400);
  }

  let startTimeUtc: Date;
  try {
    startTimeUtc = zonedTimeToUtc(date, time, timezone);
  } catch {
    return jsonResponse({ error: "Could not parse the date/time/time zone provided." }, 400);
  }

  if (!isWithinBookableHours(startTimeUtc)) {
    return jsonResponse(
      { error: "Calls can only be scheduled Monday–Friday, 8:00 AM – 9:30 PM Mountain Time. Please pick a different time." },
      400
    );
  }

  const calendlyBody: Record<string, unknown> = {
    event_type: CALENDLY_EVENT_TYPE_URI,
    start_time: startTimeUtc.toISOString(),
    invitee: {
      email: client_email,
      name: client_name || client_email,
      timezone,
    },
  };
  if (intern_email) {
    calendlyBody.event_guests = [intern_email];
  }

  const calendlyRes = await fetch("https://api.calendly.com/invitees", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CALENDLY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(calendlyBody),
  });

  const calendlyData = await calendlyRes.json().catch(() => ({}));

  if (!calendlyRes.ok) {
    const message =
      calendlyData?.message ||
      calendlyData?.title ||
      `Calendly declined the request (status ${calendlyRes.status}).`;
    return jsonResponse({ error: message }, 502);
  }

  return jsonResponse({
    ok: true,
    calendly_event_uri: calendlyData?.resource?.uri || calendlyData?.resource?.event || null,
  });
});
