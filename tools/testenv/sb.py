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
        with urllib.request.urlopen(r, timeout=120) as f:
            d = f.read()
            return d if raw else json.loads(d or b"null")
    except urllib.error.HTTPError as e:
        if e.code == 429 and _try < 6:     # Management API throttle (parallel suites): back off and retry
            import time; time.sleep(2 * (_try + 1)); return _req(tok, path, body, method, raw, _try + 1)
        raise RuntimeError(f"{e.code} {e.read().decode()[:2000]}")

_WRITE = re.compile(r"\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|comment|copy|call|do|vacuum|reindex|cluster|refresh|lock|security|nextval|setval|pg_terminate_backend|pg_cancel_backend)\b|\b(http_\w+|net\.\w+)|\b(un)?schedule\s*\(", re.I)

def live_sql(sql):
    """LIVE is read-only: server-enforced (read_only transaction) AND a client-side
    keyword guard. Never bypass; there is deliberately no live write helper."""
    if _WRITE.search(re.sub(r"'(?:[^']|'')*'", "''", sql)):
        raise PermissionError("live_sql refuses anything that could write: " + sql[:120])
    return _req(LIVE_TOK, f"/projects/{LIVE_REF}/database/query", {"query": sql, "read_only": True})

def live_get(path, raw=False):
    return _req(LIVE_TOK, f"/projects/{LIVE_REF}{path}", raw=raw)

def test_sql(sql):
    return _req(TEST_TOK, f"/projects/{TEST_REF}/database/query", {"query": sql})

def test_api(path, body=None, method=None, raw=False):
    return _req(TEST_TOK, f"/projects/{TEST_REF}{path}", body, method, raw)
