"""Connection checks on the TEST project (no real phone call, no external webhook posts).
telnyx-token, deepgram-token, call-summary, call-recordings bucket, intake-submit (webhooks absent on test -> not_configured),
schedule-intro-call (Calendly secrets), send-push, secrets presence. Prefix TEST-FINAL; cleans up after itself."""
import json, uuid, urllib.request, urllib.error
import sb
from test_sequences import q, uid, lit, login, api, URL, ANON, CALEB, ADMIN
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))
def fn(name, body, who=CALEB, extra=None):
    h = {"Authorization": "Bearer " + login(who), "apikey": ANON, "Content-Type": "application/json"}; h.update(extra or {})
    r = urllib.request.Request(URL + "/functions/v1/" + name, data=json.dumps(body).encode(), headers=h)
    try:
        with urllib.request.urlopen(r, timeout=90) as f: return f.status, json.loads(f.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}
def run():
    sec = {r["key"] for r in q("select key from app_secrets")}
    for k in ("TELNYX_API_KEY", "TELNYX_SIP_CONNECTION_ID", "DEEPGRAM_API_KEY", "CALL_SUMMARY_INTERNAL_KEY"):
        check(f"secret present: {k}", k in sec)
    # telnyx-token: consent decision + caller number + SIP credential (token mint, no call placed)
    c, r = fn("telnyx-token", {"to_number": "(801) 555-0100", "owner_state": "UT"})
    check("call lock: telnyx-token refuses a non-test number (403)", c == 403 and not r.get("login_token"), (c, r))
    c, r = fn("telnyx-token", {"to_number": "(502) 419-6436", "owner_state": "KY"})
    check("telnyx-token 200 + login token + caller number (test number)", c == 200 and r.get("login_token") and r.get("from_number"), (c, {k: v for k, v in r.items() if k != "login_token"}))
    check("telnyx credential row stored for caller", q(f"select 1 from telnyx_credentials where user_id='{uid(CALEB)}'"))
    c, r = fn("telnyx-token", {"to_number": "12"}); check("telnyx-token rejects bad number (400)", c == 400, (c, r))
    c, r = fn("telnyx-token", {"to_number": "5024196436"}, who=ADMIN); check("telnyx-token works for admin too", c == 200 and r.get("login_token"), (c, r))
    # deepgram-token only for a live transcribed call of the caller
    cid = str(uuid.uuid4())
    q(f"insert into calls (id, user_id, mode, transcribed, to_number, company_name) values ('{cid}', '{uid(CALEB)}', 'in_app', true, '+18015550100', 'TEST-FINAL call')")
    c, r = fn("deepgram-token", {"call_id": cid}); check("deepgram-token mints a token for a live transcribed call", c == 200 and r.get("token"), (c, r))
    c, r = fn("deepgram-token", {"call_id": cid}, who=ADMIN); check("deepgram-token refuses another user's call (404)", c == 404, (c, r))
    q(f"update calls set transcribed=false, skip_reason='all_party_state' where id='{cid}'")
    c, r = fn("deepgram-token", {"call_id": cid}); check("deepgram-token refuses a no-record call (403)", c == 403, (c, r))
    # call-summary: with no transcript it must answer cleanly (skipped), never 500
    q(f"update calls set transcribed=true, skip_reason=null, ended_at=now() where id='{cid}'")
    c, r = fn("call-summary", {"call_id": cid}); check("call-summary answers cleanly without a transcript (no 500)", c < 500, (c, r))
    # recordings bucket: upload, signed url, download, remove (as the caller)
    path = f"{uid(CALEB)}/TEST-FINAL-{cid[:6]}.webm"
    def stor(method, p, data=None, ct="audio/webm"):
        r = urllib.request.Request(URL + "/storage/v1" + p, data=data if isinstance(data, (bytes, type(None))) else json.dumps(data).encode(), method=method,
            headers={"apikey": ANON, "Authorization": "Bearer " + login(CALEB), "Content-Type": ct})
        try:
            with urllib.request.urlopen(r, timeout=60) as f: return f.status, f.read()
        except urllib.error.HTTPError as e: return e.code, e.read()
    c, b = stor("POST", f"/object/call-recordings/{path}", b"RIFFtestwebm"); check("recordings bucket: upload", c in (200, 201), (c, b[:150]))
    c, b = stor("POST", f"/object/sign/call-recordings/{path}", {"expiresIn": 60}, "application/json")
    ok = c == 200 and b"signedURL" in b; check("recordings bucket: signed URL", ok, (c, b[:150]))
    if ok:
        u = json.loads(b)["signedURL"]; g = urllib.request.urlopen(URL + "/storage/v1" + u).read(); check("recordings bucket: playback download", g == b"RIFFtestwebm", g[:40])
    c, b = stor("DELETE", f"/object/call-recordings/{path}"); check("recordings bucket: remove", c == 200, (c, b[:100]))
    q(f"delete from calls where id='{cid}'")
    # intake-submit: hits the real function; TEST has no sheet/slack webhook secrets so nothing is posted
    check("TEST has no sheet/slack webhook secrets (nothing can be posted)", not ({"sheet_webhook_url", "slack_webhook_url"} & sec))
    cl = q("select id from clients where full_name like 'TEST-FINAL%' limit 1")
    if cl:
        c, r = fn("intake-submit", {"client_id": cl[0]["id"]}); print("INFO intake-submit:", c, str(r)[:200])
        check("intake-submit reachable, auth-checked, and posts nowhere on TEST (a non-questionnaire client is refused; webhooks absent)", c in (200, 400) and r.get("slack") in (None, "not_configured") and r.get("sheet") in (None, "not_configured"), (c, r))
    # schedule-intro-call without Calendly secrets
    c, r = fn("schedule-intro-call", {"client_id": str(uuid.uuid4())}); print("INFO schedule-intro-call (no Calendly secrets on test):", c, str(r)[:160])
    # send-push for a user with no subscriptions
    c, r = fn("send-push", {"user_id": uid(CALEB), "message": "TEST-FINAL ping"}); check("send-push refuses callers without the internal secret (401)", c == 401, (c, r))
    isec = (q("select value from app_secrets where key='internal_call_secret'") or [{}])[0].get("value")
    check("TEST has VAPID keys + internal secret for push", isec and {"vapid_public_key", "vapid_private_key", "vapid_subject"} <= sec)
    if isec:
        c, r = fn("send-push", {"user_id": uid(CALEB), "message": "TEST-FINAL ping"}, extra={"x-internal-secret": isec}); check("send-push answers 200 with the internal secret (no subscriptions = sent 0)", c == 200 and r.get("failed") == 0, (c, r))
    # admin create / delete account (real functions; the new user is removed again)
    em = f"test-final-{uuid.uuid4().hex[:6]}@example.com"
    c, r = fn("admin-create-account", {"full_name": "TEST-FINAL Account", "email": em, "phone": "(801) 555-0140", "password": "Tf-" + uuid.uuid4().hex[:10]}, who=ADMIN)
    check("admin-create-account creates a user + profile", c == 200 and r.get("user_id") and q(f"select 1 from profiles where email='{em}'"), (c, r))
    c2, r2 = fn("admin-create-account", {"full_name": "x", "email": em + "x", "password": "Tf-123456789"}, who=CALEB); check("admin-create-account refuses a non-admin (403)", c2 == 403, (c2, r2))
    if c == 200:
        c3, r3 = fn("admin-delete-account", {"user_id": r["user_id"]}, who=CALEB); check("admin-delete-account refuses a non-admin", c3 in (401, 403), (c3, r3))
        c3, r3 = fn("admin-delete-account", {"user_id": r["user_id"]}, who=ADMIN); check("admin-delete-account deletes it", c3 == 200 and not q(f"select 1 from profiles where email='{em}'"), (c3, r3))
    print(f"\n{sum(results)}/{len(results)} passed")
run()
