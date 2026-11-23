// Client Timeline: the call(s) that led to this client. Shows time, length, the AI summary, the full transcript and the recording
// for the dial the client came from (clients.source_dial_id), so a lead or admin reviewing the client can hear what was said.
import { supabase } from "./supabaseClient.js";
import { signedRecordingUrl } from "./callRecordings.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function mountClientCalls(client, container) {
  if (!client?.source_dial_id || !container) return;
  const host = document.createElement("section");
  host.className = "client-calls";
  host.innerHTML = `<h3 class="client-calls-h">Calls before this client</h3><div class="help-text">Loading calls...</div>`;
  container.appendChild(host);
  const { data, error } = await supabase.from("calls")
    .select("id, started_at, duration_sec, answered, transcribed, summary, recording_path, dial_method, mode")
    .eq("dial_id", client.source_dial_id).eq("direction", "outbound").order("started_at", { ascending: false }).limit(100);
  if (!host.isConnected) return;
  if (error) { host.querySelector(".help-text").textContent = "Couldn't load the calls. Close and reopen this client to try again."; return; }
  if (!data?.length) { host.remove(); return; }
  const callHTML = (c) => {
    const when = new Date(c.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const dur = c.duration_sec ? ` · ${Math.floor(c.duration_sec / 60)}:${String(c.duration_sec % 60).padStart(2, "0")}` : "";
    const body = c.mode === "native" ? "Called from the phone's own dialer: no transcript or recording." : c.summary ? esc(c.summary) : !c.answered ? "Not answered." : c.transcribed ? "Summary is still being prepared." : "No transcript.";
    return `<div class="client-call"><div class="client-call-when"><b>${c.dial_method === "company" ? "Company line" : "Call"}</b> · ${esc(when + dur)}</div><div>${body}</div>
      ${c.recording_path ? `<div class="client-call-rec" data-path="${esc(c.recording_path)}"><button type="button" class="btn secondary">Play recording</button></div>` : ""}
      ${c.transcribed && c.answered ? `<details data-call="${c.id}"><summary>Full transcript</summary><div class="client-call-lines"></div></details>` : ""}</div>`;
  };
  // The calls that have something to read or hear (summary, recording) come first; then the newest. "Show all" lists the rest.
  const useful = (c) => !!(c.summary || c.recording_path);
  const top = [...data.filter(useful), ...data.filter((c) => !useful(c))].slice(0, 5).sort((x, y) => (y.started_at > x.started_at ? 1 : -1));
  const draw = (list, all) => {
    host.innerHTML = `<h3 class="client-calls-h">Calls before this client</h3>` + list.map(callHTML).join("") +
      (!all && data.length > list.length ? `<button type="button" class="ad-link client-calls-all">Show all ${data.length} calls</button>` : "");
    wire();
    host.querySelector(".client-calls-all")?.addEventListener("click", () => draw(data, true));
  };
  const wire = () => {
  host.querySelectorAll(".client-call-rec").forEach((box) => box.querySelector("button").addEventListener("click", async () => {
    try { box.innerHTML = `<audio controls autoplay preload="auto" src="${esc(await signedRecordingUrl(box.dataset.path, 3600))}"></audio>`; }
    catch (e) { box.innerHTML = `<div class="help-text">${/not found|404|no such/i.test(e?.message || "") ? "This recording is no longer available." : "Couldn't load the recording. Tap Play again."}</div>`; }
  }));
  host.querySelectorAll("details[data-call]").forEach((d) => d.addEventListener("toggle", async () => {
    const t = d.querySelector(".client-call-lines");
    if (!d.open || t.dataset.loaded) return;
    t.dataset.loaded = "1";
    const { data: lines } = await supabase.from("call_lines").select("speaker, text").eq("call_id", d.dataset.call).order("start_ms");
    t.innerHTML = (lines || []).length ? lines.map((l) => `<div><b>${l.speaker === "intern" ? "Rep" : "Owner"}:</b> ${esc(l.text)}</div>`).join("") : `<div class="help-text">No transcript lines.</div>`;
  }));
  };
  draw(top, false);
}
