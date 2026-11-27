"""One-time Haiku tags for every owner reply in the voice kit, so the browser picker can avoid bad picks with no LLM per
turn. Writes bank/voice/_tags.json: {reply: {"ok": 0|1, "s": "+"|"-"|"0", "k": kind}}. Resumable (checkpoint).
ok = 0: garbled, a transcript fragment, or only makes sense with context a practice call won't have.
kinds: who (asks who is calling / what company), what (asks what it is about), decline, accept, defer (later, busy,
send info), question (any other question), ack (yeah / okay / mhmm), info (a statement about the business), bye, other.
Usage: .venv/bin/python voice_tags.py"""
import json, os, sys
from collections import Counter, defaultdict
sys.path.insert(0, os.path.expanduser("~/Projects/First Project/pipeline"))
from llm_pool import map_batched
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "bank", "voice")
KINDS = {"who", "what", "decline", "accept", "defer", "question", "ack", "info", "bye", "other"}

def prompt(batch):
    rows = "\n".join(f"{i}. CALLER: {c[:160]}\n   OWNER: {r}" for i, (r, c) in enumerate(batch))
    return ("These are owner replies from real cold calls (a caller offering to buy the owner's business or its old records). "
            "Tag each OWNER line for reuse in a practice call simulator.\n"
            "ok: 1 if the line is a clear, natural thing an owner says on the phone that could follow a similar caller line; "
            "0 if garbled, two fragments run together, a cut-off piece, or it names specifics that only fit that one call.\n"
            "stance toward the caller: + (open, agreeing), - (resisting, declining), 0 (neutral).\n"
            "kind: one of who, what, decline, accept, defer, question, ack, info, bye, other "
            "(who = asks who is calling or what company; what = asks what this is about; defer = later, busy, send info).\n"
            "Answer one line per item, exactly: index|ok|stance|kind. No other text.\n\n" + rows)

def parse(out):
    res = {}
    for ln in (out or "").splitlines():
        p = [x.strip() for x in ln.strip().split("|")]
        if len(p) == 4 and p[0].isdigit() and p[1] in "01" and p[2] in "+-0" and p[3] in KINDS:
            res[int(p[0])] = {"ok": int(p[1]), "s": p[2], "k": p[3]}
    return [res.get(i) for i in range(max(res) + 1)] if res else None

def main():
    ctx = defaultdict(Counter)
    for tr in ("data", "ma"):
        k = json.load(open(os.path.join(OUT, f"kit_{tr}.json")))
        for t in k["turns"]:
            if t["r"]: ctx[t["r"]][t["t"]] += 1
        for p in k["personas"].values():
            for s in p["path"]:
                if s["r"]: ctx[s["r"]][s["t"]] += 1
    items = sorted((r, c.most_common(1)[0][0]) for r, c in ctx.items())
    res = map_batched(items, 20, prompt, parse, concurrency=5, model="haiku", max_retries=1,
                      checkpoint=os.path.join(OUT, "_tags.ckpt.json"))
    tags = {r: t for (r, _), t in zip(items, res) if t}
    json.dump(tags, open(os.path.join(OUT, "_tags.json"), "w"), ensure_ascii=False, indent=0)
    print("tagged", len(tags), "of", len(items), Counter(t["k"] for t in tags.values()), "not ok", sum(1 - t["ok"] for t in tags.values()))

if __name__ == "__main__":
    main()
