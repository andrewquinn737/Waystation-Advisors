// Admin > Do not email: the suppression list. View, search, add (paste many) and remove, with the reason and the date.
// Bounces and "stop emailing me" replies land here by themselves; this is where an admin adds an owner who asked by phone, or a DNC list.
import { supabase } from "./supabaseClient.js";
import { confirmBox } from "./copyCommon.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; };
const SOURCE = { admin: "Added by an admin", bounce: "Bounced", reply: "Asked to stop", manual: "Added by hand" };
const PAGE = 100;
let items = [], total = 0, term = "", offset = 0, seq = 0;

export function initSuppression() {
  $("adSuppression").innerHTML = `<section class="ad-panel"><h3>Add addresses</h3>
      <p class="ad-muted">Paste email addresses or whole company domains (like acme.com), one per line or separated by commas. Nobody on this list is emailed, now or in a later campaign. Anything already queued for them moves to backup (calls only).</p>
      <textarea id="supText" rows="4" class="ad-ta" placeholder="owner@acme.com&#10;beta-co.com" aria-label="Addresses or domains to add"></textarea>
      <input id="supReason" type="text" maxlength="120" placeholder="Reason (for example: asked by phone on Nov 22)" aria-label="Reason" />
      <div class="ad-row"><button type="button" class="btn" id="supAdd">Add to the list</button></div>
      <div class="ad-msg hidden" id="supMsg" role="alert"></div></section>
    <div class="ad-num sup-search"><input id="supSearch" type="search" placeholder="Search addresses, domains or reasons" aria-label="Search the list" /></div>
    <p class="ad-muted" id="supCount" aria-live="polite"></p>
    <div id="supList" class="sup-list"></div>
    <button type="button" class="btn secondary small hidden" id="supMore">Show more</button>`;
  $("supAdd").onclick = add;
  $("supMore").onclick = () => load(true);
  let t = null;
  $("supSearch").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { term = e.target.value.trim(); load(false); }, 300); };
  $("supList").addEventListener("click", onRemove);
  load(false);
}
function msg(text, ok = false) { const el = $("supMsg"); el.textContent = text || ""; el.classList.toggle("hidden", !text); el.classList.toggle("ok", ok); }

async function load(more) {
  const mine = ++seq;   // a newer request always wins: older answers that arrive late are ignored, a new one is never skipped
  if (!more) { offset = 0; $("supList").innerHTML = `<p class="ad-empty">Loading...</p>`; }
  const asked = term;
  const { data, error } = await supabase.rpc("suppression_list", { p_search: asked || null, p_limit: PAGE, p_offset: offset });
  if (mine !== seq) return;
  if (error) { $("supList").innerHTML = `<p class="ad-empty">Couldn't load the list: ${esc(error.message)} <button type="button" class="ad-link" id="supRetry">Retry</button></p>`; $("supRetry").onclick = () => load(false); return; }
  total = data?.total ?? 0;
  items = more ? items.concat(data?.items || []) : data?.items || [];
  offset = items.length;
  render();
}
function render() {
  $("supCount").textContent = term ? `${total.toLocaleString()} match${total === 1 ? "" : "es"} for "${term}"` : `${total.toLocaleString()} on the list`;
  $("supList").innerHTML = items.length ? items.map((x, i) => `<div class="sup-row">
      <div class="sup-main"><b>${x.kind === "domain" ? "@" : ""}${esc(x.value)}</b>${x.kind === "domain" ? ` <span class="ad-muted">whole company</span>` : ""}
        <span class="sup-why">${esc(x.reason || "")}</span>
        <span class="ad-muted">${esc(SOURCE[x.source] || x.source || "")}${x.added_by ? ` by ${esc(x.added_by)}` : ""} · ${esc(when(x.created_at))}</span></div>
      <button type="button" class="btn secondary small" data-i="${i}">Remove</button></div>`).join("")
    : `<p class="ad-empty">${term ? "Nothing matches." : "Nobody is on the list yet."}</p>`;
  $("supMore").classList.toggle("hidden", items.length >= total);
}
async function add() {
  const text = $("supText").value.trim();
  if (!text) return msg("Paste at least one address or domain.");
  const b = $("supAdd"); b.disabled = true; msg("");
  // Preview first: free-mail domains are refused, a company domain asks "N leads will move to backup" before it is added
  const pv = await supabase.rpc("suppress_preview", { p_text: text });
  if (pv.error) { b.disabled = false; return msg("Not added: " + pv.error.message); }
  const refused = pv.data?.refused || [], doms = pv.data?.domains || [];
  const refusedMsg = refused.length ? `${refused.join(", ")} ${refused.length === 1 ? "is a free-mail domain" : "are free-mail domains"} and can't be blocked as a whole: it would stop email to everyone using that service. Add the individual addresses instead. ` : "";
  if (doms.length) {
    const lines = doms.map((d) => `${d.domain}: ${d.leads} ${d.leads === 1 ? "lead" : "leads"} will move to backup (calls only)`).join("; ");
    const ok = await confirmBox({ title: "Block whole companies?", body: `Nobody at ${doms.length === 1 ? "this company" : "these companies"} will be emailed again. ${lines}.`, yes: "Block" });
    if (!ok) { b.disabled = false; return msg(refusedMsg.trim()); }
  }
  const { data, error } = await supabase.rpc("suppress_many", { p_text: text, p_reason: $("supReason").value.trim() || "manual" });
  b.disabled = false;
  if (error) return msg("Not added: " + error.message);
  const bits = [data.emails && `${data.emails} address${data.emails === 1 ? "" : "es"}`, data.domains && `${data.domains} domain${data.domains === 1 ? "" : "s"}`].filter(Boolean);
  const extra = [data.already && `${data.already} already on the list`, data.skipped?.length && `${data.skipped.length} not recognised (${data.skipped.slice(0, 3).join(", ")})`].filter(Boolean);
  const refusedNow = data.refused?.length ? ` ${data.refused.join(", ")} not added: free-mail domains can't be blocked as a whole. Add the individual addresses instead.` : "";
  msg(`${bits.length ? "Added " + bits.join(" and ") : "Nothing new added"}${extra.length ? ". " + extra.join(", ") : ""}.${refusedNow}`, bits.length > 0 && !refusedNow);
  if (bits.length) { $("supText").value = ""; $("supReason").value = ""; load(false); }
}
async function onRemove(e) {
  const btn = e.target.closest("button[data-i]"); if (!btn) return;
  const x = items[+btn.dataset.i]; if (!x) return;
  if (!(await confirmBox({ title: `Remove ${x.value}?`, body: `${x.kind === "domain" ? "Everyone at this company" : "This address"} can be emailed again by a later campaign. Leads already moved to backup stay there.`, yes: "Remove" }))) return;
  btn.disabled = true;
  const { error } = await supabase.rpc(x.kind === "domain" ? "unsuppress_domain" : "unsuppress_email", x.kind === "domain" ? { p_domain: x.value } : { p_email: x.value });
  if (error) { btn.disabled = false; return msg("Not removed: " + error.message); }
  msg(`${x.value} removed.`, true); load(false);
}
