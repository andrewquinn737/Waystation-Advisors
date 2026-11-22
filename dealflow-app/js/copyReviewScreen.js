// Admin campaigns use { all: true }: every draft not yet started, problem ones first, each editable in place.
// "Fix emails": only the drafts the server check held back, each with its problem text and a Save button.
// Save writes the text, then asks the server (copy-gate) to check it again; a card that now passes disappears.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { runCopyGate } from "./copyGate.js";
import { $, msg } from "./copyCommon.js";

const FIELDS = [
  { key: "email_subject", label: "Subject", rows: 1 },
  { key: "email_1", label: "Email 1", rows: 7 },
  { key: "email_2", label: "Follow-up", rows: 5 },
];
const COLS = "id, full_name, company_name, email, email_subject, email_1, email_2, copy_ok, copy_errors, copy_warnings, copy_hash, seq_state";

async function loadHeld(listId, all) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("dials").select(COLS).eq("list_id", listId).eq("sequence", "email5")
      .eq("seq_state", "awaiting_copy").order("company_name", { ascending: true }).order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  if (!all) return out.filter((l) => !l.copy_ok);
  return out.sort((a, b) => (a.copy_ok ? 1 : 0) - (b.copy_ok ? 1 : 0));
}

export async function openCopyReview(list, { onChanged, all = false } = {}) {
  const title = all ? "Review emails" : "Fix emails";
  lockPageScroll();
  let changed = false;
  const panel = $(`<div class="cr-panel" role="dialog" data-list-id="${escapeHtml(String(list.id))}" aria-label="${escapeHtml(title)}">
    <div class="cr-head"><div class="cr-head-row"><div class="cr-head-t"><h2>${escapeHtml(title)}</h2>${list.name ? `<div class="cr-head-sub">${escapeHtml(list.name)}</div>` : ""}</div><button type="button" class="fs-close cr-close" aria-label="Close">&times;</button></div></div>
    <!-- Mount point for the in-app Claude chat panel (js/aiChat.js, added by another builder). Leave empty. -->
    <div id="aiChatMount"></div>
    <div class="cr-body"><div class="help-text">Loading...</div></div></div>`);
  document.body.appendChild(panel);
  const body = panel.querySelector(".cr-body");
  const close = () => { panel.remove(); unlockPageScroll(); document.removeEventListener("keydown", onKey); document.removeEventListener("ws:drafts-changed", onDrafts); if (changed) onChanged && onChanged(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  // "Edit with Claude" (aiChat.js) saved changes: reload the drafts
  const onDrafts = (e) => { if (e.detail?.listId === list.id) { changed = true; loadHeld(list.id, all).then(render).catch(() => {}); } };
  document.addEventListener("ws:drafts-changed", onDrafts);
  panel.querySelector(".cr-close").onclick = close;

  const issues = (l) => (l.copy_errors || []).map((e) => `<li class="e">${escapeHtml(e)}</li>`).join("") + (l.copy_warnings || []).map((w) => `<li class="w">${escapeHtml(w)}</li>`).join("");
  const card = (l) => `<div class="cr-card${l.copy_ok ? "" : " has-err"}" data-id="${l.id}">
    <div class="cr-card-top"><div><b>${escapeHtml(l.company_name || "(no company)")}</b><div class="cr-to">${escapeHtml(l.full_name || "")} &lt;${escapeHtml(l.email || "")}&gt;</div></div></div>
    <ul class="cr-issues">${issues(l) || (l.copy_ok ? "" : '<li class="w">Not checked yet</li>')}</ul>
    ${FIELDS.map((f) => `<label class="cr-field"><span>${f.label}</span><textarea data-f="${f.key}" rows="${f.rows}" spellcheck="true">${escapeHtml(l[f.key] || "")}</textarea></label>`).join("")}
    <div class="cr-card-foot"><div class="cr-save"></div><button type="button" class="btn cr-savebtn" style="min-height:44px">Save</button></div></div>`;

  function render(leads) {
    body.innerHTML = leads.length ? leads.map(card).join("")
      : `<div class="cr-done"><div class="cr-done-big">${all ? "No drafts to review" : "All fixed"}</div><button type="button" class="btn" id="crDone">Done</button></div>`;
    const d = body.querySelector("#crDone"); if (d) d.onclick = close;
  }
  body.addEventListener("click", async (e) => {
    const btn = e.target.closest(".cr-savebtn"); if (!btn) return;
    const el = btn.closest(".cr-card"), st = el.querySelector(".cr-save");
    const patch = Object.fromEntries([...el.querySelectorAll("textarea[data-f]")].map((t) => [t.dataset.f, t.value]));
    btn.disabled = true; st.className = "cr-save"; st.textContent = "Saving...";
    const { error } = await supabase.from("dials").update(patch).eq("id", el.dataset.id);
    if (error) { st.className = "cr-save bad"; st.textContent = "Not saved: " + msg(error); btn.disabled = false; return; }
    changed = true;
    try {
      await runCopyGate(list.id);
      const { data } = await supabase.from("dials").select(COLS).eq("id", el.dataset.id).single();
      if (all && data && data.seq_state === "awaiting_copy") {
        el.outerHTML = card(data);
        const n = body.querySelector(`.cr-card[data-id="${data.id}"] .cr-save`); n.className = data.copy_ok ? "cr-save ok" : "cr-save bad"; n.textContent = data.copy_ok ? "Saved. Passes the check." : "Saved, still has a problem.";
      } else if (data && data.seq_state === "awaiting_copy" && !data.copy_ok) {
        el.outerHTML = card(data);
        const n = body.querySelector(`.cr-card[data-id="${data.id}"] .cr-save`); n.className = "cr-save bad"; n.textContent = "Still has a problem.";
      } else { el.remove(); if (!body.querySelector(".cr-card")) render([]); }
    } catch (err) { st.className = "cr-save bad"; st.textContent = "Saved, but the check failed: " + msg(err); btn.disabled = false; }
  });

  try { render(await loadHeld(list.id, all)); }
  catch (e) { body.innerHTML = `<div class="error-msg">Could not load emails: ${escapeHtml(msg(e))}</div>`; }
}
