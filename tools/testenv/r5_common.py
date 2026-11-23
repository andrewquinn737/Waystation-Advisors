"""Shared bits for the round-5 browser checks (test_round5.py, test_round5_ui.py): result counting, contrast math, a mocked Admin > Campaigns."""
import json, re
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))
def summary():
    ok = sum(results); print(f"\n{ok}/{len(results)} passed"); return ok == len(results)
UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
LUM = """(c) => { const m = c.match(/[\\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
  return .2126 * f(m[0]) + .7152 * f(m[1]) + .0722 * f(m[2]); }"""
def contrast(p, sel):
    """Text colour against the first opaque background at or above the element."""
    return p.evaluate("(sel) => { const L = " + LUM + "; const e = document.querySelector(sel), cs = getComputedStyle(e); let bg = cs.backgroundColor, n = e;"
                      " while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && n.parentElement) { n = n.parentElement; bg = getComputedStyle(n).backgroundColor; }"
                      " const a = L(cs.color), b = L(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }", sel)
def token_contrast(p, token, bg_token="--bg"):
    return p.evaluate("([t, b]) => { const L = " + LUM + "; const cs = getComputedStyle(document.documentElement);"
                      " const px = document.createElement('i'); document.body.appendChild(px);"
                      " const rgb = (v) => { px.style.color = v; return getComputedStyle(px).color; };"
                      " const a = L(rgb(cs.getPropertyValue(t).trim())), c = L(rgb(cs.getPropertyValue(b).trim())); px.remove();"
                      " return (Math.max(a, c) + .05) / (Math.min(a, c) + .05); }", [token, bg_token])
def mock_campaigns(ctx):
    """Display-only campaigns. Every call that could send, pause or resume is aborted and counted."""
    counts = lambda **k: dict({"leads": 0, "backup": 0, "ready": 0, "need_fix": 0, "started": 0, "active": 0, "copy_changed": 0, "emails_sent": 0, "contacted": 0, "replied": 0, "interested": 0, "intro_calls": 0, "bounced": 0}, **k)
    base = {"owner": "Review Owner", "owner_id": "00000000-0000-0000-0000-000000000001", "mandate": "ma", "created_at": "2026-11-01T12:00:00Z", "mailboxes": 3, "has_spintax": True, "bounce_paused": False, "paused_reason": None}
    rows = [dict(base, list_id="00000000-0000-0000-0000-0000000000a1", name="REVIEW_R5 ready", status="ready", launched_at="2026-11-10T12:00:00Z", counts=counts(ready=1240, started=300, leads=1540, emails_sent=900, contacted=300, replied=12)),
            dict(base, list_id="00000000-0000-0000-0000-0000000000a2", name="REVIEW_R5 bounce paused", status="paused", bounce_paused=True, paused_reason="Auto-paused: bounce rate 7.2% (9 of 125 sends bounced)", launched_at="2026-11-10T12:00:00Z", counts=counts(ready=10, started=125, bounced=9)),
            dict(base, list_id="00000000-0000-0000-0000-0000000000a3", name="REVIEW_R5 live", status="live", launched_at="2026-11-10T12:00:00Z", counts=counts(ready=5, started=50, active=40)),
            dict(base, list_id="00000000-0000-0000-0000-0000000000a4", name="REVIEW_R5 needs edits", status="draft", counts=counts(need_fix=12))]
    attempts = []
    ok = lambda body: (lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(body)))
    ctx.route("**/rest/v1/rpc/admin_campaigns*", ok(rows))
    ctx.route("**/rest/v1/rpc/campaign_launch_preview*", ok([{"ready": 1240, "mailboxes": [], "mandate": "ma", "suppressed": 0, "duplicate": 0}]))
    for fn in ("campaign_pause", "campaign_resume", "campaign_launched"):
        ctx.route(f"**/rest/v1/rpc/{fn}*", lambda r, fn=fn: (attempts.append(fn), r.abort()))
    ctx.route("**/functions/v1/start-emails*", lambda r: (attempts.append("start-emails"), r.abort()))
    return attempts
