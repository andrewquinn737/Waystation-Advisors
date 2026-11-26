"""Transcript cleaning, used by the offline build (staging clean.py) and by live feedback (handlers.call_feedback).
Per call: IVR lines tagged out, echo lines dropped, speaker swaps fixed, fragments merged into turns,
track decided from what the caller actually pitched (not the list), CRM outcome vs transcript mismatches flagged."""
import json, re, collections
from statistics import median

IVR = re.compile(r"(press|dial) (\d|one|two|star|pound)|extension|business hours|please (hold|stay on the line)|"
                 r"(call|calls) (may|will) be (monitored|recorded)|record your name|leave (a|your) message|after the (tone|beep)|"
                 r"mailbox|not available.*(message|tone)|is unavailable|thank you for calling|directory|voicemail|"
                 r"you have reached|forwarded to|automated|at the tone|google (voice|subscriber)|no one is available", re.I)
PITCH = re.compile(r"my name is|i'?m (calling|reaching out)|calling (from|with|on behalf)|working signal|weird request|"
                   r"we have a (client|buyer)|interested in acquir|license business|pay to access", re.I)
DATA = re.compile(r"working signal|weird request|records?|pay (you|to access|for)|licens|data\b|\bai\b|artificial|"
                  r"anthropic|openai|training|research(ing)? (the |your )?industry|project (files|records)|archive", re.I)
MA = re.compile(r"acquir|acquisition|buyer|buy (your|the) (business|company)|sell(ing)? (your|the) (business|company)|"
                r"thought about selling|succession|retire|individual operator|not a fund|valuation|exit", re.I)
NEG = re.compile(r"not interested|no thank|don'?t call|take (me|us) off|remove (me|us)|we'?re (good|fine)|not for us|no,? thanks", re.I)
POS = re.compile(r"sounds (good|great)|that works|let'?s do|i'?d be (open|interested)|sure,? (go ahead|send)|"
                 r"what (day|time)|tuesday|wednesday|thursday|monday|friday|o'?clock|\d ?(am|pm|p\.m\.|a\.m\.)", re.I)
W = lambda t: set(re.findall(r"[a-z']+", t.lower()))


def overlap(a, b):
    a, b = W(a), W(b)
    return len(a & b) / max(1, min(len(a), len(b))) if len(a) >= 3 and len(b) >= 3 else 0


def clean(r):
    L = [[s, t.strip(), int(ms or 0)] for s, t, ms in r["lines"] if t and t.strip()]
    flags = []
    # 1. speaker swap: the pitch lives on the owner channel
    po = sum(bool(PITCH.search(t)) for s, t, _ in L if s == "owner")
    pi = sum(bool(PITCH.search(t)) for s, t, _ in L if s == "intern")
    if po >= 2 and po > 2 * pi:
        L = [["intern" if s == "owner" else "owner", t, ms] for s, t, ms in L]; flags.append("speaker_swap")
    # 2. IVR / recorded prompts: owner-side machine lines, mostly before a human answers
    human = False
    for x in L:
        if x[0] == "owner" and IVR.search(x[1]) and not human: x[0] = "ivr"
        elif x[0] == "owner" and len(W(x[1])) >= 2 and not IVR.search(x[1]): human = True
        elif x[0] == "owner" and IVR.search(x[1]) and len(x[1]) > 60: x[0] = "ivr"   # later "please leave a message after the tone"
    # 3. echo: an owner line that repeats an intern line within 5s is crosstalk on the wrong channel
    ints = [(ms, t) for s, t, ms in L if s == "intern"]
    keep = []
    for x in L:
        if x[0] == "owner" and any(abs(x[2] - ms) <= 5000 and overlap(x[1], t) > .7 and len(W(x[1])) >= 4 for ms, t in ints):
            flags.append("echo"); continue
        keep.append(x)
    # 4. merge same-speaker fragments (gap < 2.5s) into turns
    turns = []
    for s, t, ms in keep:
        if turns and turns[-1][0] == s and ms - turns[-1][3] < 2500:
            turns[-1][1] += " " + t; turns[-1][3] = ms
        else: turns.append([s, t, ms, ms])
    turns = [[s, re.sub(r"\s+", " ", t), ms] for s, t, ms, _ in turns]
    # 5. track from what the caller pitched
    it = " ".join(t for s, t, _ in turns if s == "intern")
    d, m = len(DATA.findall(it)), len(MA.findall(it))
    ai_t = (r.get("ai") or {}).get("track")
    track = "data" if d >= 2 and d > 1.5 * m else "ma" if m >= 1 and m > 1.5 * d else ai_t if ai_t in ("data", "ma") else "unclear"
    if ai_t in ("data", "ma") and track in ("data", "ma") and track != ai_t: flags.append(f"track_fixed:{ai_t}->{track}")
    # 6. outcome vs transcript
    ow = " ".join(t for s, t, _ in turns if s == "owner")
    oc = r.get("outcome")
    if oc in ("intro_call_scheduled", "callback_interested") and NEG.search(ow) and not POS.search(ow): flags.append("outcome_vs_transcript:pos_but_neg")
    if oc in ("not_interested", "no_response") and POS.search(ow) and not NEG.search(ow) and len(turns) > 10: flags.append("outcome_vs_transcript:neg_but_pos")
    owner_turns = sum(s == "owner" and len(W(t)) >= 1 for s, t, _ in turns)
    junk = owner_turns < 2 or sum(s == "intern" for s, *_ in turns) < 2
    return dict(r, lines=turns, track=track, clean_flags=flags, junk=junk,
                raw_lines=len(r["lines"]), owner_turns=owner_turns)



def clean_lines(lines):
    """call_lines rows ({speaker,text,start_ms}) -> cleaned turns in the same shape, machine lines dropped."""
    c = clean({"lines": [[l["speaker"], l.get("text") or "", l.get("start_ms")] for l in lines]})
    return [{"speaker": s, "text": t, "start_ms": ms} for s, t, ms in c["lines"] if s in ("intern", "owner")]
