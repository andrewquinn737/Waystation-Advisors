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
//     client_name: string,
//     client_email: string,
//     intern_email: string,
//     date: "YYYY-MM-DD",
//     time: "HH:MM"       (24-hour, local to `timezone`),
//     timezone: string    (IANA zone, e.g. "America/New_York"),
//   }
//
// Response (JSON): { ok: true, calendly_event_uri } on success, or
// { error: string } on failure (still returned with a 200/4xx as appropriate
// so the frontend can show a friendly message).

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const CALENDLY_TOKEN = Deno.env.get("CALENDLY_TOKEN");
  const CALENDLY_EVENT_TYPE_URI = Deno.env.get("CALENDLY_EVENT_TYPE_URI");
  if (!CALENDLY_TOKEN || !CALENDLY_EVENT_TYPE_URI) {
    return jsonResponse(
      { error: "Calendly integration isn't configured yet (missing server secrets)." },
      500
    );
  }

  let body: {
    client_name?: string;
    client_email?: string;
    intern_email?: string;
    date?: string;
    time?: string;
    timezone?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  const { client_name, client_email, intern_email, date, time, timezone } = body;
  if (!client_email || !date || !time || !timezone) {
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
