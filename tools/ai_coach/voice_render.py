"""Pre-record every owner line in the voice kit with Kokoro (local, Apache 2.0, no API) and upload to TEST storage.
Reads bank/voice/render.jsonl (voice_kit.py), writes bank/voice/clips/{voice}/{id}.mp3 (24 kHz mono, silence trimmed),
then uploads clips + kit files to the TEST bucket coach-voice (skips files already uploaded unless --force).
Usage: .venv/bin/python voice_render.py [--render-only|--upload-only] [--limit N]"""
import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "bank", "voice")
MODEL = os.path.expanduser("~/.cache/kokoro")
SPEED = {"am_michael": 1.08, "am_puck": 1.05, "af_heart": 1.06, "af_bella": 1.04}   # phone talk runs a bit quick
BUCKET = "coach-voice"


def trim(x, sr, thr=.012, pad=.04):
    idx = np.where(np.abs(x) > thr)[0]
    if not len(idx): return x
    a, b = max(0, idx[0] - int(pad * sr)), min(len(x), idx[-1] + int(pad * sr * 2))
    return x[a:b]


def render(limit=None):
    import soundfile as sf
    from kokoro_onnx import Kokoro
    k = Kokoro(os.path.join(MODEL, "kokoro-v1.0.onnx"), os.path.join(MODEL, "voices-v1.0.bin"))
    jobs = [json.loads(l) for l in open(os.path.join(OUT, "render.jsonl"))][:limit]
    t0, done = time.time(), 0
    for j in jobs:
        p = os.path.join(OUT, "clips", j["voice"], f"{j['id']}.mp3")
        if os.path.exists(p): continue
        os.makedirs(os.path.dirname(p), exist_ok=True)
        x, sr = k.create(j["text"], voice=j["voice"], speed=SPEED.get(j["voice"], 1.05), lang="en-us")
        sf.write(p, trim(np.asarray(x, dtype="float32"), sr), sr, format="MP3")
        done += 1
        if done % 100 == 0: print(f"[{done}/{len(jobs)}] {time.time() - t0:.0f}s", flush=True)
    print("rendered", done, f"{time.time() - t0:.0f}s", flush=True)


def upload(force=False):
    import dev_sb
    sb = dev_sb.test_client()
    base, key = sb.url if hasattr(sb, "url") else sb.base, sb.key
    files = [(os.path.join(OUT, f), f) for f in os.listdir(OUT) if f.startswith(("kit_", "emb_"))]
    for v in os.listdir(os.path.join(OUT, "clips")):
        for f in os.listdir(os.path.join(OUT, "clips", v)): files.append((os.path.join(OUT, "clips", v, f), f"clips/{v}/{f}"))
    sent = os.path.join(OUT, "_uploaded.json")
    have = set() if force or not os.path.exists(sent) else set(json.load(open(sent)))
    todo = [(p, n) for p, n in files if n not in have or n.startswith(("kit_", "emb_"))]
    ctype = lambda n: "audio/mpeg" if n.endswith(".mp3") else "application/json" if n.endswith(".json") else "application/octet-stream"

    def put(pn):
        p, n = pn
        for i in range(4):
            try:
                rq = urllib.request.Request(f"{base}/storage/v1/object/{BUCKET}/{n}", data=open(p, "rb").read(), method="POST",
                                            headers={"Authorization": f"Bearer {key}", "apikey": key, "x-upsert": "true",
                                                     "Content-Type": ctype(n), "Cache-Control": "max-age=86400"})
                urllib.request.urlopen(rq, timeout=60).read(); return n
            except Exception as e:
                if i == 3: print("FAIL", n, e, flush=True); return None
                time.sleep(2 ** i)

    with ThreadPoolExecutor(8) as ex: ok = [n for n in ex.map(put, todo) if n]
    json.dump(sorted(have | set(ok)), open(sent, "w"))
    print("uploaded", len(ok), "of", len(todo), flush=True)


if __name__ == "__main__":
    a = sys.argv[1:]
    lim = int(a[a.index("--limit") + 1]) if "--limit" in a else None
    if "--upload-only" not in a: render(lim)
    if "--render-only" not in a: upload("--force" in a)
