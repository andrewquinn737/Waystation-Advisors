// telnyx-webhook — Telnyx Call Control events (verified by ed25519 signature, not a Supabase JWT).
//
// 1. Outbound in-app calls (WebRTC): call.answered / call.hangup keep calls.answered_at / ended_at
//    authoritative (matched on calls.telnyx_call_id = Telnyx call_session_id).
// 2. Inbound callbacks to a pool number (needs the numbers' inbound routing pointed at a Telnyx Call
//    Control application whose webhook is this function; its id is app_secrets.TELNYX_CALLBACK_APP_ID):
//      SCREEN: only a caller we dialed EARLIER TODAY (Mountain time) is accepted — outbound call to that number
//      today, else a dial with that phone contacted today (match_callback_today). Anyone else is rejected
//      (this blocks the autodialer traffic) and logged as 'rejected'.
//      AFTER HOURS (before 8am / from 7pm in the owner's local time): answered, straight to voicemail + a callback task.
//      Otherwise: push notification "Callback incoming: NAME - COMPANY" -> ring the rep who called them (15 s;
//      a whisper tells them who it is, press any key to connect, so a personal voicemail never answers an owner)
//      -> their team lead (15 s; independent leads go to the main admin) -> voicemail (recorded only when the
//      caller's state is not all-party/unknown) -> a callback_tasks row (escalates on a schedule, see
//      callback_tasks_escalate()).
//      THE OWNER'S CALL IS NOT ANSWERED while the rep's phone is being rung and whispered to: the owner hears
//      ordinary ringing (not silence, which made them hang up before the rep could press the key). Only when the
//      rep presses a key is the owner's call answered and bridged to the rep; voicemail answers it at the end.
// Nothing is ever recorded or transcribed for an all-party/unknown-state caller.
import { createClient } from "npm:@supabase/supabase-js@2";
import { callAllowed } from "../_shared/testCallLock.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TELNYX = "https://api.telnyx.com/v2";
const ok = () => new Response("ok", { status: 200 });

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = (o: unknown) => btoa(JSON.stringify(o));
const dec = (s?: string) => { try { return s ? JSON.parse(atob(s)) : null; } catch { return null; } };
const clean = (s?: string | null) => String(s || "").replace(/[^A-Za-z0-9 .,'&-]/g, " ").slice(0, 60);

let secretCache: Record<string, string> | null = null;
async function secrets() {
  if (secretCache) return secretCache;
  const { data } = await db.from("app_secrets").select("key, value").in("key", ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY", "TELNYX_CALLBACK_APP_ID"]);
  secretCache = Object.fromEntries((data || []).map((r: { key: string; value: string }) => [r.key, (r.value || "").trim()]));
  return secretCache;
}
async function tx(path: string, body: unknown) {
  const s = await secrets();
  const r = await fetch(TELNYX + path, { method: "POST", headers: { Authorization: `Bearer ${s.TELNYX_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) console.error("telnyx", path, r.status, (await r.clone().text()).slice(0, 200));
  return r;
}
const act = (id: string, a: string, body: unknown = {}) => tx(`/calls/${id}/actions/${a}`, body);
const setInbound = (id: string, patch: Record<string, unknown>) => db.from("inbound_calls").update(patch).eq("id", id);

// who to ring, in order: the intern, then their team lead (independent leads -> main admin)
async function legTargets(userId: string | null, fallback: string | null) {
  const out: { who: "intern" | "lead"; user: string; phone: string }[] = [];
  const uid = userId || fallback;
  if (!uid) return out;
  const { data: me } = await db.from("profiles").select("id, phone, role, team_id").eq("id", uid).maybeSingle();
  if (me?.phone && /^\+1[2-9]\d{9}$/.test(me.phone)) out.push({ who: "intern", user: me.id, phone: me.phone });
  let lead: { id: string; phone: string | null } | null = null;
  if (me?.role === "intern" && me.team_id) {
    // the team's lead: its primary lead, else one who leads it as an extra team
    const { data } = await db.from("profiles").select("id, phone").eq("team_id", me.team_id).eq("role", "team_lead").limit(1).maybeSingle();
    lead = data;
    if (!lead) {
      const { data: ex } = await db.from("team_lead_teams").select("profile_id").eq("team_id", me.team_id).limit(1).maybeSingle();
      if (ex) {
        const { data: l2 } = await db.from("profiles").select("id, phone").eq("id", ex.profile_id).eq("role", "team_lead").maybeSingle();
        lead = l2;
      }
    }
  }
  if (!lead && me?.role !== "admin") {
    const { data } = await db.from("profiles").select("id, phone").eq("role", "admin").order("created_at").limit(1).maybeSingle();
    lead = data;
  }
  if (lead?.phone && /^\+1[2-9]\d{9}$/.test(lead.phone) && lead.id !== me?.id) out.push({ who: "lead", user: lead.id, phone: lead.phone });
  return out;
}

async function dialLeg(ib: string, a: string, pool: string, idx: number) {
  const { data: row } = await db.from("inbound_calls").select("matched_user_id").eq("id", ib).single();
  const { data: pn } = await db.from("caller_numbers").select("fallback_user_id").eq("e164", pool).maybeSingle();
  const targets = await legTargets(row?.matched_user_id, pn?.fallback_user_id || null);
  const t = targets[idx];
  if (!t) return voicemail(ib, a, false);
  if (!callAllowed(t.phone, t.user)) return dialLeg(ib, a, pool, idx + 1); // TEST call lock: never ring a non-allowlisted phone
  const s = await secrets();
  await tx("/calls", { connection_id: s.TELNYX_CALLBACK_APP_ID, to: t.phone, from: pool, timeout_secs: 15, client_state: enc({ ib, ph: "b", a, pool, idx, who: t.who, uid: t.user }) });
}

// The owner's call is still ringing (unanswered) when nobody connected: answer it now, then take the message.
async function voicemail(ib: string, a: string, answered: boolean) {
  if (!answered) {
    await act(a, "answer", { client_state: enc({ ib, ph: "vma", a }) });
    return;
  }
  const { data: row } = await db.from("inbound_calls").select("*").eq("id", ib).single();
  await setInbound(ib, { answered_leg: "voicemail", answered_at: new Date().toISOString() });
  const { data: consent } = await db.rpc("call_consent", { p_to: row.from_number, p_state: row.owner_state });
  const record = consent?.decision === "record";
  await db.from("callback_tasks").insert({
    kind: record ? "voicemail" : "missed_inbound", owner_number: row.from_number, last_call_id: row.matched_call_id,
    inbound_call_id: ib, assigned_to: row.matched_user_id, due_at: new Date().toISOString(),
  });
  if (row.matched_user_id) {
    await db.rpc("create_notification", { p_user_id: row.matched_user_id, p_message: `Missed callback from ${row.owner_name || row.from_number}${row.company_name ? " - " + row.company_name : ""}. Call them back.`, p_type: "callback_missed" });
  }
  await act(a, "speak", {
    payload: record ? "No one is available right now. Please leave your name and number after the tone, and we will call you back." : "No one is available right now. Please try again later. Goodbye.",
    voice: "female", language: "en-US", client_state: enc({ ib, ph: record ? "vm" : "end", a }),
  });
}

async function onIncoming(p: Record<string, any>) {
  const pool = p.to as string, from = p.from as string;
  const { data: pn } = await db.from("caller_numbers").select("e164").eq("e164", pool).maybeSingle();
  if (!pn) return; // not one of our pool numbers
  const { data: dup } = await db.from("inbound_calls").select("id").eq("telnyx_call_id", p.call_session_id).maybeSingle();
  if (dup) return;
  // SCREEN: only someone we dialed earlier today gets through.
  const { data: m } = await db.rpc("match_callback_today", { p_from: from });
  const hit = m?.[0];
  if (!hit) {
    await db.from("inbound_calls").insert({ telnyx_call_id: p.call_session_id, from_number: from, to_number: pool, match_method: "none", answered_leg: "rejected", ended_at: new Date().toISOString() });
    await act(p.call_control_id, "reject", { cause: "USER_BUSY" });
    return;
  }
  const { data: after } = await db.rpc("owner_after_hours", { p_state: hit.owner_state });
  const { data: row } = await db.from("inbound_calls").insert({
    telnyx_call_id: p.call_session_id, from_number: from, to_number: pool, matched_call_id: hit.call_id || null,
    matched_user_id: hit.user_id || null, match_method: hit.method || "none", owner_name: hit.owner_name || null,
    company_name: hit.company_name || null, owner_state: hit.owner_state || null, after_hours: !!after,
  }).select("id").single();
  if (!row) return;
  // The "who is calling" heads-up: a push notification the moment the phone starts ringing.
  if (hit.user_id && !after) {
    await db.rpc("create_notification", { p_user_id: hit.user_id, p_message: `Callback incoming: ${hit.owner_name || from}${hit.company_name ? " - " + hit.company_name : ""}`, p_type: "callback_incoming" });
  }
  if (after) {
    // after hours: answer and take a message
    await act(p.call_control_id, "answer", { client_state: enc({ ib: row.id, ph: "a", pool }) });
    return;
  }
  // In hours: leave the owner's call UNANSWERED (they hear normal ringing) while the rep's phone is rung.
  await dialLeg(row.id, p.call_control_id, pool, 0);
}

async function handle(ev: string, p: Record<string, any>) {
  let cs = dec(p.client_state);

  if (ev === "call.initiated" && p.direction === "incoming") return onIncoming(p);

  // The owner's call has no client_state until we answer it: if it ends while still unanswered, find it by session.
  if (!cs?.ib && ev === "call.hangup" && p.direction === "incoming" && p.call_session_id) {
    const { data: r } = await db.from("inbound_calls").select("id").eq("telnyx_call_id", p.call_session_id).maybeSingle();
    if (r) cs = { ib: r.id, ph: "a" };
  }

  if (!cs?.ib) { // outbound in-app call (WebRTC): keep timestamps authoritative
    if (!p.call_session_id) return;
    if (ev === "call.answered") await db.from("calls").update({ answered: true, answered_at: new Date().toISOString() }).eq("telnyx_call_id", p.call_session_id).is("answered_at", null);
    if (ev === "call.hangup") await db.from("calls").update({ ended_at: new Date().toISOString() }).eq("telnyx_call_id", p.call_session_id).is("ended_at", null);
    return;
  }

  const ib = cs.ib as string;
  if (ev === "call.answered" && cs.ph === "a") { // after hours only: the owner's leg is up
    return voicemail(ib, p.call_control_id, true);
  }
  if (ev === "call.answered" && cs.ph === "vma") return voicemail(ib, p.call_control_id, true); // answered to take a message
  if (ev === "call.answered" && cs.ph === "conn") { // the rep pressed a key and the owner's call is now answered: join them
    const r = await act(p.call_control_id, "bridge", { call_control_id: cs.b });
    if (r.ok) {
      await setInbound(ib, { answered_at: new Date().toISOString(), answered_by: cs.uid, answered_leg: cs.who === "lead" ? "lead_cell" : "intern_cell", [cs.who === "lead" ? "lead_ring_s" : "intern_ring_s"]: 0 });
    } else {
      await act(cs.b, "speak", { payload: "Sorry, the connection failed. Please call the owner back.", voice: "female", language: "en-US", client_state: enc({ ib, ph: "bend" }) });
    }
    return;
  }
  if (ev === "call.answered" && cs.ph === "b") { // a cell picked up: whisper who it is, press any key to connect
    const { data: row } = await db.from("inbound_calls").select("owner_name, company_name").eq("id", ib).single();
    const who = row?.owner_name || row?.company_name ? `Waystation callback from ${clean(row.owner_name) || "an owner"}${row.company_name ? ", " + clean(row.company_name) : ""}.` : "Waystation callback from a business owner.";
    // b = this cell leg's own id, so the owner's call can be bridged to it once it is answered
    const state = enc({ ...cs, b: p.call_control_id });
    return act(p.call_control_id, "gather_using_speak", {
      payload: `${who} Press any key to connect.`, voice: "female", language: "en-US", valid_digits: "0123456789*#", minimum_digits: 1, maximum_digits: 1, timeout_millis: 10000,
      client_state: state,
    });
  }
  if (ev === "call.gather.ended" && cs.ph === "b") {
    if (String(p.digits || "") !== "") {
      const { data: row } = await db.from("inbound_calls").select("ended_at, answered_leg").eq("id", ib).single();
      if (row?.ended_at || row?.answered_leg === "abandoned") { // the owner gave up while the rep was picking up
        await act(p.call_control_id, "speak", { payload: "Sorry, the caller hung up. A callback reminder has been saved for you.", voice: "female", language: "en-US", client_state: enc({ ib, ph: "bend" }) });
        return;
      }
      // answer the owner's (still ringing) call; it is bridged to this leg when call.answered(conn) arrives
      const r = await act(cs.a, "answer", { client_state: enc({ ib, ph: "conn", b: p.call_control_id, who: cs.who, uid: cs.uid }) });
      if (!r.ok) await act(p.call_control_id, "speak", { payload: "Sorry, the caller hung up. A callback reminder has been saved for you.", voice: "female", language: "en-US", client_state: enc({ ib, ph: "bend" }) });
    } else {
      await act(p.call_control_id, "hangup", {});
    }
    return;
  }
  if (ev === "call.speak.ended" && cs.ph === "bend") return act(p.call_control_id, "hangup", {});
  if (ev === "call.speak.ended" && cs.ph === "vm") return act(cs.a, "record_start", { format: "mp3", channels: "single", play_beep: true, client_state: enc({ ib, ph: "rec" }) });
  if (ev === "call.speak.ended" && cs.ph === "end") return act(cs.a, "hangup", {});
  if (ev === "call.recording.saved") {
    const url = p.recording_urls?.mp3 || p.public_recording_urls?.mp3 || "";
    if (url) await db.from("callback_tasks").update({ note: `Voicemail recording: ${url}` }).eq("inbound_call_id", ib);
    return;
  }
  if (ev === "call.hangup" && cs.ph === "b") { // that cell leg ended: if nobody connected, try the next one
    const { data: row } = await db.from("inbound_calls").select("answered_leg, ended_at").eq("id", ib).single();
    if (row?.answered_leg || row?.ended_at) return;
    return dialLeg(ib, cs.a, cs.pool, (cs.idx ?? 0) + 1);
  }
  if (ev === "call.hangup" && (cs.ph === "a" || cs.ph === "conn" || cs.ph === "vma" || cs.ph === "rec" || cs.ph === "vm" || cs.ph === "end") && p.direction !== "outgoing") {
    const { data: row } = await db.from("inbound_calls").select("answered_leg, matched_user_id, from_number, ended_at").eq("id", ib).single();
    if (row?.ended_at) return;
    await setInbound(ib, { ended_at: new Date().toISOString(), ...(row?.answered_leg ? {} : { answered_leg: "abandoned" }) });
    if (!row?.answered_leg) {
      await db.from("callback_tasks").insert({ kind: "missed_inbound", owner_number: row?.from_number, inbound_call_id: ib, assigned_to: row?.matched_user_id, due_at: new Date().toISOString() });
      if (row?.matched_user_id) {
        await db.rpc("create_notification", { p_user_id: row.matched_user_id, p_message: `Missed callback from ${row?.from_number}. Call them back.`, p_type: "callback_missed" });
      }
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = await req.text();
  const sig = req.headers.get("telnyx-signature-ed25519") || "";
  const ts = req.headers.get("telnyx-timestamp") || "";
  const s = await secrets();
  try {
    if (!sig || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300 || !s.TELNYX_PUBLIC_KEY) return new Response("unauthorized", { status: 401 });
    const key = await crypto.subtle.importKey("raw", b64(s.TELNYX_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
    const good = await crypto.subtle.verify("Ed25519", key, b64(sig), new TextEncoder().encode(`${ts}|${raw}`));
    if (!good) return new Response("unauthorized", { status: 401 });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const evt = JSON.parse(raw)?.data;
    if (evt?.event_type) await handle(evt.event_type, evt.payload || {});
  } catch (e) {
    console.error("webhook error", String(e)); // always 200 so Telnyx doesn't retry-storm
  }
  return ok();
});
