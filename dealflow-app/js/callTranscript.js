// Live transcript: streams the 2-channel audio to Deepgram (nova-3, multichannel) and saves each
// finished line to call_lines. Channel 0 = the caller ("intern"), channel 1 = the owner. Only ever
// started for a call the database allows to be transcribed (the deepgram-token function refuses
// otherwise). Lines are batched (every 3 s or 5 lines).
import { supabase } from "./supabaseClient.js";

const URL_BASE =
  "wss://api.deepgram.com/v1/listen?model=nova-3&language=en&multichannel=true&channels=2&encoding=linear16&sample_rate=16000&interim_results=true&smart_format=true&punctuate=true&endpointing=300";

async function fetchToken(callId) {
  const { data, error } = await supabase.functions.invoke("deepgram-token", { body: { call_id: callId } });
  if (error || !data?.token) throw new Error("no transcription token");
  return data.token;
}

export function startTranscript({ callId, onLine, onInterim, onFailed }) {
  let ws = null, closed = false, retried = false, savedCount = 0;
  const queue = []; // audio frames waiting for the socket
  const pending = []; // finished lines waiting to be saved
  let flushTimer = null, keepAlive = null;

  // Flushes run one after another, so stop() can wait for any batch already on its way to the
  // database (otherwise the summary could be requested before the last lines were saved).
  let saving = Promise.resolve();
  const flush = () => {
    clearTimeout(flushTimer); flushTimer = null;
    if (!pending.length) return saving;
    const rows = pending.splice(0).map((l) => ({ call_id: callId, speaker: l.speaker, text: l.text, start_ms: l.start_ms, end_ms: l.end_ms, confidence: l.confidence }));
    saving = saving.then(async () => {
      const { error } = await supabase.from("call_lines").insert(rows);
      if (!error) savedCount += rows.length;
      else console.error("call_lines insert failed", error);
    });
    return saving;
  };

  const onMessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== "Results") return;
    const alt = m.channel?.alternatives?.[0];
    const text = (alt?.transcript || "").trim();
    if (!text) return;
    const speaker = (m.channel_index?.[0] ?? 0) === 0 ? "intern" : "owner";
    if (!m.is_final) { onInterim?.({ speaker, text }); return; }
    const line = { speaker, text, start_ms: Math.round((m.start || 0) * 1000), end_ms: Math.round(((m.start || 0) + (m.duration || 0)) * 1000), confidence: alt.confidence ?? null };
    pending.push(line);
    onLine?.(line);
    if (pending.length >= 5) flush(); else if (!flushTimer) flushTimer = setTimeout(flush, 3000);
  };

  async function open() {
    try {
      const token = await fetchToken(callId);
      ws = new WebSocket(URL_BASE, ["bearer", token]);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { while (queue.length) ws.send(queue.shift()); };
      ws.onmessage = onMessage;
      ws.onclose = () => { if (!closed && !retried) { retried = true; open(); } else if (!closed) onFailed?.(savedCount); };
      ws.onerror = () => {};
      clearInterval(keepAlive);
      keepAlive = setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "KeepAlive" })); }, 8000);
    } catch (e) {
      if (!retried) { retried = true; return open(); }
      if (!closed) onFailed?.(savedCount);
    }
  }
  open();

  return {
    sendAudio(buf) {
      if (closed) return;
      if (ws?.readyState === 1) ws.send(buf);
      else if (queue.length < 300) queue.push(buf);
    },
    async stop() {
      closed = true;
      clearInterval(keepAlive);
      try { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "CloseStream" })); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1200)); // let the last finals arrive
      try { ws?.close(); } catch { /* ignore */ }
      await flush();
      return savedCount;
    },
  };
}
