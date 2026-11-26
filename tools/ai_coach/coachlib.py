"""Shared pieces for the AI Call Coach: Supabase REST client, a one-shot `claude -p` runner on the owner's subscription,
and tolerant JSON extraction. Stdlib only, so it runs on the Oracle VM next to tools/ai_worker without a venv."""
import json, os, re, subprocess, time, urllib.error, urllib.parse, urllib.request

AUTH_RE = re.compile(r"not logged in|please run /login|invalid (api key|bearer token)|failed to authenticate|authentication[_ ]?(failed|error)|\b401\b", re.I)
LIMIT_RE = re.compile(r"usage limit|rate[ _-]?limit|limit reached|hit your limit|too many requests|\b429\b|overloaded", re.I)


class ClaudeError(Exception):
    def __init__(self, msg, kind="error"):
        super().__init__(msg); self.kind = kind      # kind: auth | limit | error


class Sb:
    """Minimal PostgREST client with the service role key (bypasses RLS: the worker is trusted, prompts are not)."""
    def __init__(self, url, key):
        self.url, self.key = url.rstrip("/"), key

    def _req(self, method, path, body=None, headers=None, timeout=30):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json", **(headers or {})}
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"{self.url}/rest/v1/{path}", data=data, method=method, headers=h)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    raw = r.read().decode() or "null"
                    return json.loads(raw)
            except urllib.error.HTTPError as e:
                msg = e.read().decode()[:400]
                if e.code >= 500 and attempt < 3: time.sleep(1 + attempt * 2); continue
                raise RuntimeError(f"{method} {path.split('?')[0]} -> {e.code}: {msg}")
            except (urllib.error.URLError, TimeoutError):
                if attempt < 3: time.sleep(1 + attempt * 2); continue
                raise

    def rpc(self, fn, args=None):
        return self._req("POST", f"rpc/{fn}", args or {})

    def select(self, table, query):
        return self._req("GET", f"{table}?{query}") or []

    def insert(self, table, rows, upsert_on=None):
        q = f"?on_conflict={upsert_on}" if upsert_on else ""
        pref = "return=representation" + (",resolution=merge-duplicates" if upsert_on else "")
        return self._req("POST", table + q, rows, {"Prefer": pref})

    def update(self, table, match, values):
        q = "&".join(f"{k}=eq.{urllib.parse.quote(str(v))}" for k, v in match.items())
        return self._req("PATCH", f"{table}?{q}", values, {"Prefer": "return=representation"})

    def delete(self, table, match):
        q = "&".join(f"{k}=eq.{urllib.parse.quote(str(v))}" for k, v in match.items())
        return self._req("DELETE", f"{table}?{q}")


def claude_env(token=None):
    e = {"HOME": os.path.expanduser("~"), "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
         "DISABLE_AUTOUPDATER": "1", "LANG": "C.UTF-8"}
    tok = token or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if tok: e["CLAUDE_CODE_OAUTH_TOKEN"] = tok
    return e


def run_claude(prompt, system, model="sonnet", timeout=180, claude_bin=None, cwd=None, token=None):
    """One stateless call: no tools, no session saved, our own system prompt. Returns the reply text."""
    exe = claude_bin or os.environ.get("CLAUDE_BIN") or os.path.expanduser("~/.local/bin/claude")
    if not os.path.exists(exe): exe = "claude"
    argv = [exe, "-p", "--output-format", "json", "--system-prompt", system, "--tools", "", "--model", model,
            "--no-session-persistence", "--max-turns", "1", "--setting-sources", ""]
    try:
        p = subprocess.run(argv, input=prompt, capture_output=True, text=True, timeout=timeout, env=claude_env(token),
                           cwd=cwd or os.environ.get("COACH_WORK_DIR") or "/tmp")
    except subprocess.TimeoutExpired:
        raise ClaudeError("claude timed out")
    out, err = p.stdout.strip(), p.stderr.strip()
    try:
        res = json.loads(out.splitlines()[-1]) if out else {}
    except ValueError:
        res = {}
    text = res.get("result") if isinstance(res, dict) else None
    blob = f"{text or ''} {err} {out[-300:]}"
    if res.get("is_error") or p.returncode != 0 or text is None:
        if AUTH_RE.search(blob): raise ClaudeError("Claude is not signed in on the server", "auth")
        if LIMIT_RE.search(blob): raise ClaudeError("Claude usage limit", "limit")
        raise ClaudeError(f"claude failed (exit {p.returncode}): {blob.strip()[:300]}")
    return text


def parse_json(text):
    """First JSON object or array in a model reply (tolerates code fences and prose around it)."""
    if text is None: return None
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.M)
    pairs = sorted((("{", "}"), ("[", "]")), key=lambda oc: t.find(oc[0]) if t.find(oc[0]) != -1 else 1 << 30)
    for opener, closer in pairs:          # whichever comes first: an array of objects must not parse as its first object
        i = t.find(opener)
        while i != -1:
            depth, instr, esc = 0, False, False
            for j in range(i, len(t)):
                ch = t[j]
                if instr:
                    if esc: esc = False
                    elif ch == "\\": esc = True
                    elif ch == '"': instr = False
                    continue
                if ch == '"': instr = True
                elif ch == opener: depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        try: return json.loads(t[i:j + 1])
                        except ValueError: break
            i = t.find(opener, i + 1)
    return None


def norm(s):
    return re.sub(r"[^a-z0-9 ]+", "", re.sub(r"\s+", " ", (s or "").lower())).strip()


def quote_in(quote, haystack, n=40):
    """Verbatim gate: the first n normalized chars of the quote appear in the transcript."""
    q = norm(quote)[:n]
    return bool(q) and q in norm(haystack)


def no_dashes(s):
    """House copy rule: no em or en dashes in anything an intern reads."""
    return re.sub(r"\s*[—–]\s*", ", ", s or "")
