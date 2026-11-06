// Call recordings for accounts with profiles.record_accepted_calls on (the default) or record_all_calls on (Dials > Advanced). The call's
// audio (both sides mixed) is captured in the browser while the call runs and held IN MEMORY; nothing is uploaded
// unless the dial ends up in "Accepted intro call" — then that call's recording is saved to the private
// call-recordings bucket and shows under the dial's calls, with a link to share it. Every other recording is
// simply dropped (it never leaves the page, and a reload discards it). Only calls the server already approved for
// recording are captured at all (telnyx-token's decision), so all-party-consent states are never recorded.
import { supabase } from "./supabaseClient.js";

const pending = new Map(); // callId -> { dialId, blob, mime, seconds }
const keepDials = new Set(); // dials set to Accepted while their call was still live
const MAX_PENDING = 20;

const extFor = (mime) => (/mp4|m4a/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : "webm");

// Starts capturing the mix of both sides. Returns { stop() -> Promise<{ blob, mime } | null> }.
export function startRecorder({ ctx, micStream, remoteStream }) {
  const dest = ctx.createMediaStreamDestination(); // never connected to the speakers, so no echo
  const mic = ctx.createMediaStreamSource(micStream);
  const remote = ctx.createMediaStreamSource(remoteStream);
  mic.connect(dest);
  remote.connect(dest);
  const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
  const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(2000);
  return {
    stop: () =>
      new Promise((resolve) => {
        const done = () => {
          try { mic.disconnect(); remote.disconnect(); } catch { /* already gone */ }
          const type = rec.mimeType || mime || "audio/webm";
          resolve(chunks.length ? { blob: new Blob(chunks, { type }), mime: type.split(";")[0] } : null);
        };
        if (rec.state === "inactive") return done();
        rec.onstop = done;
        try { rec.stop(); } catch { done(); }
      }),
  };
}

async function upload(profile, callId, rec) {
  const path = `${profile.id}/${callId}.${extFor(rec.mime)}`;
  const { error } = await supabase.storage.from("call-recordings").upload(path, rec.blob, { contentType: rec.mime, upsert: true });
  if (error) throw error;
  const { error: upErr } = await supabase.from("calls").update({ recording_path: path, recording_mime: rec.mime }).eq("id", callId);
  if (upErr) throw upErr;
  return path;
}

// A call just ended: keep its recording in memory, or upload it right away if its dial was already marked Accepted.
export async function holdRecording(profile, callId, dialId, rec) {
  if (!rec?.blob) return false;
  if (keepDials.has(dialId)) {
    keepDials.delete(dialId);
    try { await upload(profile, callId, rec); return true; } catch { /* fall through: keep it for a retry */ }
  }
  pending.set(callId, { dialId, ...rec });
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
  return false;
}

// The dial was just set to Accepted intro call. If its call is still live, keep that recording when it ends;
// otherwise upload the newest held recording for the dial and drop the rest. Resolves to true if one was saved.
export async function keepRecordingForDial(profile, dialId, callIsLive) {
  if (callIsLive) { keepDials.add(dialId); return false; }
  const mine = [...pending.entries()].filter(([, r]) => r.dialId === dialId);
  if (!mine.length) return false;
  const [callId, rec] = mine[mine.length - 1];
  mine.forEach(([id]) => { if (id !== callId) pending.delete(id); });
  await upload(profile, callId, rec);
  pending.delete(callId);
  return true;
}

// The dial was set to any category OTHER than "Accepted intro call": drop the recordings held in memory for it, and
// delete any that were saved earlier (the stored file and the link on the call), to save space.
export async function discardRecordingsForDial(dialId, { savedToo = true } = {}) {
  keepDials.delete(dialId);
  [...pending.entries()].forEach(([id, r]) => { if (r.dialId === dialId) pending.delete(id); });
  if (!savedToo) return 0;
  const { data } = await supabase.from("calls").select("id, recording_path").eq("dial_id", dialId).not("recording_path", "is", null);
  const rows = data || [];
  if (!rows.length) return 0;
  const { error } = await supabase.storage.from("call-recordings").remove(rows.map((r) => r.recording_path));
  if (error) throw error;
  await supabase.from("calls").update({ recording_path: null, recording_mime: null }).in("id", rows.map((r) => r.id));
  return rows.length;
}

export async function signedRecordingUrl(path, seconds = 3600, download = false) {
  const { data, error } = await supabase.storage.from("call-recordings").createSignedUrl(path, seconds, download ? { download: true } : undefined);
  if (error) throw error;
  return data.signedUrl;
}
