"""HTTP tests for the mailbox-admin edge function on the TEST project.
Run: python3 test_mailbox_admin.py   (cleans up all test-mbx-* rows at the end)"""
import sb, json, os, urllib.request, urllib.error

SEC = json.load(open(os.path.expanduser("~/Projects/First Project/.waystation_test_secrets.json")))
URL = f"https://{sb.TEST_REF}.supabase.co"
FN = URL + "/functions/v1/mailbox-admin"
ANON = [k for k in sb.test_api("/api-keys") if k["name"] == "anon"][0]["api_key"]
KEY = SEC["mailbox_admin_api_key"]
ADMIN, INTERN = "test.admin@example.com", "jordan.intern@example.com"
PW = "Fake-Pass-9z!"
_tok = {}

def login(email):
    if email not in _tok:
        r = urllib.request.Request(URL + "/auth/v1/token?grant_type=password", method="POST",
            data=json.dumps({"email": email, "password": SEC["accounts"][email]["password"]}).encode(),
            headers={"apikey": ANON, "Content-Type": "application/json"})
        _tok[email] = json.load(urllib.request.urlopen(r))["access_token"]
    return _tok[email]

def call(body, who="admin", raw=None):
    h = {"Content-Type": "application/json"}
    if who == "admin": h["Authorization"] = "Bearer " + login(ADMIN)
    elif who == "intern": h["Authorization"] = "Bearer " + login(INTERN)
    elif who == "key": h["x-admin-api-key"] = KEY
    elif who == "badkey": h["x-admin-api-key"] = "nope"
    r = urllib.request.Request(FN, method="POST", data=raw if raw is not None else json.dumps(body).encode(), headers=h)
    try:
        with urllib.request.urlopen(r, timeout=120) as f: txt = f.read().decode(); code = f.status
    except urllib.error.HTTPError as e: txt = e.read().decode(); code = e.code
    seen.append(txt)
    try: return code, json.loads(txt)
    except Exception: return code, txt

seen, results = [], []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))
def q(sql): return sb.test_sql(sql)
def mb(i, **kw): return {"email": f"test-mbx-{i}@example.com", "password": PW, "imap_host": "imap.example.com", "smtp_host": "smtp.example.com", **kw}

try:
    q("insert into app_secrets(key,value) values ('mailbox_host_allowlist','imap.example.com,smtp.example.com') on conflict (key) do update set value=excluded.value")
    q("delete from mailbox_admin_audit")      # rate limit is 60 calls / 10 min per actor
    q("delete from email_accounts where email_address ilike 'test-mbx-%'")
    # auth
    check("no auth -> 401", call({"action": "list"}, who=None)[0] == 401)
    check("bad key -> 401", call({"action": "list"}, who="badkey")[0] == 401)
    check("intern -> 403", call({"action": "list"}, who="intern")[0] == 403)
    check("admin list ok", call({"action": "list"})[0] == 200)
    check("key list ok", call({"action": "list"}, who="key")[0] == 200)
    check("bad json -> 400", call(None, raw=b"{not json")[0] == 400)
    check("unknown action -> 400", call({"action": "zap"})[0] == 400)
    check("array body -> 400", call(None, raw=b"[1]")[0] == 400)

    # dry run
    rows = [mb(1, display_name="Caleb Hong"), mb(2, display_name="Caleb"), mb(3, owner_email="test.gavin.hopkinson@example.com")]
    c, r = call({"action": "bulk_upsert", "dry_run": True, "mailboxes": rows})
    check("dry_run statuses", c == 200 and [x["status"] for x in r["results"]] == ["would_create"] * 3, r)
    check("dry_run wrote nothing", q("select count(*) n from email_accounts where email_address ilike 'test-mbx-%'")[0]["n"] == 0)
    check("dry_run name match Caleb Hong", r["results"][0]["owner"] == "Caleb Hong" and not r["results"][0]["needs_assignment"], r["results"][0])
    check("dry_run first-name-only needs assignment", r["results"][1]["needs_assignment"] is True, r["results"][1])
    check("dry_run owner_email", r["results"][2]["owner"] and "Gavin" in r["results"][2]["owner"], r["results"][2])

    # real create
    c, r = call({"action": "bulk_upsert", "mailboxes": rows}, who="key")
    check("create via api key", c == 200 and r["summary"]["created"] == 3, r)
    db = {x["email_address"]: x for x in q("select email_address, source, needs_assignment, sync_enabled, imap_port, smtp_port, owner_id from email_accounts where email_address ilike 'test-mbx-%'")}
    check("source=api, defaults", all(x["source"] == "api" and x["imap_port"] == 993 for x in db.values()), db)
    check("Caleb assigned", db["test-mbx-1@example.com"]["owner_id"] == SEC["accounts"]["test.caleb.hong@example.com"]["id"])
    check("Caleb-only needs_assignment", db["test-mbx-2@example.com"]["needs_assignment"] is True)

    # update path + case-insensitive upsert + keep password when blank
    c, r = call({"action": "bulk_upsert", "mailboxes": [{"email": "TEST-MBX-1@Example.com", "daily_send_limit": 7, "mandate": "data"}]})
    check("upsert updates existing (case-insens.)", c == 200 and r["results"][0]["status"] == "updated", r)
    row = q("select daily_send_limit, mandate, (select decrypted_secret from vault.decrypted_secrets v where v.id = password_secret_id) as password, owner_id from email_accounts where email_address='test-mbx-1@example.com'")[0]
    check("limit/mandate set, password+owner kept", row["daily_send_limit"] == 7 and row["mandate"] == "data" and row["password"] == PW and row["owner_id"] == SEC["accounts"]["test.caleb.hong@example.com"]["id"], row)

    # invalid + duplicates + unicode
    bad = [mb(10, email="not-an-email"), mb(11, smtp_port=99999), mb(12, daily_send_limit=500), mb(13, mandate="x"),
           {"email": "test-mbx-14@example.com"}, "string-row", None, mb(15, imap_host="bad host!"),
           mb(16), mb(16), mb(17, display_name="Zoë Ñandú 李雷 ‮"), mb(18, owner_name="Nobody Real"),
           {"email": "test-mbx-19@nodns-zzzz-invalid.test", "password": PW}]
    c, r = call({"action": "bulk_upsert", "mailboxes": bad})
    check("bad batch 200 not crash", c == 200, r)
    st = [x["status"] for x in r["results"]]
    check("per-row errors", st[:9] == ["error"] * 8 + ["created"] and st[9] == "error" and st[10] == "created" and st[11] == "error" and st[12] == "error", st)
    check("duplicate flagged", "Duplicate" in r["results"][9].get("error", ""), r["results"][9])
    check("unicode name stored", q("select label from email_accounts where email_address='test-mbx-17@example.com'")[0]["label"].startswith("Zoë"))
    c, r = call({"action": "bulk_upsert", "mailboxes": [mb(100 + i) for i in range(600)]})
    check("600 rows -> 400, nothing written", c == 400 and q("select count(*) n from email_accounts where email_address ilike 'test-mbx-1__@%'")[0]["n"] == 0, r)
    check("empty list -> 400", call({"action": "bulk_upsert", "mailboxes": []})[0] == 400)
    check("verify with >25 rows -> 400", call({"action": "bulk_upsert", "mailboxes": [mb(200 + i, verify=True) for i in range(30)]})[0] == 400)
    c, r = call({"action": "bulk_upsert", "mailboxes": [mb(20, verify=True)]})
    check("verify failure reported, not saved", c == 200 and r["results"][0]["status"] == "error" and "PW" not in json.dumps(r) and PW not in json.dumps(r)
          and q("select count(*) n from email_accounts where email_address='test-mbx-20@example.com'")[0]["n"] == 0, r)

    # assign
    ids = [x["id"] for x in q("select id from email_accounts where email_address in ('test-mbx-2@example.com','test-mbx-3@example.com')")]
    gav = SEC["accounts"]["test.gavin.hopkinson@example.com"]["id"]
    check("assign bad ids -> 400", call({"action": "assign", "account_ids": ["x"], "owner_id": gav})[0] == 400)
    check("assign unknown owner -> 404", call({"action": "assign", "account_ids": ids, "owner_id": "00000000-0000-0000-0000-000000000000"})[0] == 404)
    c, r = call({"action": "assign", "account_ids": ids, "owner_id": gav})
    rows = q("select owner_id, needs_assignment from email_accounts where id in ('%s')" % "','".join(ids))
    check("assign sets owner + clears flag", c == 200 and all(x["owner_id"] == gav and not x["needs_assignment"] for x in rows), r)

    # update
    a1 = q("select id from email_accounts where email_address='test-mbx-1@example.com'")[0]["id"]
    c, r = call({"action": "update", "account_id": a1, "daily_send_limit": 12, "send_paused_reason": "testing", "sync_enabled": True, "mandate": "ma"})
    row = q(f"select daily_send_limit, send_paused_reason, sync_enabled, mandate from email_accounts where id='{a1}'")[0]
    check("update fields", c == 200 and row == {"daily_send_limit": 12, "send_paused_reason": "testing", "sync_enabled": True, "mandate": "ma"}, (r, row))
    call({"action": "update", "account_id": a1, "send_paused_reason": None})
    check("resume (null reason)", q(f"select send_paused_reason p from email_accounts where id='{a1}'")[0]["p"] is None)
    check("update bad limit -> 400", call({"action": "update", "account_id": a1, "daily_send_limit": 201})[0] == 400)
    check("update empty -> 400", call({"action": "update", "account_id": a1})[0] == 400)
    check("update unknown -> 404", call({"action": "update", "account_id": "00000000-0000-0000-0000-000000000000", "mandate": "ma"})[0] == 404)

    # list
    c, r = call({"action": "list"}, who="key")
    mine = [m for m in r["mailboxes"] if m["email_address"].startswith("test-mbx-")]
    check("list shows test rows w/ counts+owner", c == 200 and len(mine) >= 4 and all("sent_24h" in m and "owner_name" in m for m in mine) and mine[0]["effective_daily_limit"] is not None, mine[:1])
    check("list has no password field", not any(k in m for m in r["mailboxes"] for k in ("password", "password_secret_id")))
    check("no response ever contained the password", not any(PW in s for s in seen))

    # remove with pending scheduled email
    q(f"insert into scheduled_emails (created_by, account_id, to_address, subject, body_text, send_at, status) values ('{gav}', '{a1}', 'x@example.com', 's', 'b', now() + interval '1 day', 'pending')")
    c, r = call({"action": "remove", "account_ids": [a1]})
    check("remove refused with pending", r["results"][0]["status"] == "refused" and q(f"select count(*) n from email_accounts where id='{a1}'")[0]["n"] == 1, r)
    c, r = call({"action": "remove", "account_ids": [a1], "force": True})
    check("remove force ok", r["removed"] == 1, r)
    others = [x["id"] for x in q("select id from email_accounts where email_address ilike 'test-mbx-%'")]
    c, r = call({"action": "remove", "account_ids": others})
    check("remove rest", r["removed"] == len(others), r)
finally:
    q("delete from email_accounts where email_address ilike 'test-mbx-%'")
    left = q("select count(*) n from email_accounts where email_address ilike 'test-mbx-%'")[0]["n"]
    print(f"cleanup: {left} test rows left")
    print(f"{sum(results)}/{len(results)} passed")
