// "Edit with Claude": a drawer (bottom sheet on phones) mounted into <div id="aiChatMount"> in the campaign review.
// Messages stream in over Supabase Realtime (ai_messages), with a 2s poll as the fallback while a reply is pending.
// The mount div may carry data-list-id / data-list-name; if absent the list id is read from the enclosing .cr-panel.
import { supabase } from "./supabaseClient.js";
import { fetchStatus, statusInfo } from "./aiChatSetup.js";

const css = document.createElement("link");
css.rel = "stylesheet"; css.href = new URL("../css/aiChat.css", import.meta.url).href; document.head.appendChild(css);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (s) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/^- /gm, "• ").replace(/\n/g, "<br>");
const CHIPS = ["Shorten all to under 70 words", "Make openers more casual", "Fix the held emails"];

export function mountAiChat(host, { listId, listName = "" }) {
  let threadId = null, msgs = [], status = null, busySince = 0, chan = null, poll = null, sending = false;
  const refreshed = new Set();
  host.innerHTML = `<button type="button" class="btn secondary ai-open" aria-haspopup="dialog"><span class="ai-spark">✦</span> Edit with Claude</button>`;
  const drawer = document.createElement("aside");
  drawer.className = "ai-drawer"; drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-label", "Edit with Claude"); drawer.hidden = true;
  drawer.innerHTML = `<div class="ai-head"><div><h2>Edit with Claude</h2><div class="ai-stat" data-r="stat"></div></div>
      <div class="ai-head-btns"><button type="button" class="ai-link" data-r="new">New chat</button><button type="button" class="ai-x" data-r="close" aria-label="Close">&times;</button></div></div>
    <div class="ai-list" data-r="list" aria-live="polite"></div>
    <div class="ai-err" data-r="err" role="alert" hidden></div>
    <div class="ai-chips" data-r="chips">${CHIPS.map((c) => `<button type="button" class="ai-chip">${esc(c)}</button>`).join("")}</div>
    <form class="ai-form" data-r="form"><textarea data-r="input" rows="1" maxlength="4000" placeholder="Message Claude..." aria-label="Message to Claude"></textarea><button type="submit" class="btn" data-r="send">Send</button></form>`;
  document.body.appendChild(drawer);
  const r = (n) => drawer.querySelector(`[data-r="${n}"]`);
  const openBtn = host.querySelector(".ai-open");

  const busy = () => { const l = msgs[msgs.length - 1]; return !!l && (l.partial || l.role === "user"); };
  function renderStatus() {
    const i = statusInfo(status), el = r("stat");
    el.className = "ai-stat " + i.k;
    el.innerHTML = `<span class="ai-dot"></span>${esc(i.text)}${i.k === "warn" ? ' — <a href="admin.html#settings">see Settings</a>' : ""}`;
  }
  function render() {
    const list = r("list"), atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.innerHTML = msgs.length ? msgs.map((m) => m.role === "system" ? `<div class="ai-msg sys">${md(m.content)}</div>`
      : `<div class="ai-msg ${m.role}">${m.partial && !m.content ? '<span class="ai-typing"><i></i><i></i><i></i></span>' : md(m.content) + (m.partial ? '<span class="ai-caret"></span>' : "")}</div>`).join("")
      : `<div class="ai-empty">Tell Claude what to change across this campaign's emails. It checks each one against the house rules before saving, and never launches.</div>`;
    if (atEnd || msgs.length <= 1) list.scrollTop = list.scrollHeight;
    const b = busy();
    r("send").disabled = b || sending; r("input").disabled = false;
    r("chips").hidden = b;
    if (b && !busySince) busySince = Date.now(); if (!b) busySince = 0;
    if (b && Date.now() - busySince > 45000 && statusInfo(status).k !== "ok") showErr("Waiting for the server. If this stays stuck, check Admin > Settings.");
    // a reply that saved changes: refresh the review list once
    for (const m of msgs) if (!m.partial && m.role === "assistant" && (m.meta?.saved || 0) > 0 && !refreshed.has(m.id)) {
      refreshed.add(m.id);
      document.dispatchEvent(new CustomEvent("ws:drafts-changed", { detail: { listId } }));
    }
  }
  function showErr(t) { const e = r("err"); e.textContent = t || ""; e.hidden = !t; }
  function merge(row) {
    const i = msgs.findIndex((m) => m.id === row.id);
    if (i >= 0) msgs[i] = row; else msgs.push(row);
    msgs.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  }
  async function loadThread() {
    const { data: u } = await supabase.auth.getUser();
    const { data } = await supabase.from("ai_threads").select("id").eq("list_id", listId).eq("created_by", u?.user?.id).eq("status", "open").maybeSingle();
    threadId = data?.id || null; msgs = [];
    if (threadId) { await pull(true); listen(); } else render();
  }
  async function pull(initial = false) {
    if (!threadId) return;
    const { data, error } = await supabase.from("ai_messages").select("id, role, content, partial, meta, created_at").eq("thread_id", threadId).order("created_at").limit(500);
    if (error) return showErr("Couldn't load the chat: " + error.message);
    const had = busy(); msgs = data || []; if (initial) msgs.forEach((m) => refreshed.add(m.id)); render(); if (had && !busy()) startPoll(false);
  }
  function listen() {
    if (chan) supabase.removeChannel(chan);
    chan = supabase.channel("ai-" + threadId).on("postgres_changes", { event: "*", schema: "public", table: "ai_messages", filter: `thread_id=eq.${threadId}` },
      (p) => { if (p.eventType === "DELETE") msgs = msgs.filter((m) => m.id !== p.old.id); else merge(p.new); render(); }).subscribe();
  }
  const startPoll = (on) => { clearInterval(poll); poll = on ? setInterval(() => { if (!drawer.isConnected) return; pull(); }, 2000) : null; };
  async function send(text) {
    text = text.trim(); if (!text || sending || busy()) return;
    sending = true; showErr(""); r("send").disabled = true;
    const { data, error } = await supabase.rpc("post_ai_message", { p_list_id: listId, p_text: text });
    sending = false;
    if (error) { showErr(error.message); render(); return; }
    r("input").value = ""; autosize();
    if (data.thread_id !== threadId) { threadId = data.thread_id; listen(); }
    await pull(); startPoll(true);
  }
  const autosize = () => { const t = r("input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; };
  async function refreshStatus() { status = await fetchStatus(); renderStatus(); if (!status.enabled && !drawer.hidden) showErr("The Claude chat is switched off."); }

  openBtn.onclick = () => { drawer.hidden = false; document.body.classList.add("ai-open-body"); refreshStatus(); loadThread().then(() => { if (busy()) startPoll(true); }); r("input").focus(); };
  const close = () => { drawer.hidden = true; document.body.classList.remove("ai-open-body"); startPoll(false); };
  r("close").onclick = close;
  drawer.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  r("new").onclick = async () => {
    const { error } = await supabase.rpc("ai_new_thread", { p_list_id: listId });
    if (error) return showErr(error.message);
    showErr(""); if (chan) supabase.removeChannel(chan); threadId = null; msgs = []; render();
  };
  r("form").onsubmit = (e) => { e.preventDefault(); send(r("input").value); };
  r("input").addEventListener("input", autosize);
  r("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(r("input").value); } });
  r("chips").addEventListener("click", (e) => { const c = e.target.closest(".ai-chip"); if (c) { r("input").value = c.textContent; autosize(); r("input").focus(); } });
  const statusTimer = setInterval(() => { if (!drawer.isConnected) return; if (!drawer.hidden) refreshStatus(); }, 15000);
  // the review screen was closed: tear everything down
  const gone = setInterval(() => { if (!host.isConnected) { clearInterval(gone); clearInterval(statusTimer); startPoll(false); if (chan) supabase.removeChannel(chan); drawer.remove(); document.body.classList.remove("ai-open-body"); } }, 1000);
  fetchStatus().then((s) => { status = s; renderStatus(); if (!s.enabled) { host.innerHTML = ""; drawer.remove(); } });   // flag off or not an admin: nothing shows
  render(); renderStatus();
}

// Finds every #aiChatMount (the review screen adds/removes it as it opens and closes) and mounts the chat once.
function scan() {
  document.querySelectorAll(".cr-panel").forEach((p) => {                     // review screen without its own mount yet: add it under the header
    if (p.querySelector("#aiChatMount") || !p.dataset.listId) return;
    const head = p.querySelector(".cr-head"); if (!head) return;
    const d = document.createElement("div"); d.id = "aiChatMount"; head.appendChild(d);
  });
  document.querySelectorAll("#aiChatMount, [data-ai-chat-mount]").forEach((h) => {
    if (h.dataset.aiMounted) return;
    const listId = h.dataset.listId || h.closest(".cr-panel")?.dataset.listId; if (!listId) return;
    h.dataset.aiMounted = "1"; mountAiChat(h, { listId, listName: h.dataset.listName || "" });
  });
}
let t = null;
new MutationObserver(() => { clearTimeout(t); t = setTimeout(scan, 60); }).observe(document.body, { childList: true, subtree: true });
scan();
