// Mixes the two sides of a call into ONE 2-channel, 16 kHz, 16-bit stream for Deepgram:
// channel 0 = this person's mic, channel 1 = the owner (the call's remote audio). The mix is
// only analysed — it is never played (the call's own <audio> element plays the owner), so there
// is no echo. Frames of ~100 ms are handed to onFrame(ArrayBuffer).

const WORKLET_SRC = `
class Pcm2 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(3200); this.n = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp[0]) return true;
    const a = inp[0], b = inp[1] || inp[0];
    for (let i = 0; i < a.length; i++) {
      this.buf[this.n++] = Math.max(-1, Math.min(1, a[i])) * 32767;
      this.buf[this.n++] = Math.max(-1, Math.min(1, b[i])) * 32767;
      if (this.n >= this.buf.length) { const out = this.buf.slice(0).buffer; this.port.postMessage(out, [out]); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("pcm2", Pcm2);`;

export async function startCallAudio({ ctx, micStream, remoteStream, onFrame }) {
  await ctx.resume();
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const merger = ctx.createChannelMerger(2);
  const mic = ctx.createMediaStreamSource(micStream);
  const remote = ctx.createMediaStreamSource(remoteStream);
  mic.connect(merger, 0, 0);
  remote.connect(merger, 0, 1);
  const node = new AudioWorkletNode(ctx, "pcm2", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit" });
  node.port.onmessage = (e) => onFrame(e.data);
  const mute = ctx.createGain(); // silent sink so the graph keeps running, nothing audible
  mute.gain.value = 0;
  merger.connect(node);
  node.connect(mute).connect(ctx.destination);
  return () => {
    try { node.port.onmessage = null; node.disconnect(); merger.disconnect(); mic.disconnect(); remote.disconnect(); } catch { /* already gone */ }
  };
}
