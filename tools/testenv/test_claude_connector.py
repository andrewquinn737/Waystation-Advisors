"""Tests for the claude-connector MCP edge function on the TEST project (raw HTTP JSON-RPC).
People act through their own connector tokens (created by RPC with their user JWT); setup uses the DB owner.
Run: python3 test_claude_connector.py   (cleans up only 'TEST-CONN %' lists, its tokens and a temp 'data' guideline)"""
import json, urllib.request, urllib.error, uuid
import test_sequences as T
from test_sequences import sb, q, lit, uid, rpc, login, URL, ANON, CALEB, GAVIN, LEAD_A, check

AUSTIN = "test.austin.price@example.com"
ENDPOINT = URL + "/functions/v1/claude-connector"
EMDASH = "—"

def post(token, body, path=None):
    url = ENDPOINT + (path if path is not None else f"/mcp/{token}")
    r = urllib.request.Request(url, method="POST", data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(r) as f:
            d = f.read(); return f.status, (json.loads(d) if d else None)
    except urllib.error.HTTPError as e:
        d = e.read(); 
        try: return e.code, json.loads(d)
        except Exception: return e.code, d.decode()

_id = [0]
def call(token, method, params=None):
    _id[0] += 1
    return post(token, {"jsonrpc": "2.0", "id": _id[0], "method": method, "params": params or {}})
def tool(token, name, **args):
    code, r = call(token, "tools/call", {"name": name, "arguments": args})
    res = r.get("result") if isinstance(r, dict) else None
    if not res: return code, None, r
    txt = res["content"][0]["text"]
    try: val = json.loads(txt)
    except Exception: val = txt
    return code, val, res.get("isError", False)

def mint(email):
    code, tok = rpc(email, "create_claude_connector_token", p_label="test")
    assert code == 200 and len(tok) == 64, (code, tok)
    return tok

def cleanup():
    q("delete from dial_lists where name like 'TEST-CONN %'")
    ids = ",".join(f"'{uid(e)}'" for e in (CALEB, GAVIN, LEAD_A, AUSTIN))
    q(f"delete from claude_connector_tokens where profile_id in ({ids})")

def body(first, middle, name="Caleb"):
    return f"Hi {first},\n\n{middle}\n\nBest,\n{name}"

GOOD_FU = "Hi {f}, just circling back on my note about {c}.\n\nCaleb"
def run():
    cleanup()
    had_guideline = q("select 1 from copy_guidelines where mandate='data'")
    if not had_guideline:
        q("insert into copy_guidelines (mandate, body, version) values ('data', 'TEST GUIDELINES: plain, short, no dashes.', 'test-1')")
    try:
        _run()
    finally:
        cleanup()
        if not had_guideline: q("delete from copy_guidelines where mandate='data' and version='test-1'")
    p = sum(1 for _, ok, _ in T.results if ok)
    print(f"\n{p}/{len(T.results)} passed")
    raise SystemExit(0 if p == len(T.results) else 1)

def _run():
    SHARED = "We help owners of well run firms learn what a buyer would pay today."
    leads = [
        dict(co="Alpha Plumbing", name="Pat Alpha", email="masonquinn10@gmail.com", subj="Alpha Plumbing and a buyer",
             e1=body("Pat", "I saw your shop has served Provo for years. A buyer asked us about plumbing firms like yours. Worth a short chat?"),
             e2=GOOD_FU.format(f="Pat", c="Alpha")),
        dict(co="Bravo Heating", name="Sam Bravo", email="mason.alex.quinn@gmail.com", subj="Bravo Heating question",
             e1=body("Sam", f"A buyer wants heating firms in Utah {EMDASH} yours came up. Open to hearing what it would pay?"),
             e2=GOOD_FU.format(f="Sam", c="Bravo")),
        dict(co="Charlie Electric", name="Lee Charlie", email="mason@waystationadvisors.com", subj="Charlie Electric",
             e1=body("Lee", " ".join(["word"] * 100)), e2=GOOD_FU.format(f="Lee", c="Charlie")),
        dict(co="Delta Roofing", name="Kim Delta", email="mason@waystation-advisors.com", subj="Delta Roofing and a buyer",
             e1=body("Kim", SHARED + " Open to a quick call this week?"), e2=GOOD_FU.format(f="Kim", c="Delta")),
        dict(co="Echo Paving", name="Ray Echo", email="mason.quinn@waystation-advisors.com", subj="Echo Paving idea",
             e1=body("Ray", "Paving firms in your area are in demand right now. Would you like to hear who is asking?"),
             e2=GOOD_FU.format(f="Ray", c="Echo")),
    ]
    lid = T.make_list(CALEB, leads, mandate="data", name="TEST-CONN " + uuid.uuid4().hex[:6])
    code, res = rpc(CALEB, "seq_prepare_list", p_list_id=lid)
    check("setup: prepare list", code == 200 and res["email_sequence"] == 5, res)
    r = urllib.request.Request(URL + "/functions/v1/copy-gate", method="POST", data=json.dumps({"list_id": lid}).encode(),
        headers={"apikey": ANON, "Authorization": "Bearer " + login(CALEB), "Content-Type": "application/json"})
    gate = json.load(urllib.request.urlopen(r))
    check("setup: copy-gate holds dash + long drafts, passes others",
          sum(1 for x in gate["results"] if not x["ok"]) == 2, gate["summary"])
    ids = {x["company_name"]: x["id"] for x in q(f"select id, company_name from dials where list_id='{lid}'")}
    A, B, C, D = (ids[n] for n in ("Alpha Plumbing", "Bravo Heating", "Charlie Electric", "Delta Roofing"))

    t_cal, t_gav, t_and = mint(CALEB), mint(GAVIN), mint(LEAD_A)

    # ---- protocol
    code, r = post(t_cal, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}})
    res = r["result"]
    check("initialize: version echo, caps, serverInfo, instructions",
          code == 200 and res["protocolVersion"] == "2025-06-18" and res["serverInfo"]["name"] == "waystation-crm" and "tools" in res["capabilities"]
          and "prompts" in res["capabilities"] and "get_guidelines" in res["instructions"], r)
    code, r = post(t_cal, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
    check("initialize: unknown version falls back to a supported one", r["result"]["protocolVersion"] == "2025-06-18", r)
    code, r = post(t_cal, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    check("notifications/initialized: 202 no body", code == 202 and r is None, (code, r))
    code, r = call(t_cal, "ping"); check("ping", code == 200 and r["result"] == {}, r)
    code, r = call(t_cal, "tools/list")
    names = sorted(t["name"] for t in r["result"]["tools"])
    check("tools/list: the six tools with schemas", names == sorted(["list_my_lists", "list_drafts", "get_guidelines", "check_draft", "save_rewrite", "get_history"])
          and all(t["inputSchema"]["type"] == "object" for t in r["result"]["tools"]), names)
    code, r = call(t_cal, "prompts/list"); check("prompts/list", sorted(p["name"] for p in r["result"]["prompts"]) == ["improve_draft", "rewrite_flagged"], r)
    code, r = call(t_cal, "prompts/get", {"name": "rewrite_flagged", "arguments": {"list_id": lid}})
    txt = r["result"]["messages"][0]["content"]["text"]
    check("prompts/get rewrite_flagged mentions guidelines + list", "get_guidelines" in txt and lid in txt and "sign-off" in txt, txt[:200])
    code, r = call(t_cal, "prompts/get", {"name": "improve_draft", "arguments": {"dial_id": A, "request": "make it warmer"}})
    check("prompts/get improve_draft", "make it warmer" in r["result"]["messages"][0]["content"]["text"], r)
    code, r = call(t_cal, "prompts/get", {"name": "rewrite_flagged", "arguments": {"list_id": "nope"}})
    check("prompts/get: bad args -> -32602", r["error"]["code"] == -32602, r)
    code, r = call(t_cal, "nope/method"); check("unknown method -> -32601", r["error"]["code"] == -32601, r)
    code, r = call(t_cal, "tools/call", {"name": "nope", "arguments": {}}); check("unknown tool -> -32602", r["error"]["code"] == -32602, r)
    code, r = post(t_cal, [{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"},
                           {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, {"jsonrpc": "2.0", "id": 3, "method": "bogus"}])
    check("batch: responses only for requests, errors per item", code == 200 and [x["id"] for x in r] == [1, 2, 3] and "error" in r[2] and "result" in r[1], r)
    code, r = post(t_cal, [{"jsonrpc": "2.0", "method": "notifications/initialized"}])
    check("batch of only notifications: 202", code == 202, (code, r))
    code, r = post(t_cal, [])
    check("empty batch: invalid request", code == 400 and r["error"]["code"] == -32600, (code, r))
    rq = urllib.request.Request(ENDPOINT + f"/mcp/{t_cal}", method="POST", data=b"{not json", headers={"Content-Type": "application/json"})
    try: urllib.request.urlopen(rq)
    except urllib.error.HTTPError as e: check("bad JSON: -32700", e.code == 400 and json.loads(e.read())["error"]["code"] == -32700)
    for m in ("GET", "DELETE"):
        rq = urllib.request.Request(ENDPOINT + f"/mcp/{t_cal}", method=m)
        try: urllib.request.urlopen(rq); check(f"{m} -> 405", False)
        except urllib.error.HTTPError as e: check(f"{m} -> 405", e.code == 405)
    rq = urllib.request.Request(ENDPOINT + f"/mcp/{t_cal}", method="OPTIONS", headers={"Origin": "https://claude.ai", "Access-Control-Request-Method": "POST"})
    f = urllib.request.urlopen(rq)
    check("OPTIONS: CORS for claude.ai", f.status in (200, 204) and f.headers["Access-Control-Allow-Origin"] == "*" and "POST" in f.headers["Access-Control-Allow-Methods"])

    # ---- auth
    code, r = post("0" * 64, {"jsonrpc": "2.0", "id": 1, "method": "ping"}); check("unknown token -> 401", code == 401 and r["error"], (code, r))
    code, r = post("short", {"jsonrpc": "2.0", "id": 1, "method": "ping"}); check("malformed token -> 401", code == 401, (code, r))
    code, r = post(None, {"jsonrpc": "2.0", "id": 1, "method": "ping"}, path=""); check("no token -> 401", code == 401, (code, r))
    old = mint(AUSTIN); new = mint(AUSTIN)
    code, _ = call(old, "ping"); code2, _ = call(new, "ping")
    check("regenerated token revokes the old one", code == 401 and code2 == 200, (code, code2))
    lu = q(f"select last_used_at from claude_connector_tokens where profile_id='{uid(AUSTIN)}' and revoked_at is null")[0]["last_used_at"]
    check("last_used_at updated", lu is not None, lu)
    code, r = rpc(AUSTIN, "revoke_claude_connector_tokens"); code2, _ = call(new, "ping")
    check("explicit revoke -> 401", code2 == 401, code2)

    # ---- scoping
    code, lists, err = tool(t_cal, "list_my_lists")
    mine = [x for x in lists if x["id"] == lid]
    check("Caleb sees his list with counts", mine and mine[0]["counts"]["total"] == 5 and mine[0]["counts"]["held"] == 2 and mine[0]["counts"]["passed"] == 3
          and mine[0]["mandate"] == "data" and mine[0]["counts"]["sent"] == 0, mine)
    code, lists, err = tool(t_gav, "list_my_lists")
    check("Gavin (same team, intern) sees none of Caleb's lists", all(x["id"] != lid for x in lists), lists)
    code, v, err = tool(t_gav, "list_drafts", list_id=lid)
    check("Gavin can't list drafts of Caleb's list", err is True and "not found" in v.lower(), (v, err))
    for nm, args in (("check_draft", dict(dial_id=A, email_1="x")), ("save_rewrite", dict(dial_id=A, email_1="x")), ("get_history", dict(dial_id=A))):
        code, v, err = tool(t_gav, nm, **args)
        check(f"Gavin {nm} on Caleb's draft looks like not found", err is True and v == "Draft not found (check the id, or you don't have access to it).", v)
    code, v, err = tool(t_gav, "check_draft", dial_id=str(uuid.uuid4()), email_1="x")
    check("random id gives the identical message", v == "Draft not found (check the id, or you don't have access to it).", v)
    code, lists, err = tool(t_and, "list_my_lists")
    check("Andrew (lead) sees Caleb's list", any(x["id"] == lid for x in lists), lists)
    code, v, err = tool(t_and, "list_drafts", list_id=lid, filter="all")
    check("Andrew can list all 5 drafts", not err and v["total"] == 5 and len(v["rows"]) == 5, v if err else v["total"])

    # ---- list_drafts
    code, v, err = tool(t_cal, "list_drafts", list_id=lid)
    held = {x["company_name"]: x for x in v["rows"]}
    check("list_drafts default = held (dash + long)", set(held) == {"Bravo Heating", "Charlie Electric"}, list(held))
    h = held["Bravo Heating"]
    check("held row has errors, fields and already_sent=false", any("dash" in e for e in h["copy_errors"]) and h["already_sent"] is False and h["copy_ok"] is False
          and h["email_1"] and h["full_name"] == "Sam Bravo" and "summary" in h, h)
    code, v, err = tool(t_cal, "list_drafts", list_id=lid, filter="all", limit=2, offset=0)
    check("pagination limit", len(v["rows"]) == 2 and v["total"] == 5, v["total"])
    code, v, err = tool(t_cal, "list_drafts", list_id=lid, filter="bogus"); check("bad filter rejected", err is True, v)
    code, v, err = tool(t_cal, "list_drafts", list_id="abc"); check("bad list id rejected", err is True, v)
    code, v, err = tool(t_cal, "list_drafts", list_id=lid, filter="unchecked"); check("unchecked is empty after gate", v["total"] == 0, v)

    # ---- guidelines
    code, v, err = tool(t_cal, "get_guidelines", mandate="data")
    check("get_guidelines returns body+version", not err and v["version"] and "GUIDELINES" in v["body"] or not err and v["body"], v)
    saved = q("select body, version from copy_guidelines where mandate='ma'")
    code, v, err = tool(t_cal, "get_guidelines", mandate="ma")
    if not saved: check("get_guidelines: missing mandate gives a clear admin error", err is True and "admin" in v.lower(), v)
    code, v, err = tool(t_cal, "get_guidelines", mandate="zzz"); check("get_guidelines: bad mandate", err is True, v)

    # ---- check_draft
    code, v, err = tool(t_cal, "check_draft", dial_id=A, email_1=body("Pat", f"Short note {EMDASH} here about the sale of your firm today."))
    check("check_draft flags dash, writes nothing", v["ok"] is False and any("dash" in e for e in v["errors"]) and v["saved"] is False, v)
    code, v, err = tool(t_cal, "check_draft", dial_id=A, email_1=body("Pat", " ".join(["word"] * 100)))
    check("check_draft flags length", any("100 words" in e for e in v["errors"]), v)
    code, v, err = tool(t_cal, "check_draft", dial_id=A, email_1=body("Pat", SHARED + " Another line follows right here."))
    check("check_draft flags a sentence already in another lead (in context)", any("other lead" in e for e in v["errors"]), v)
    code, v, err = tool(t_cal, "check_draft", dial_id=A, email_1=body("Pat", "I read about {{company}} online."))
    check("check_draft flags placeholder", any("placeholder" in e for e in v["errors"]), v)
    code, v, err = tool(t_cal, "check_draft", dial_id=A)
    check("check_draft with no changes lints current text (clean)", v["ok"] is True, v)
    cur = q(f"select email_1, copy_ok from dials where id='{A}'")[0]
    check("check_draft wrote nothing", cur["email_1"] == leads[0]["e1"] and cur["copy_ok"] is True, cur)

    # ---- save_rewrite
    before = q(f"select email_1, email_subject from dials where id='{B}'")[0]
    code, v, err = tool(t_cal, "save_rewrite", dial_id=B, email_1=body("Sam", f"Still has a dash {EMDASH} oops here for the test run."))
    after = q(f"select email_1 from dials where id='{B}'")[0]
    check("save_rewrite rejects a bad rewrite, text unchanged", v["saved"] is False and v["rejected"] and after["email_1"] == before["email_1"], v)
    code, v, err = tool(t_cal, "save_rewrite", dial_id=B, email_1=body("Sam", SHARED + " Open to a short call?"))
    check("save_rewrite rejects duplicate of another lead", v["saved"] is False and any("other lead" in e for e in v["errors"]), v)
    good = body("Sam", "A buyer is looking at heating firms in Utah and your name came up. Open to hearing what it might pay?")
    code, v, err = tool(t_cal, "save_rewrite", dial_id=B, email_1=good, note="removed dash")
    row = q(f"select email_1, copy_ok, copy_hash is not null h from dials where id='{B}'")[0]
    check("save_rewrite accepts a good rewrite; gate records the pass", v["saved"] is True and v["copy_ok"] is True and row["email_1"] == good and row["copy_ok"] and row["h"], (v, row))
    rev = q(f"select source, changed_by, note from copy_revisions where dial_id='{B}' order by id desc limit 1")[0]
    check("copy_revisions: source claude_connector, by Caleb, note", rev["source"] == "claude_connector" and rev["changed_by"] == uid(CALEB) and rev["note"] == "removed dash", rev)
    code, v, err = tool(t_and, "save_rewrite", dial_id=C, email_1=body("Lee", "A buyer is interested in electrical firms like yours. Open to a short chat?"))
    rev = q(f"select changed_by from copy_revisions where dial_id='{C}' and source='claude_connector'")
    check("lead (Andrew) can save on an intern's list, recorded as Andrew", v["saved"] and rev and rev[0]["changed_by"] == uid(LEAD_A), (v, rev))
    code, v, err = tool(t_cal, "get_history", dial_id=B)
    check("get_history returns the revision with names", not err and v[0]["source"] == "claude_connector" and v[0]["by"] and v[0]["after"]["email_1"] == good, v)
    code, v, err = tool(t_cal, "list_drafts", list_id=lid)
    check("held list now empty", v["total"] == 0, v["total"])
    code, v, err = tool(t_cal, "save_rewrite", dial_id=B); check("save_rewrite with nothing to save errors", err is True, v)

    # ---- already sent
    q(f"update dials set email_1_message_id='<sent-test@x>' where id='{A}'")
    code, v, err = tool(t_cal, "save_rewrite", dial_id=A, email_1=body("Pat", "I saw your shop has served Provo a long time. Worth a short chat about buyers?"))
    cur = q(f"select email_1 from dials where id='{A}'")[0]["email_1"]
    check("sent first email can't be changed", v["saved"] is False and "already sent" in v["message"] and cur == leads[0]["e1"], v)
    code, v, err = tool(t_cal, "save_rewrite", dial_id=A, email_2="Hi Pat, one more note on Alpha Plumbing and the buyer.\n\nCaleb")
    check("follow-up of a sent lead can still be edited", v["saved"] is True and v["copy_ok"] is True, v)
    code, v, err = tool(t_cal, "list_drafts", list_id=lid, filter="all")
    check("already_sent is reported", [x for x in v["rows"] if x["id"] == A][0]["already_sent"] is True)
    code, lists, _ = tool(t_cal, "list_my_lists")
    check("sent count", [x for x in lists if x["id"] == lid][0]["counts"]["sent"] == 1, lists)
    # direct SQL function guard (defence in depth)
    try:
        q(f"select connector_save_copy('{uid(CALEB)}','{A}','new subject',null,null,null)"); check("SQL guard refuses sent subject change", False)
    except RuntimeError as e: check("SQL guard refuses sent subject change", "already sent" in str(e))
    try:
        q(f"select connector_save_copy('{uid(GAVIN)}','{A}',null,null,'x',null)"); check("SQL guard refuses other intern", False)
    except RuntimeError as e: check("SQL guard refuses other intern", "not found" in str(e).lower())

    # ---- approved list: a fixed lead becomes READY but is not started until the next start_emails call (send rules v2)
    q(f"update dial_lists set copy_status='approved' where id='{lid}'")
    q(f"update dials set seq_state='awaiting_copy' where id='{C}'")
    # C was fixed already; make it held again then fix through the connector on an approved list
    q(f"update dials set email_1='{'x ' * 120}' where id='{C}'")
    tool(t_cal, "check_draft", dial_id=C)  # no write
    gate2 = tool(t_cal, "save_rewrite", dial_id=C, email_1=body("Lee", "A buyer is interested in electrical firms like yours. Open to a short chat?"))[1]
    st = q(f"select seq_state from dials where id='{C}'")[0]["seq_state"]
    chk = q(f"select copy_ok from dials where id='{C}'")[0]["copy_ok"]
    check("approved list: fixed lead turns ready (copy_ok) but is not auto-started", gate2["saved"] and gate2["copy_ok"] and chk and st == "awaiting_copy", (gate2, st))

    # ---- rate limit (separate token)
    t_rl = mint(AUSTIN)
    tid = q(f"select id from claude_connector_tokens where profile_id='{uid(AUSTIN)}' and revoked_at is null")[0]["id"]
    q(f"insert into claude_connector_calls (token_id, called_at) select '{tid}', now() from generate_series(1,118)")
    r1 = tool(t_rl, "list_my_lists"); r2 = tool(t_rl, "list_my_lists"); r3 = tool(t_rl, "list_my_lists")
    check("rate limit: 119th and 120th allowed, 121st refused with a friendly message",
          r1[2] is False and r2[2] is False and r3[2] is True and "Rate limit" in r3[1], (r1[2], r2[2], r3))
    code, _ = call(t_rl, "ping"); check("rate limit does not block ping/list", code == 200)
    q(f"update claude_connector_calls set called_at = now() - interval '11 minutes' where token_id='{tid}'")
    check("rate limit window slides", tool(t_rl, "list_my_lists")[2] is False)

run()
