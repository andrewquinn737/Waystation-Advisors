"""Prompt building for the coach. One source of truth: templates live in kb/ and are loaded into ai_kb_docs
(load_kb.py); the worker and the claude-connector both render from the DB copy, so a weekly retrain changes both.
Rendering is plain {{key}} substitution so the TypeScript side can do the same."""
import json, os, re, time

KB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kb")
_cache = {"at": 0.0, "docs": {}}
CACHE_SECONDS = 300


def render(tpl, **kw):
    return re.sub(r"\{\{(\w+)\}\}", lambda m: str(kw.get(m.group(1), "")), tpl)


def local_doc(track, slug):
    p = os.path.join(KB_DIR, track, slug + ".md")
    return open(p).read() if os.path.exists(p) else None


def docs(sb=None):
    """{(track, slug): row} from ai_kb_docs, cached 5 min; falls back to the local kb/ folder."""
    if sb is not None and time.time() - _cache["at"] < CACHE_SECONDS and _cache["docs"]: return _cache["docs"]
    out = {}
    if sb is not None:
        try:
            for r in sb.select("ai_kb_docs", "select=track,slug,title,body,kind,weight,version"):
                out[(r["track"], r["slug"])] = r
        except Exception:
            out = {}
    if not out:
        for track in ("shared", "data", "ma"):
            d = os.path.join(KB_DIR, track)
            for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
                if f.endswith(".md"):
                    out[(track, f[:-3])] = {"track": track, "slug": f[:-3], "body": open(os.path.join(d, f)).read(),
                                            "kind": "deep", "weight": 1}
    _cache.update(at=time.time(), docs=out)
    return out


def doc(sb, track, slug):
    r = docs(sb).get((track, slug))
    return r["body"] if r else (local_doc(track, slug) or "")


def playbook(sb, track, budget=9000):
    """Calls-derived playbook first (weight 3), then the router; research is only reachable through the router."""
    parts = [doc(sb, track, "calls_playbook"), doc(sb, track, "router")]
    text = "\n\n".join(p for p in parts if p).strip()
    return text[:budget]


def persona_block(p):
    """Readable card from a persona snapshot (ai_personas.persona + label/first_reaction/objection_types)."""
    lines = []
    def add(k, v):
        if v not in (None, "", [], {}): lines.append(f"- {k}: {v}")
    add("Name", p.get("name"))
    add("Business", ", ".join(x for x in [p.get("company"), p.get("industry"), p.get("city")] if x))
    add("Your role", p.get("role"))
    if p.get("followup"): add("Prior contact", "you have spoken with this caller before, so you know roughly who they are and why "
                              "they call; do not ask who they are with")
    add("Tone", p.get("tone"))
    add("How you talk", p.get("talk_style"))
    add("Patience", p.get("patience"))
    tk = p.get("talk") or {}
    if tk:
        add("Reply length", f"most of your replies are about {tk.get('words_median')} words; your longest are about "
            f"{tk.get('words_p90')} words. Stay inside that")
        qs = tk.get("question_share") or 0
        add("Questions", "you ask a lot of questions" if qs >= 0.35 else ("you ask some questions" if qs >= 0.15 else
            "you rarely ask questions; you mostly answer or react"))
    g = p.get("greeting") or {}
    if g:
        add("How you answer \"is this <name>?\"", ("you just confirm it, short (\"Yes.\", \"Speaking.\", \"It is.\")"
            if g.get("style") == "confirm" else "you answer warily and ask who is calling") +
            (f' (you said: "{g["quote"]}")' if g.get("quote") else ""))
    fr, wary = p.get("first_reaction"), g.get("style") != "confirm" or "?" in (g.get("quote") or "")
    if fr in ("busy", "hostile") or wary:
        add("How you answer \"how are you?\"", {"busy": "you skip the pleasantry and say you are busy or in the middle of something",
            "hostile": "you skip the pleasantry: \"Who's this?\" or \"What is this?\""}.get(fr, "short and wary: \"Fine. Who's this?\""))
    REACT = {"brush_off": "you politely shut it down within one or two replies after hearing why they called (not interested, "
                          "we can't help, take me off your list)",
             "hostile": "you get short and annoyed and end the call quickly",
             "busy": "you say you are busy or in the middle of something",
             "curious": "you are wary but ask what this is about and let them explain",
             "engaged": "you talk freely and answer their questions"}
    add("How you first reacted to this kind of call", f"{p.get('first_reaction')}: {REACT.get(p.get('first_reaction'), '')}" +
        (f' (you said: "{p["first_reaction_quote"]}")' if p.get("first_reaction_quote") else ""))
    objs = p.get("objections") or []
    if objs:
        lines.append("- Concerns you raised, in order:")
        for o in objs[:5]:
            lines.append(f'  - {o.get("type")}: "{o.get("quote", "")}"')
    add("What kept you talking", p.get("what_moved_them"))
    add("What lost you", p.get("what_lost_them"))
    add("How your real call ended", "; ".join(x for x in [p.get("result_plain"), p.get("outcome_plain")] if x))
    sig = p.get("signature_phrases") or []
    if sig:
        lines.append("- Things you actually said:")
        for s in sig[:6]: lines.append(f'  - "{s}"')
    return "\n".join(lines)


def prospect_system(sb, session):
    p, track, stage = session["persona"], session["track"], session["stage"]
    rules = session.get("rules") or doc(sb, "shared", "stage_rules_" + stage)
    focus = ", ".join(p.get("objection_types") or []) or "your real concerns"
    return render(doc(sb, "shared", "prompt_prospect"), persona_block=persona_block(p),
                  track_context=doc(sb, track, "track_context"), stage_rules=render(rules, focus=focus))


def transcript_text(turns, me="Caller", them="You"):
    return "\n".join(f"{me if t['role'] == 'intern' else them}: {t['text']}" for t in turns)


def prospect_user(turns):
    return ("The call so far (you are \"You\"):\n" + transcript_text(turns) +
            "\n\nReply as You with the JSON object only.")


def call_lines_text(lines):
    return "\n".join(f"{'Intern' if l['speaker'] == 'intern' else 'Owner'}: {l['text']}" for l in lines)


def feedback_system(sb, track):
    return render(doc(sb, "shared", "prompt_feedback"), playbook=playbook(sb, track))


def score_system(sb, track):
    return render(doc(sb, "shared", "prompt_practice_score"), playbook=playbook(sb, track))


def coach_system(sb, track):
    return render(doc(sb, "shared", "prompt_coach_update"), playbook=playbook(sb, track))


def feedback_text(a):
    """What the intern sees, assembled in code from the model's parts (no free-form essay)."""
    out = []
    for k in (a.get("keeps") or [])[:2]: out.append("Keep: " + k)
    for f in (a.get("fixes") or [])[:2]: out.append("Fix: " + f)
    if a.get("try_line"): out.append('Try next time: "' + a["try_line"].strip().strip('"') + '"')
    return "\n".join(out) or "No feedback this time."


def dumps(o):
    return json.dumps(o, ensure_ascii=False)
