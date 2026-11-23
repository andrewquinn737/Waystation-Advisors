// In-app calling: one call at a time, placed over Telnyx WebRTC from a Waystation pool number.
// startCall() is the single entry point (dials.js calls it when an owner dial's call icon is
// tapped). Every failure BEFORE the line rings falls back to the phone's own dialer (tel:) — a
// call is never blocked. Recording/transcription happens only when the server says so
// (telnyx-token's decision + the database's own consent check); nothing is captured for
// confirmed no-record states.
import { supabase } from "./supabaseClient.js";
import { toE164 } from "./phoneUtil.js";
import { showNotice } from "./notice.js";
import { callBlocked } from "./testCallGuard.js";
import { openCallPanel } from "./callPanel.js";
import { startCallAudio } from "./callAudio.js";
import { startTranscript } from "./callTranscript.js";
import { startRecorder, holdRecording } from "./callRecordings.js";
import { installLeaveGuard } from "./callLeave.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const TELNYX_SDK = "https://cdn.jsdelivr.net/npm/@telnyx/webrtc@2.27.10/lib/bundle.mjs";
let active = false;
let primed = null; // an AudioContext unlocked inside a tap, for a call that starts a moment later (autodial)

export function isCallActive() {
  return active;
}
// Autodial starts its call right after a database save, i.e. a beat after the tap that chose the
// category — so the audio context is created/unlocked inside that tap and reused by startCall.
export function primeAudio() {
  try {
    if (!primed || primed.state === "closed") primed = new AudioContext({ sampleRate: 16000 });
    primed.resume().catch(() => {});
  } catch {
    primed = null;
  }
}

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timed out")), ms))]);

async function logNative(profile, dial, to, owner_state, skip_reason, method) {
  // Fire-and-forget record of a call that went to the phone's own dialer.
  supabase.from("calls").insert({
    user_id: profile.id, mode: "native", skip_reason, to_number: to, owner_state, dial_id: dial.id, list_id: dial.list_id, dial_method: method,
    company_name: dial.company_name || null, owner_name: dial.full_name || null, industry: dial.industry || null,
  }).then(() => {}, () => {});
}

// Why the microphone could not be opened, in words an intern can act on. The call still goes out on the phone's dialer.
function micProblem(err) {
  const n = err?.name || "";
  const ua = navigator.userAgent || "";
  const ios = /iPhone|iPad/.test(ua);
  if (n === "NotFoundError" || n === "OverconstrainedError") return { reason: "mic_missing", msg: "No microphone was found on this device." };
  if (n === "NotReadableError" || n === "AbortError") return { reason: "mic_busy", msg: "Another app is using the microphone. Close it (or end any other call), then try again." };
  const fix = ios ? "In Safari tap the aA button in the address bar, then Website Settings, then set Microphone to Allow. (Installed app: Settings > Waystation > Microphone.)"
    : /Android/.test(ua) ? "Tap the lock icon next to the address, then Permissions, then set Microphone to Allow."
    : "Click the lock icon at the left of the address bar and set Microphone to Allow.";
  return { reason: "mic_denied", msg: "The microphone is blocked for this site, so the live transcript and recording are off. " + fix + " Your next call will use it automatically; no reload needed." };
}
let lastExplained = 0;
function explainFallback(why) {
  if (Date.now() - lastExplained < 10 * 60 * 1000) return; // once per 10 minutes, so a run of calls is not nagged
  lastExplained = Date.now();
  showNotice(why.msg, { title: "This call used your phone's dialer" });
}

// opts: { dial, phone, method ('mobile'|'company'), profile, onDialed(), onSummary(callId), fallbackTel(phone), onNoAnswer() }
export async function startCall(opts) {
  const { dial, phone, method, profile } = opts;
  if (active) { showNotice("You're already on a call. Hang up first.", { title: "Call in progress" }); return; }
  const to = toE164(phone);
  if (!to) { opts.fallbackTel(phone); return; }
  if (await callBlocked(to)) return;
  if (!toE164(profile.phone)) {
    showNotice("Add your cell number to your profile (Profile → Edit) before calling. We need it to ring you if an owner calls back.", {
      title: "Add your cell number", actionLabel: "Go to Profile", onAction: () => { window.location.href = "profile.html"; },
    });
    return;
  }
  active = true;
  // The contact is recorded for today once the call is REALLY going — ringing or answered in the app, or the
  // moment the phone's own dialer takes over (there is no manual "contacted" circle). A call that never got
  // out (phone service down, number rejected) must not count as contact.
  let dialedMarked = false;
  const markDialed = () => { if (!dialedMarked) { dialedMarked = true; opts.onDialed?.(); } };

  // Created inside the tap so iOS lets the audio run.
  let ctx = null, mic = null, client = null, call = null, wake = null, transcript = null, stopAudio = null;
  let callId = null, transcribe = false, answeredAt = null, finished = false, ringing = false, recorder = null;
  try { ctx = primed && primed.state !== "closed" ? primed : new AudioContext({ sampleRate: 16000 }); primed = null; await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]); } catch { ctx = null; } // never hang on resume (a call Autodial starts without a tap)
  const remoteAudio = Object.assign(document.createElement("audio"), { autoplay: true });
  remoteAudio.setAttribute("playsinline", "");
  document.body.appendChild(remoteAudio);

  const panel = openCallPanel({
    name: dial.full_name || dial.company_name, company: dial.company_name,
    onHangup: () => { try { call?.hangup(); } catch { /* ignore */ } if (!call) finish("Call cancelled"); },
    onMute: (m) => setMuted(m),
    onOutcome: opts.onOutcome, onNext: opts.onNext, outcomes: opts.outcomes,
    onDtmf: (d) => { try { call?.dtmf(d); } catch { /* call not connected yet */ } },
  });


  // Leaving the page mid-call (Back, a nav tap, closing the tab) used to drop the call silently and leave its row open forever.
  // Now: the browser asks first; a tap on an in-app link asks "End the call?"; and if the page goes anyway the call row is closed
  // (end time, answered, length, end_reason = left_page). The dial gets no outcome, so it simply stays in the queue.
  let accessToken = null;
  supabase.auth.getSession().then(({ data }) => { accessToken = data?.session?.access_token || null; }).catch(() => {});
  const closeRow = () => {
    if (!callId || !accessToken) return;
    const now = new Date();
    const patch = { ended_at: now.toISOString(), answered: !!answeredAt, end_reason: "left_page" };
    if (answeredAt) patch.duration_sec = Math.max(0, Math.round((now - answeredAt) / 1000));
    fetch(`${SUPABASE_URL}/rest/v1/calls?id=eq.${callId}`, { method: "PATCH", keepalive: true,
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + accessToken, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(patch) }).catch(() => {});
  };
  const removeLeaveGuards = installLeaveGuard({ isFinished: () => finished, hangup: () => call?.hangup(), closeRow });

  // Plays the call's incoming audio. Safe to call repeatedly: it (re)attaches the stream if it changed,
  // restarts playback if the browser paused it, and follows tracks that get added late.
  const attachRemote = (c) => {
    const rs = c?.remoteStream;
    if (!rs) return;
    if (remoteAudio.srcObject !== rs) {
      remoteAudio.srcObject = rs;
      try { rs.addEventListener("addtrack", () => remoteAudio.play?.().catch(() => {})); } catch { /* ignore */ }
    }
    remoteAudio.muted = false;
    if (remoteAudio.paused) remoteAudio.play?.().catch(() => {});
  };

  const cleanupMedia = () => {
    try { stopAudio?.(); } catch { /* ignore */ }
    mic?.getTracks().forEach((t) => t.stop());
    try { ctx?.close(); } catch { /* ignore */ }
    try { wake?.release(); } catch { /* ignore */ }
    try { client?.disconnect(); } catch { /* ignore */ }
    remoteAudio.srcObject = null; remoteAudio.remove();
    clearInterval(guard); guard = null;
    document.removeEventListener("visibilitychange", onVis); document.removeEventListener("visibilitychange", onVisWake); clearTimeout(micTimer);
    removeLeaveGuards();
    active = false;
  };
  // The phone or browser can silence the microphone mid-call (another app or notification grabbing audio, a
  // Bluetooth switch, the page being backgrounded). Say so on screen, and re-open the mic if it was cut off.
  let micTimer = null;
  const watchMic = () => {
    const track = mic?.getAudioTracks?.()[0];
    if (!track) return;
    const clear = () => { clearTimeout(micTimer); if (!finished) panel.warn(""); };
    track.addEventListener("mute", () => {
      clearTimeout(micTimer);
      micTimer = setTimeout(() => { if (!finished && !micMuted && track.muted) panel.warn("Your phone interrupted the microphone — they may not hear you."); }, 1200);
    });
    track.addEventListener("unmute", clear);
    track.addEventListener("ended", () => recoverMic());
  };
  const recoverMic = async () => {
    if (finished) return;
    panel.warn("Microphone was cut off — reconnecting it…");
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const t = fresh.getAudioTracks()[0];
      const pc = call?.peer?.instance;
      const sender = pc?.getSenders?.().find((s) => s.track?.kind === "audio" || (!s.track && s.dtmf));
      if (!sender) throw new Error("no sender");
      t.enabled = !micMuted; // a mic you muted stays muted
      await sender.replaceTrack(t);
      mic?.getTracks().forEach((x) => x.stop());
      mic = fresh;
      try { if (call?.options) call.options.localStream = fresh; } catch { /* ignore */ }
      watchMic();
      panel.warn("");
    } catch { panel.warn("Your microphone stopped working — hang up and call again."); }
  };
  // Mute/unmute. The mute is applied to the microphone track that is ACTUALLY in the call right now (recoverMic can
  // swap it for a fresh one, which the SDK's own mute doesn't know about), and the SDK is told too. Unmuting also
  // makes sure the mic is live and the incoming audio is playing — a mute used to be able to leave the call silent.
  let micMuted = false;
  const applyMute = () => {
    const tracks = new Set([...(mic?.getAudioTracks?.() || []), ...(call?.options?.localStream?.getAudioTracks?.() || [])]);
    const sender = call?.peer?.instance?.getSenders?.().find((s) => s.track?.kind === "audio");
    if (sender?.track) tracks.add(sender.track);
    tracks.forEach((t) => { t.enabled = !micMuted; });
  };
  const setMuted = (m) => {
    micMuted = m;
    try { m ? call?.muteAudio() : call?.unmuteAudio(); } catch { /* ignore */ }
    applyMute();
    if (!m) setTimeout(ensureLiveAfterUnmute, 0);
  };
  const ensureLiveAfterUnmute = async () => {
    if (finished || micMuted) return;
    try { if (ctx && ctx.state !== "running" && ctx.state !== "closed") await ctx.resume(); } catch { /* ignore */ }
    if (call) attachRemote(call);
    try { if (remoteAudio.srcObject && remoteAudio.paused) await remoteAudio.play(); } catch { /* ignore */ }
    const t = mic?.getAudioTracks?.()[0];
    const sender = call?.peer?.instance?.getSenders?.().find((s) => s.track?.kind === "audio" || (!s.track && s.dtmf));
    const senderOk = sender?.track && sender.track.readyState === "live" && sender.track.enabled && !sender.track.muted;
    if (!t || t.readyState === "ended" || t.muted || !senderOk) {
      // The microphone didn't come back after the unmute: re-open it, and make sure the call is using the new one.
      micBadSince = 0;
      await recoverMic();
    }
  };
  // iPhones pause the call's audio and cut the microphone when something interrupts the audio session (a
  // notification sound, Siri, a message tone) and do NOT resume either by themselves. While a call is live,
  // every 1.5 s: restart the incoming audio if it was paused, wake the audio engine if it was suspended, and
  // re-open the microphone if it stayed muted/ended for ~3 s.
  let guard = null, micBadSince = 0;
  const startGuard = () => {
    if (guard) return;
    guard = setInterval(() => {
      if (finished) return;
      try { if (remoteAudio.srcObject && remoteAudio.paused) remoteAudio.play().catch(() => {}); } catch { /* ignore */ }
      try { if (ctx && ctx.state !== "running" && ctx.state !== "closed") ctx.resume().catch(() => {}); } catch { /* ignore */ }
      const t = mic?.getAudioTracks?.()[0];
      const bad = !micMuted && (!t || t.readyState === "ended" || t.muted); // a mic you muted on purpose isn't a fault
      if (!bad) { micBadSince = 0; return; }
      if (!micBadSince) micBadSince = Date.now();
      else if (Date.now() - micBadSince > 3000) { micBadSince = Date.now() + 8000; recoverMic(); } // then give it 8 s before trying again
    }, 1500);
  };
  const onVis = async () => {
    if (document.visibilityState === "visible" && !finished) {
      const t = mic?.getAudioTracks?.()[0];
      if (t && t.readyState === "ended") recoverMic();
    }
  };
  const onVisWake = async () => { if (document.visibilityState === "visible" && !finished && navigator.wakeLock) { try { wake = await navigator.wakeLock.request("screen"); } catch { /* ignore */ } } };

  async function finish(label) {
    if (finished) return;
    finished = true;
    const endedAt = new Date();
    panel.ended(label || "Call ended");
    let lines = 0;
    try { if (transcript) lines = await transcript.stop(); } catch { /* ignore */ }
    // The recording (accounts with record_accepted_calls or record_all_calls) is held in memory; it is uploaded only if this dial
    // ends up as "Accepted intro call" (see js/callRecordings.js).
    let recorded = null;
    try { if (recorder) recorded = await recorder.stop(); } catch { /* ignore */ }
    cleanupMedia();
    if (recorded && callId && answeredAt) holdRecording(profile, callId, dial.id, recorded).then((saved) => { if (saved) opts.onRecordingSaved?.(); }, () => {});
    if (callId) {
      const patch = { ended_at: endedAt.toISOString(), answered: !!answeredAt };
      if (answeredAt) patch.duration_sec = Math.max(0, Math.round((endedAt - answeredAt) / 1000));
      if (transcribe && answeredAt && lines === 0) { patch.transcribed = false; patch.skip_reason = "stt_failed"; }
      else if (transcribe && !answeredAt) patch.transcribed = false; // nobody picked up: there is nothing to transcribe or summarize
      await supabase.from("calls").update(patch).eq("id", callId);
      if (transcribe && lines >= 1) { // every transcribed call gets a summary (short ones are noted in code by call-summary)
        panel.summary("Summarizing the call…");
        const { data } = await supabase.functions.invoke("call-summary", { body: { call_id: callId } });
        if (data?.summary) { panel.summary(data.summary); opts.onSummary?.(callId); }
        else if (data?.skipped === "too_short") panel.summary("No summary (call too short).");
        else {
          // The request failed or timed out — a background job retries every minute, so look again shortly.
          panel.summary("Summary is still being prepared — it will appear in the dial's Transcript box in about a minute.");
          const id = callId;
          setTimeout(async () => {
            const { data: row } = await supabase.from("calls").select("summary").eq("id", id).maybeSingle();
            if (row?.summary) { try { panel.summary(row.summary); } catch { /* panel closed */ } opts.onSummary?.(id); }
          }, 75000);
        }
      }
    }
  }
  async function notConnected(c) {
    if (finished) return;
    finished = true;
    if (callId) await supabase.from("calls").update({ ended_at: new Date().toISOString(), transcribed: false, skip_reason: "not_connected" }).eq("id", callId);
    cleanupMedia(); panel.close();
    showNotice("The in-app call couldn't connect, so nothing was recorded for this contact. You can call from your phone instead.", {
      title: "Call didn't connect", actionLabel: "Call from my phone",
      onAction: () => { opts.fallbackTel(phone); },
    });
  }
  async function fail(reason, label) { // before it rang: use the phone's own dialer instead
    if (finished) return;
    finished = true;
    if (callId) await supabase.from("calls").update({ skip_reason: ringing ? null : reason, transcribed: false, ended_at: new Date().toISOString() }).eq("id", callId);
    cleanupMedia(); panel.close();
    if (!ringing) { opts.fallbackTel(phone); } else showNotice(label || "The call couldn't connect.", { title: "Call failed" });
  }

  try {
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (err) {
      const why = micProblem(err);
      await logNative(profile, dial, to, dial.state, why.reason, method); cleanupMedia(); panel.close(); opts.fallbackTel(phone);
      explainFallback(why); // the call itself goes ahead on the phone's dialer; this says why it has no transcript and how to fix it
      return;
    }
    document.addEventListener("visibilitychange", onVis); document.addEventListener("visibilitychange", onVisWake); onVisWake();
    watchMic();

    const { data: t, error: te } = await withTimeout(supabase.functions.invoke("telnyx-token", { body: { to_number: to, owner_state: dial.state || null } }), 8000, "token");
    if (te?.context?.status === 403) { cleanupMedia(); panel.close(); active = false; finished = true; showNotice("Test app: calls limited to the test number", { title: "Test app" }); return; }
    if (te || !t) throw new Error("token");
    if (t.decision === "native") { await logNative(profile, dial, to, dial.state, "unknown_state", method); cleanupMedia(); panel.close(); opts.fallbackTel(phone); return; }
    transcribe = t.decision === "record";

    const { data: row, error: re } = await supabase.from("calls").insert({
      mode: "in_app", transcribed: transcribe, skip_reason: transcribe ? null : t.reason, to_number: to, from_number: t.from_number, owner_state: dial.state || null,
      dial_id: dial.id, list_id: dial.list_id, dial_method: method, company_name: dial.company_name || null, owner_name: dial.full_name || null, industry: dial.industry || null,
    }).select("id").single();
    if (re) throw re;
    callId = row.id;

    const { TelnyxRTC } = await withTimeout(import(TELNYX_SDK), 10000, "calling library");
    client = new TelnyxRTC({ login_token: t.login_token });
    const readyTimer = setTimeout(() => { if (!call) fail("rtc_failed"); }, 8000);
    client.on("telnyx.error", () => { if (!call || !ringing) fail("rtc_failed"); });
    client.on("telnyx.ready", () => {
      clearTimeout(readyTimer);
      if (finished) return; // hung up while it was still connecting
      panel.state("Dialing…");
      call = client.newCall({ destinationNumber: to, callerNumber: t.from_number, callerName: t.caller_id_name || "Waystation Adv", localStream: mic });
    });
    client.on("telnyx.notification", async (n) => {
      const c = n.call; if (n.type !== "callUpdate" || !c) return;
      const st = c.state;
      attachRemote(c); // as early as the carrier sends audio (ringback, greeting), not only once "active"
      if (st === "trying" || st === "requesting") panel.state("Dialing…");
      if (st === "ringing" || st === "early") { ringing = true; panel.state("Ringing…"); markDialed(); }
      if (st === "active" && !answeredAt) {
        answeredAt = new Date(); ringing = true; startGuard(); markDialed();
        panel.state(transcribe ? "Transcribing" : "Connected"); panel.startTimer();
        // The owner's first words can arrive a beat after "active": keep nudging playback for a few seconds.
        let nudges = 0;
        const nudge = setInterval(() => { attachRemote(c); if (++nudges >= 20 || finished) clearInterval(nudge); }, 250);
        const sess = c.telnyxIDs?.telnyxSessionId;
        supabase.from("calls").update({ answered: true, answered_at: answeredAt.toISOString(), ...(sess ? { telnyx_call_id: sess } : {}) }).eq("id", callId).then(() => {}, () => {});
        if (transcribe && ctx && c.remoteStream) {
          try {
            transcript = startTranscript({ callId, onLine: (l) => panel.addLine(l), onInterim: (i) => panel.interim(i), onFailed: () => panel.note("Live transcript unavailable — the call continues.") });
            stopAudio = await startCallAudio({ ctx, micStream: c.localStream || mic, remoteStream: c.remoteStream, onFrame: (b) => transcript?.sendAudio(b) });
            if ((profile.record_accepted_calls !== false || profile.record_all_calls === true) && window.MediaRecorder) {
              try { recorder = startRecorder({ ctx, micStream: c.localStream || mic, remoteStream: c.remoteStream }); panel.state("Recording and transcribing"); } catch { recorder = null; }
            }
          } catch { panel.note("Live transcript unavailable — the call continues."); }
        }
      }
      if (st === "hangup" || st === "destroy" || st === "purge") {
        // Ended without ever ringing or being answered = the call never got out (phone service problem, number
        // refused). Say so and offer the phone's own dialer instead of calling it "No answer".
        if (!answeredAt && !ringing && !finished) { await notConnected(c); return; }
        const unanswered = !answeredAt && !finished;
        await finish(answeredAt ? "Call ended" : "No answer");
        if (unanswered) opts.onNoAnswer?.(); // rang out (or the caller gave up while it rang): nobody picked up
      }
    });
    client.connect();
  } catch (e) {
    await fail("rtc_failed", e?.message);
  }
}
