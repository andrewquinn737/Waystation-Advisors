// "History" for one lead's copy: the last revisions from copy_revisions (who/what changed it and when).
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { msg } from "./copyCommon.js";

const SOURCE = { manual: "Edited by hand", claude_connector: "Rewritten by Claude", import: "Imported" };
const words = (t) => String(t || "").trim().split(/\s+/).filter(Boolean).length;
const clip = (t, n = 60) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// One short line per changed field.
export function diffSummary(before, after) {
  const b = before || {}, a = after || {}, out = [];
  if ((b.subject || "") !== (a.subject || "")) out.push(`Subject: "${clip(b.subject)}" → "${clip(a.subject)}"`);
  if ((b.email_1 || "") !== (a.email_1 || "")) out.push(`Email 1: ${words(b.email_1)} → ${words(a.email_1)} words`);
  if ((b.email_2 || "") !== (a.email_2 || "")) out.push(`Follow-up: ${words(b.email_2)} → ${words(a.email_2)} words`);
  return out;
}

const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };

export async function loadHistoryHTML(dialId) {
  const { data, error } = await supabase.from("copy_revisions").select("id, source, created_at, before, after")
    .eq("dial_id", dialId).order("created_at", { ascending: false }).limit(5);
  if (error) return `<div class="error-msg">Could not load history: ${escapeHtml(msg(error))}</div>`;
  if (!data?.length) return `<div class="cr-hist-empty">No changes recorded yet.</div>`;
  return `<ul class="cr-hist-list">${data.map((r) => {
    const lines = diffSummary(r.before, r.after);
    return `<li><b>${escapeHtml(SOURCE[r.source] || r.source)}</b> <span class="cr-hist-when">${escapeHtml(when(r.created_at))}</span>${
      lines.length ? `<div class="cr-hist-diff">${lines.map(escapeHtml).join("<br>")}</div>` : ""}</li>`;
  }).join("")}</ul>`;
}
