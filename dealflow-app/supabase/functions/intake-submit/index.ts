// Supabase Edge Function: intake-submit
//
// Called right after a questionnaire-flow seller's client is created with its intro call booked (the short
// pre-call form in js/intakeForm.js, saved on clients.intake_form). Loads the client + form from the database
// (never the request) and sends the lead to:
//  1. Slack — ONE "New lead:" message, only the FIRST time (resending never re-posts it).
//  2. The leads Google Sheet, through the Apps Script web app (app_secrets 'sheet_webhook_url' +
//     'sheet_webhook_token'). Every send is an UPSERT: the script finds the existing row by company name
//     (clients.intake_sheet_match = the name it was last written under, so a renamed company still finds its
//     row) and only updates cells whose value changed; it adds a new row only when no row matches. Only the
//     sheet's own columns are sent.
//
// What goes out: the company information plus the form's employees, years in business, email, and (Slack only,
// the sheet has no column for them) willing / able to sell. "Not talking to other brokers" is never sent — a lead
// can't be booked unless it passes, and the sheet has no column for it.
//
// Request: { client_id }.  Response: { ok, slack, sheet, errors } where slack = sent | already_sent |
// not_configured | failed and sheet = sent | updated | not_configured | failed.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const joined = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? "").trim());

// Dates go to the sheet as M/D/YYYY text so Sheets reads a plain calendar date.
function sheetDate(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(joined(v));
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : joined(v);
}

// The form's employee ranges split at 40; the sheet's Employees column uses its own buckets.
function sheetEmployees(v: string): string {
  if (v === "26–40" || v === "41–50") return "26–50";
  return v;
}

const FORM_LABELS: [string, string][] = [
  ["employees", "Employees"], ["years_in_business", "Years in Business"], ["willing_to_sell", "Willing to sell their data"], ["able_to_sell", "Able to sell their data"],
];
function line(label: string, value: unknown): string | null {
  const v = joined(value);
  return v ? `${label}: ${esc(v)}` : null;
}

// The sheet's columns, exactly as named in its header row. `update` (a resend): never send Date Called, and only
// send Status if there is one, so a Status someone set in the sheet isn't reset.
function sheetRow(f: Record<string, unknown>, client: Record<string, unknown>, update: boolean): Record<string, string> {
  const row: Record<string, string> = {
    "Date Called": sheetDate(f.date_called),
    "Status": update ? "" : "Form Submitted",
    "Company Name": joined(client.company_name),
    "Website": joined(client.website),
    "Contact Name": joined(client.full_name),
    "Business Email": joined(f.contact_email) || joined(client.email),
    "Phone Number": joined(client.mobile_phone) || joined(client.company_phone),
    "Employees": sheetEmployees(joined(f.employees)),
    "Years in Business": joined(f.years_in_business),
  };
  if (update) delete row["Date Called"];
  return row;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({ error: "Missing authorization." }, 401);
    const { data: callerData, error: callerErr } = await admin.auth.getUser(jwt);
    if (callerErr || !callerData?.user) return json({ error: "Your session isn't valid — please sign in again." }, 401);
    const callerId = callerData.user.id;

    let body: { client_id?: string };
    try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
    if (!body.client_id) return json({ error: "client_id is required." }, 400);

    const { data: client } = await admin.from("clients").select("*").eq("id", body.client_id).maybeSingle();
    if (!client) return json({ error: "Client not found." }, 404);
    const { data: caller } = await admin.from("profiles").select("role, team_id").eq("id", callerId).single();
    const { data: owner } = await admin.from("profiles").select("full_name, role, team_id").eq("id", client.created_by).maybeSingle();
    const allowed =
      client.created_by === callerId || caller?.role === "admin" ||
      (caller?.role === "team_lead" && !!caller.team_id && owner?.team_id === caller.team_id && (owner?.role === "intern" || owner?.role === "independent_lead"));
    if (!allowed) return json({ error: "You don't have access to this client." }, 403);
    if (client.client_type !== "seller" || client.tracking_flow !== "questionnaire") return json({ error: "This client doesn't use the intake form." }, 400);
    if (!client.intake_form) return json({ error: "This client has no form on file." }, 400);

    const { data: secrets } = await admin.from("app_secrets").select("key, value").in("key", ["slack_webhook_url", "sheet_webhook_url", "sheet_webhook_token"]);
    const secret = (k: string) => ((secrets || []).find((r: { key: string; value: string }) => r.key === k)?.value || "").trim();
    const slackUrl = secret("slack_webhook_url"), sheetUrl = secret("sheet_webhook_url"), sheetToken = secret("sheet_webhook_token");

    const f = client.intake_form as Record<string, unknown>;
    const result: { slack: string; sheet: string; errors: Record<string, string> } = { slack: "not_configured", sheet: "not_configured", errors: {} };
    const stamps: Record<string, string> = {};
    const nowIso = new Date().toISOString();

    // ---- Slack: first send only ----
    if (client.intake_slack_at) {
      result.slack = "already_sent";
    } else if (slackUrl) {
      if (!/^https:\/\/hooks\.slack\.com\//.test(slackUrl)) {
        result.slack = "failed"; result.errors.slack = "The stored Slack webhook URL doesn't look right.";
      } else {
        const location = [client.city, client.state].filter(Boolean).join(", ");
        const lines = [
          line("Company", client.company_name), line("Website", client.website),
          line("Contact", client.full_name), line("Email", f.contact_email || client.email),
          line("Phone", client.mobile_phone || client.company_phone), line("Location", location),
          line("Industry", client.industry), line("Date called", f.date_called), line("Found by", owner?.full_name),
          ...FORM_LABELS.map(([k, label]) => line(label, f[k])),
        ].filter(Boolean);
        try {
          const res = await fetch(slackUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: ["New lead:", "", ...lines].join("\n") }) });
          if (res.ok) { result.slack = "sent"; stamps.intake_slack_at = nowIso; }
          else { result.slack = "failed"; result.errors.slack = `Slack refused the message (${res.status}).`; }
        } catch (e) { result.slack = "failed"; result.errors.slack = String(e); }
      }
    }

    // ---- Google Sheet: upsert by company name, every send ----
    if (sheetUrl && sheetToken) {
      if (!/^https:\/\/script\.google\.com\//.test(sheetUrl)) {
        result.sheet = "failed"; result.errors.sheet = "The stored sheet web-app URL doesn't look right.";
      } else {
        const update = !!client.intake_sheet_at;
        const row = sheetRow(f, client, update);
        try {
          const res = await fetch(sheetUrl, {
            method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow",
            body: JSON.stringify({ token: sheetToken, row, match: client.intake_sheet_match || row["Company Name"], upsert: true }),
          });
          let parsed: { ok?: boolean; error?: string; action?: string } = {};
          try { parsed = JSON.parse(await res.text()); } catch { /* HTML error page */ }
          if (res.ok && parsed.ok) {
            result.sheet = parsed.action === "updated" ? "updated" : "sent";
            stamps.intake_sheet_at = client.intake_sheet_at || nowIso;
            stamps.intake_sheet_match = row["Company Name"];
          } else {
            result.sheet = "failed"; result.errors.sheet = parsed.error || `The sheet script didn't accept the row (${res.status}).`;
          }
        } catch (e) { result.sheet = "failed"; result.errors.sheet = String(e); }
      }
    }

    const slackDone = result.slack === "sent" || result.slack === "already_sent";
    const sheetDone = result.sheet === "sent" || result.sheet === "updated";
    const anyConfigured = result.slack !== "not_configured" || result.sheet !== "not_configured";
    if (anyConfigured && (result.slack === "not_configured" || slackDone) && (result.sheet === "not_configured" || sheetDone)) {
      stamps.intake_notified_at = client.intake_notified_at || nowIso;
    }
    if (Object.keys(stamps).length) await admin.from("clients").update(stamps).eq("id", client.id);
    return json({ ok: true, ...result });
  } catch (e) {
    return json({ error: "Unexpected error: " + String(e) }, 500);
  }
});
