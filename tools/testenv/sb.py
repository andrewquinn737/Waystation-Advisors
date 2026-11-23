"""Supabase Management API helper. LIVE is forced read-only; only TEST may write."""
import json, os, re, urllib.request, urllib.error
MCP = os.path.expanduser("~/Projects/First Project/.mcp.json")
LIVE_REF = "jabjrhkhnbabfihodqie"
_c = json.load(open(MCP))["mcpServers"]
LIVE_TOK = _c["supabase"]["env"]["SUPABASE_ACCESS_TOKEN"]
TEST_TOK = _c["supabase-test"]["env"]["SUPABASE_ACCESS_TOKEN"]
TEST_REF = [a for a in _c["supabase-test"]["args"] if a.startswith("--project-ref=")][0].split("=", 1)[1]
assert TEST_REF != LIVE_REF

def _req(tok, path, body=None, method=None, raw=False, _try=0):
    r = urllib.request.Request("https://api.supabase.com/v1" + path,
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json", "User-Agent": "waystation-testenv"})
    try:
        with urllib.request.urlopen(r, timeout=300) as f:
            d = f.read()
            return d if raw else json.loads(d or b"null")
    except urllib.error.HTTPError as e:
        if (e.code in (429, 502, 503, 504, 544)) and _try < 6:     # Management API throttle / pooler timeout (parallel suites, busy TEST db): back off and retry
            import time; time.sleep(2 * (_try + 1)); return _req(tok, path, body, method, raw, _try + 1)
        raise RuntimeError(f"{e.code} {e.read().decode()[:2000]}")
    except (TimeoutError, urllib.error.URLError) as e:
        # a read timeout may mean the server DID run it: only repeat plain reads
        if _try < 3 and isinstance(body, dict) and str(body.get("query", "")).lstrip().lower().startswith("select") and not re.search(r"\b(set_config|nextval|insert|update|delete)\b", str(body.get("query", "")), re.I):
            import time; time.sleep(3 * (_try + 1)); return _req(tok, path, body, method, raw, _try + 1)
        raise

_WRITE = re.compile(r"\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|comment|copy|call|do|vacuum|reindex|cluster|refresh|lock|security|nextval|setval|pg_terminate_backend|pg_cancel_backend)\b|\b(http_\w+|net\.\w+)|\b(un)?schedule\s*\(", re.I)

def live_sql(sql):
    """LIVE is read-only: server-enforced (read_only transaction) AND a client-side
    keyword guard. Never bypass; there is deliberately no live write helper."""
    if _WRITE.search(re.sub(r"'(?:[^']|'')*'", "''", sql)):
        raise PermissionError("live_sql refuses anything that could write: " + sql[:120])
    return _req(LIVE_TOK, f"/projects/{LIVE_REF}/database/query", {"query": sql, "read_only": True})

def live_get(path, raw=False):
    return _req(LIVE_TOK, f"/projects/{LIVE_REF}{path}", raw=raw)

# PILOT GUARD: two real reps (Andrew Quinn, Jonah Johnson) place real calls from the TEST project. No harness code may log in as them or
# write anything that names them. Reads (select) are allowed so their data can be checked.
PILOT_EMAILS = ("test.andrew.quinn@example.com", "test.jonah.johnson@example.com")
PILOT_IDS = ("49255b71-de62-45d4-a252-c0b3e2ab91e9", "18e3e191-5e10-4022-959d-f6172f7e86fa")
def guard_pilot(*who):
    for w in who:
        if str(w).strip().lower() in PILOT_EMAILS or str(w).strip().lower() in PILOT_IDS or str(w).strip() in ("Andrew Quinn", "Jonah Johnson"):
            raise PermissionError(f"pilot guard: the harness may not use the pilot account {w}")

def test_sql(sql):
    low = sql.lower()
    if not low.lstrip().startswith(("select", "with")) and any(x in low for x in PILOT_EMAILS + PILOT_IDS):
        raise PermissionError("pilot guard: refusing a write that names a pilot account")
    return _req(TEST_TOK, f"/projects/{TEST_REF}/database/query", {"query": sql})

def test_api(path, body=None, method=None, raw=False):
    return _req(TEST_TOK, f"/projects/{TEST_REF}{path}", body, method, raw)
