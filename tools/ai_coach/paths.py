"""Expert-system reply engine for the practice owner. Owner lines come from real calls:
1. classify the intern's line into a caller move (TF-IDF nearest neighbours over labeled real caller turns + rules),
   so no exact phrasing is needed;
2. PATH: if that move is what the real caller did next in the persona's source call, the real owner's reply comes back;
3. BANK: otherwise the closest real caller turns with that move (same track, owner side, weighted by outcome and by how
   alike the owners are) supply candidate replies;
4. only when nothing fits does the model write a new line (handlers.practice_turn), and code tags its source.
Stdlib only. The bank is built offline (build_bank) and stored per track in ai_kb_docs (slug turn_bank)."""
import json, math, re, collections
import taxonomy as T

RULES = [  # (move, regex): cheap expert rules that back up the neighbours on the common moves
    ("how_are_you", r"\bhow (are|r) (you|ya)( doing| today)?\b|how'?s it going|how you doing"),
    ("name_check", r"^(hi|hey|hello)?[ ,.]*(is this|am i (speaking|talking) (with|to)) \w+\??$"),
    ("weird_request", r"weird request|strange request|odd request"),
    ("pay_offer", r"\bpay (you|your company|to)|compensat|buy a copy|license a copy"),
    ("buyer_intro", r"(client|buyer).{0,40}(acquir|buy|purchas)"),
    ("ask_selling", r"(thought|think|considered) about selling|open to selling|interested in selling"),
    ("ask_meeting", r"(\d+|fifteen|twenty|quick) minute|set up a (quick )?call|hop on a call|schedule a (call|time)|would (you|tuesday|monday|wednesday|thursday|friday).{0,30}work"),
    ("get_contact", r"(best|good) (email|number)|email address|what'?s your email|send (you|it) (an|over)"),
    ("wrap_up", r"(thank you|thanks)( so much)?( for your time)?[.!]? (have a|you too)|have a (good|great) (one|day)"),
]
STOP = set("the a an and or to of i you we it is that this for in on at with be so um uh like just yeah okay ok".split())


def toks(t):
    w = [x for x in re.findall(r"[a-z']+", (t or "").lower()) if x not in STOP]
    return w + [a + "_" + b for a, b in zip(w, w[1:])]


def overlap(a, b):
    a, b = set(re.findall(r"[a-z']+", a.lower())), set(re.findall(r"[a-z']+", b.lower()))
    return len(a & b) / max(1, len(a)) if a else 0.0


class Bank:
    def __init__(self, data):
        self.track, self.turns = data["track"], data["turns"]
        df = collections.Counter(x for t in self.turns for x in set(toks(t["t"])))
        n = len(self.turns) or 1
        self.idf = {k: math.log((n + 1) / (v + 1)) + 1 for k, v in df.items()}
        self.vecs = [self.vec(t["t"]) for t in self.turns]
        self.post = collections.defaultdict(list)
        for i, v in enumerate(self.vecs):
            for k in v: self.post[k].append(i)

    def vec(self, text):
        tf = collections.Counter(toks(text))
        v = {k: c * self.idf.get(k, 2.0) for k, c in tf.items()}
        nrm = math.sqrt(sum(x * x for x in v.values())) or 1
        return {k: x / nrm for k, x in v.items()}

    def near(self, text, k=25):
        q, sc = self.vec(text), collections.Counter()
        for key, x in q.items():
            for i in self.post.get(key, ()): sc[i] += x * self.vecs[i][key]
        return sc.most_common(k)

    def classify(self, text):
        """-> (move, confidence 0..1, neighbours)."""
        nb = self.near(text)
        votes = collections.Counter()
        for i, s in nb[:12]: votes[self.turns[i]["m"]] += s
        for mv, rx in RULES:
            if mv in T.CALLER[self.track] and re.search(rx, text, re.I): votes[mv] += 0.8
        if not votes: return "other", 0.0, nb
        mv, top = votes.most_common(1)[0]
        return mv, round(top / (sum(votes.values()) or 1), 2), nb

    def candidates(self, text, move, persona, nb=None, n=4):
        """Real owner replies to caller turns like this one, best first."""
        nb = nb or self.near(text, 40)
        fr, out, seen = persona.get("first_reaction"), [], set()
        for i, s in nb:
            t = self.turns[i]
            if t["m"] != move and s < .5: continue
            if persona.get("exclude_call") and t.get("c") == persona["exclude_call"]: continue   # blind tests
            if not t.get("r") or t["r"] in seen: continue
            sc = s * (1 + .3 * math.log1p(t.get("w", 1))) * (1.5 if t.get("fr") == fr else 1) * (1.3 if t["m"] == move else 1)
            out.append((round(sc, 3), t)); seen.add(t["r"])
        out.sort(key=lambda x: -x[0])
        return [dict(t, score=sc) for sc, t in out[:n]]


def path_step(path, pos, move, conf):
    """Index of the next real caller turn in the source call that matches this move (allowing a skip of up to 2)."""
    for j in range(pos, min(len(path), pos + 3)):
        if path[j]["m"] == move: return j
    if conf < .45 and pos < len(path) and T.section_of_any(path[pos]["m"]) == T.section_of_any(move): return pos
    return None


PITCH_MOVES = {"intro_self", "weird_request", "research_reason", "why_you", "pay_offer", "buyer_intro", "buyer_profile", "ask_selling"}


def flags_from_act(act, obj, move, opener_set):
    """Turn a real reply's act label into the practice flags the session uses."""
    f = {}
    if act in ("hang_up", "ending"): f["hang_up"] = True
    if act == "objection" and obj: f["objection"] = obj
    if act == "agree_next_step": f["agreed_next_step"] = True
    if not opener_set and move in PITCH_MOVES:
        f["opener_ok"] = act not in ("brush_off", "hang_up", "ending", "objection")
    return f


# ------------------------------------------------------------------------------------------------- offline build
def owner_reply(lines, labels, i):
    """Owner turns right after caller turn i, until the caller speaks again."""
    txt, act, obj = [], None, None
    for j in range(i + 1, len(lines)):
        if lines[j][0] == "intern": break
        if lines[j][0] != "owner": continue
        txt.append(lines[j][1]); lb = labels[j] or {}
        if act is None or lb.get("act") in ("objection", "brush_off", "hang_up", "agree_next_step"):
            act, obj = lb.get("act") or act, lb.get("obj") or obj
    return " ".join(txt)[:400], act, obj


def call_path(c):
    """The labeled caller-move / owner-reply sequence from the moment the decision maker is on the line."""
    start, out = max(0, c.get("dm", 0) or 0), []
    for i in range(start, len(c["lines"])):
        s, t, _ = c["lines"][i]
        lb = (c["labels"] or [None] * len(c["lines"]))[i] or {}
        if s != "intern" or not lb.get("move"): continue
        r, a, o = owner_reply(c["lines"], c["labels"], i)
        out.append({"m": lb["move"], "t": t[:240], "r": r, "a": a, "o": o})
    return out


def build_bank(calls, track, weight_fn):
    turns = []
    for c in calls:
        if c.get("track") != track or c.get("dm", -1) < 0: continue
        fr = (c.get("ai") or {}).get("first_reaction")
        for p in call_path(c):
            turns.append(dict(p, c=c["id"][:8], w=weight_fn(c), fr=fr))
    return {"track": track, "turns": turns}


def dumps(b): return json.dumps(b, ensure_ascii=False, separators=(",", ":"))
