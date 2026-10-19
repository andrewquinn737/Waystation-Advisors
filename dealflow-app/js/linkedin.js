// LinkedIn messaging on Dials. LinkedIn has no way for this app to see whether a message was really
// sent, so:
//  - Tapping a dial's LinkedIn message button copies your template (filled in), opens their profile,
//    and logs a PENDING touch. Pending counts for nothing.
//  - A message only COUNTS (Contacted today, Profile stats, reports) once your own LinkedIn data
//    export (messages.csv) shows you sent it to that dial's profile — "Verify LinkedIn messages" in
//    Dials > Advanced reads that file here (in the browser; the file is never uploaded) and calls
//    record_linkedin_sends() for each match.
import { supabase } from "./supabaseClient.js";
import { substitutePersonalizedTokens } from "./advancedSettings.js";

export function normalizeLinkedInUrl(u) {
  const m = String(u || "").toLowerCase().match(/linkedin\.com\/(in|pub|company)\/([^/?#\s"]+)/);
  return m ? `linkedin.com/${m[1]}/${decodeURIComponent(m[2]).replace(/\/+$/, "")}` : "";
}

function toast(text) {
  document.getElementById("linkedinToast")?.remove();
  const el = Object.assign(document.createElement("div"), { id: "linkedinToast", className: "linkedin-toast", textContent: text });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// Tap on a dial's LinkedIn message button (js/dials.js delegates the click here).
export async function onLinkedInTap(dial, profile) {
  const norm = normalizeLinkedInUrl(dial.linkedin);
  if (!norm) return;
  window.open("https://www." + norm, "_blank", "noopener"); // inside the tap, so it isn't blocked
  const msg = profile.linkedin_template ? substitutePersonalizedTokens(profile.linkedin_template, dial, profile) : "";
  let copied = false;
  if (msg) { try { await navigator.clipboard.writeText(msg); copied = true; } catch { /* ignore */ } }
  supabase.from("linkedin_touches").insert({
    dial_id: dial.id, list_id: dial.list_id, company_name: dial.company_name || null, contact_name: dial.full_name || null,
    profile_url: dial.linkedin, status: "pending", message_preview: msg ? msg.slice(0, 200) : null,
  }).then(() => {}, () => {});
  toast((copied ? "Message copied — paste it into LinkedIn. " : "Opened their profile. ") + "It counts once your LinkedIn export confirms it was sent.");
}

function modal(innerHTML) {
  const el = Object.assign(document.createElement("div"), { className: "modal-backdrop" });
  el.style.zIndex = "160";
  el.innerHTML = `<div class="modal">${innerHTML}</div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => { if (e.target === el) el.remove(); });
  return el;
}

export function openLinkedInTemplateEditor(profile) {
  const el = modal(`
    <h2>LinkedIn message</h2>
    <p class="help-text">Tapping a dial's LinkedIn message button copies this, filled in for that dial, then opens their profile.</p>
    <textarea class="personalized-email-textarea" placeholder="Hi (Seller name), I'm (Your name) with Waystation Advisors..."></textarea>
    <div class="personalized-email-tokens">
      <button type="button" class="personalized-email-token">(Company name)</button>
      <button type="button" class="personalized-email-token">(Seller name)</button>
      <button type="button" class="personalized-email-token">(Your name)</button>
    </div>
    <div class="error-msg hidden"></div>
    <div class="form-actions"><button type="button" class="btn secondary" data-x="cancel">Cancel</button><button type="button" class="btn" data-x="save">Save</button></div>`);
  const ta = el.querySelector("textarea");
  ta.value = profile.linkedin_template || "";
  el.querySelectorAll(".personalized-email-token").forEach((b) => b.addEventListener("click", () => {
    const s = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + b.textContent + ta.value.slice(ta.selectionEnd ?? s);
    ta.focus();
  }));
  el.querySelector('[data-x="cancel"]').addEventListener("click", () => el.remove());
  el.querySelector('[data-x="save"]').addEventListener("click", async () => {
    const v = ta.value.trim() || null;
    const { error } = await supabase.from("profiles").update({ linkedin_template: v }).eq("id", profile.id);
    if (error) { const e = el.querySelector(".error-msg"); e.textContent = error.message; e.classList.remove("hidden"); return; }
    profile.linkedin_template = v;
    el.remove();
  });
}

// ---- verification from the LinkedIn data export ----
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

async function myDialsByUrl(profile) {
  const map = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("dials").select("id, linkedin").eq("created_by", profile.id).not("linkedin", "is", null).neq("linkedin", "").range(from, from + 999);
    if (error) throw error;
    (data || []).forEach((d) => { const k = normalizeLinkedInUrl(d.linkedin); if (k) map.set(k, [...(map.get(k) || []), d.id]); });
    if (!data || data.length < 1000) break;
  }
  return map;
}

export async function verifyLinkedInExport(file, profile, days = 60) {
  const rows = parseCsv(await file.text());
  const head = (rows.shift() || []).map((h) => h.trim().toUpperCase());
  const col = (n) => head.indexOf(n);
  const iFrom = col("SENDER PROFILE URL"), iTo = col("RECIPIENT PROFILE URLS"), iDate = col("DATE"), iBody = col("CONTENT");
  if (iFrom < 0 || iTo < 0 || iDate < 0) throw new Error("This doesn't look like LinkedIn's messages.csv.");
  const counts = new Map();
  rows.forEach((r) => { const k = normalizeLinkedInUrl(r[iFrom]); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
  const me = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; // you're in every conversation
  if (!me) throw new Error("Couldn't find your messages in this file.");
  const dials = await myDialsByUrl(profile);
  const since = Date.now() - days * 86400000;
  const out = [];
  rows.forEach((r) => {
    if (normalizeLinkedInUrl(r[iFrom]) !== me) return;
    const when = new Date(String(r[iDate] || "").replace(" UTC", "Z").replace(" ", "T"));
    if (isNaN(when) || when.getTime() < since) return;
    new Set(String(r[iTo] || "").split(/[\s,;]+/).map(normalizeLinkedInUrl).filter(Boolean)).forEach((k) =>
      (dials.get(k) || []).forEach((id) => out.push({ dial_id: id, sent_at: when.toISOString(), preview: (r[iBody] || "").slice(0, 200) })));
  });
  const total = { verified: 0, already_counted: 0, not_your_dials: 0 };
  for (let i = 0; i < out.length; i += 100) {
    const { data, error } = await supabase.rpc("record_linkedin_sends", { p_rows: out.slice(i, i + 100) });
    if (error) throw error;
    Object.keys(total).forEach((k) => (total[k] += data?.[k] || 0));
  }
  return { found: out.length, ...total };
}

export function openLinkedInVerify(profile) {
  const el = modal(`
    <h2>Verify LinkedIn messages</h2>
    <p class="help-text">Only messages LinkedIn confirms were sent are counted. On LinkedIn: <b>Settings &amp; Privacy → Data privacy → Get a copy of your data → Messages</b>. When the download arrives, unzip it and choose <b>messages.csv</b> here. It's read in your browser only; just the matching sends are recorded (last 60 days, to dials with a LinkedIn link).</p>
    <input type="file" accept=".csv,text/csv" />
    <div class="help-text" data-x="result"></div>
    <div class="form-actions"><button type="button" class="btn secondary" data-x="close">Close</button></div>`);
  const result = el.querySelector('[data-x="result"]');
  el.querySelector('[data-x="close"]').addEventListener("click", () => el.remove());
  el.querySelector("input").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    result.textContent = "Reading…";
    try {
      const r = await verifyLinkedInExport(f, profile);
      result.innerHTML = `Found ${r.found} sent message${r.found === 1 ? "" : "s"} to your dials: <b>${r.verified}</b> newly counted, ${r.already_counted} already counted.`;
    } catch (err) { result.textContent = err.message || String(err); }
  });
}
