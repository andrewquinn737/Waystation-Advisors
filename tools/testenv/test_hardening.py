"""Hardening suite (20261124_hardening.sql + edge functions) on the TEST project.
Setup and the clock-driven dispatcher run as the database owner; what people do goes through the real API with their login.
Sections: 1 anonymous access / null-safe guards, 2 mailbox-admin, 3 duplicate-send protection, 4 suppression + dedup,
5 time zones + caps + ramp, 6 bounce auto-pause, 7 SMTP auth failure + header injection, 8 list/lead deletion, 9 Vault.
Run: python3 test_hardening.py"""
import sb, json, os, uuid, hashlib, time, traceback, urllib.request, urllib.error
import test_sequences as T
from test_sequences import q, uid, lit, make_list, COPY, gate, start, seed_mv, login, api, rpc, CALEB, GAVIN, ADMIN, URL, ANON, SEC

results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:400]}"))

SRK = SEC["service_role"]
INTERN = "jordan.intern@example.com"
OWNER = T.LEAD_B      # dispatcher-driven scenarios run as this team lead (no mailboxes of its own: only this suite's temp boxes), so other suites' mailboxes/leads cannot interfere
KEY = SEC["mailbox_admin_api_key"]
TAG = uuid.uuid4().hex[:6]
FN_MA = URL + "/functions/v1/mailbox-admin"

def http(method, url, body=None, headers=None, raw=None, timeout=120):
    r = urllib.request.Request(url, method=method, data=raw if raw is not None else (None if body is None else json.dumps(body).encode()),
                               headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f: txt = f.read().decode(); code = f.status
    except urllib.error.HTTPError as e: txt = e.read().decode(); code = e.code
    try: return code, json.loads(txt)
    except Exception: return code, txt

def anon_rpc(fn, args=None):
    return http("POST", URL + f"/rest/v1/rpc/{fn}", args or {}, {"apikey": ANON, "Authorization": "Bearer " + ANON})

def ma(body, who="admin", raw=None, headers=None):
    h = dict(headers or {})
    if who == "admin": h["Authorization"] = "Bearer " + login(ADMIN)
    elif who == "intern": h["Authorization"] = "Bearer " + login(INTERN)
    elif who == "key": h["x-admin-api-key"] = KEY
    elif who == "badkey": h["x-admin-api-key"] = "nope"
    return http("POST", FN_MA, body, h, raw)

def fn_user(name, body, email=CALEB):
    return http("POST", URL + f"/functions/v1/{name}", body, {"apikey": ANON, "Authorization": "Bearer " + login(email)})

def raises(sql, needle=None):
    try: q(sql); return False
    except RuntimeError as e: return needle is None or needle.lower() in str(e).lower()

def seed_mv(email, result="ok"):
    # own source tag: other suites' cleanups delete source='test' and @example.com rows
    q(f"insert into email_verifications (email, result, checked_at, source) values ({lit(email.lower())}, {lit(result)}, now(), 'hardtest') on conflict (email) do update set result=excluded.result, checked_at=excluded.checked_at")

def park():
    """Cancel every pending task of the dispatcher owner so earlier scenarios' leads cannot take the mailbox's slot."""
    q(f"update sequence_tasks set status='cancelled' where owner_id='{uid(OWNER)}' and status in ('pending','queued') and list_id in (select id from dial_lists where name like 'TEST-HARD {TAG} %')")

def sha(t): return hashlib.sha256(t.encode()).hexdigest()
def mid(): return f"<hard-{TAG}-{uuid.uuid4().hex[:10]}@x>"
def tmp_box(owner, domain, limit=None, ramp=None, smtp=("smtp.example.com", 465), password="Fake-Pass-9z!"):
    addr = f"hard-{uuid.uuid4().hex[:6]}@{domain}"
    bid = q(f"""insert into email_accounts (owner_id, label, email_address, username, imap_host, imap_port, smtp_host, smtp_port, password, mandate,
                  daily_send_limit, ramp_start, source, sync_enabled)
                values ('{uid(owner)}', 'TEST-HARD-BOX-{TAG}', '{addr}', '{addr}', 'imap.example.com', 993, '{smtp[0]}', {smtp[1]}, 'x', 'data',
                  {lit(limit) if limit else 'null'}, {lit(ramp)}, 'api', false) returning id""")[0]["id"]
    q(f"select set_mailbox_password('{bid}', {lit(password)})")
    return bid, addr


def new_list(owner, leads, state=None, name=None):
    lid = make_list(owner, leads, name=name or f"TEST-HARD {TAG} {uuid.uuid4().hex[:8]}")
    rpc(owner, "seq_prepare_list", p_list_id=lid)
    if state: q(f"update dials set state={lit(state)} where list_id='{lid}'")
    return lid

def activate(owner, lid, day0, n=None):
    code, res = start(owner, lid, n)
    q(f"update dials set seq_day0='{day0}' where list_id='{lid}' and seq_state='active'")
    q(f"select seq_build_tasks(id) from dials where list_id='{lid}' and seq_state='active'")
    return res

def sched_count(lid):
    return q(f"select count(*) n from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id where t.list_id='{lid}' and s.status='pending'")[0]["n"]

def cleanup():
    # boxes left by a crashed or killed earlier run (other tag) would join the owner's pool and soak up the leads of the cap/ramp
    # scenarios; this suite's boxes only live for minutes, so anything older than an hour is debris
    q("""delete from scheduled_emails where account_id in (select id from email_accounts where label like 'TEST-HARD-BOX-%' and created_at < now() - interval '1 hour')""")
    q("""delete from email_accounts where label like 'TEST-HARD-BOX-%' and created_at < now() - interval '1 hour'""")
    # only this run's own rows (tagged): other suites and other copies of this suite share the TEST project
    q(f"""delete from scheduled_emails where dial_id in (select d.id from dials d join dial_lists l on l.id=d.list_id where l.name like 'TEST-HARD {TAG} %')
            or account_id in (select id from email_accounts where label='TEST-HARD-BOX-{TAG}') or to_address like '%{TAG}%'""")
    q(f"delete from dial_lists where name like 'TEST-HARD {TAG} %'")
    q(f"delete from email_accounts where label='TEST-HARD-BOX-{TAG}'")
    q(f"delete from email_verifications where email like '%{TAG}%'")
    q(f"delete from suppressed_emails where email like '%{TAG}%'")
    q(f"delete from suppressed_domains where domain like '%{TAG}%'")
    q(f"delete from email_messages where message_id like '<hard-{TAG}-%'")
    q("delete from app_secrets where key = 'domain_daily_cap'")
    q(f"update profiles set timezone = 'America/Denver' where id = '{uid(CALEB)}'")
    q(f"update profiles set timezone = null where id = '{uid(GAVIN)}'")

def run():
    cleanup()
    caleb_box = q(f"select id from email_accounts where owner_id='{uid(CALEB)}' order by email_address limit 1")[0]["id"]

    # ================================================================ 1. anonymous access
    print("-- 1. anonymous access")
    dummy = "00000000-0000-0000-0000-000000000001"
    for fn, args in [("start_emails", {"p_list_id": dummy}), ("approve_list_copy", {"p_list_id": dummy}),
                     ("complete_sequence_task", {"p_task_id": dummy}), ("stop_sequence", {"p_dial_id": dummy}),
                     ("seq_prepare_list", {"p_list_id": dummy}), ("email_queue_status", {"p_owner": dummy}),
                     ("trash_dial_list", {"p_list_id": dummy}), ("sequence_dispatch", {}), ("dispatch_scheduled_emails", {}),
                     ("get_mailbox_password", {"p_account": dummy}), ("set_mailbox_password", {"p_account": dummy, "p_password": "x"}),
                     ("suppress_email", {"p_email": "a@b.co"}), ("resume_sending", {"p_kind": "list", "p_id": dummy}),
                     ("create_claude_connector_token", {"p_label": "x"}), ("transfer_dial_list", {"p_list_id": dummy, "p_new_owner": dummy}),
                     ("create_notification", {"p_user_id": dummy, "p_message": "x", "p_type": "x"})]:
        code, body = anon_rpc(fn, args)
        check(f"anon cannot call {fn}", code in (401, 403, 404) and "permission denied" in json.dumps(body).lower(), (code, body))
    open_fns = {r["proname"] for r in q("select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')")}
    check("only the RLS predicate helpers stay executable by anon", open_fns <= {"is_admin", "is_team_lead", "is_team_lead_of", "my_team_ids", "has_sourcing_access", "wp_key_ok"}, open_fns)
    pub = {r["proname"] for r in q("select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef and has_function_privilege('public', p.oid, 'execute')")}
    check("PUBLIC has no execute on definer functions (beyond the helpers)", pub <= {"is_admin", "is_team_lead", "is_team_lead_of", "my_team_ids", "has_sourcing_access", "wp_key_ok"}, pub)
    code, body = anon_rpc("is_admin")
    check("anon can still evaluate the RLS predicate (null-safe false)", code == 200 and body in (False, None), (code, body))
    code, body = http("GET", URL + "/rest/v1/email_accounts?select=password&limit=1", None, {"apikey": ANON, "Authorization": "Bearer " + ANON})
    check("anon cannot read the password column", code >= 400 or body == [], (code, body))
    code, body = http("GET", URL + "/rest/v1/email_accounts?select=password&limit=1", None, {"apikey": ANON, "Authorization": "Bearer " + login(CALEB)})
    check("a signed-in user cannot read the password column either", code >= 400, (code, body))

    # null-safe guards: a call with NO signed-in user (the database owner has auth.uid() = null) is refused, never waved through
    lid_g = new_list(CALEB, [dict(email=f"hardtest-g1-{TAG}@example.com", **COPY)])
    gate(CALEB, lid_g); start(CALEB, lid_g)
    dial_g = q(f"select id from dials where list_id='{lid_g}'")[0]["id"]
    task_g = q(f"select id from sequence_tasks where dial_id='{dial_g}' limit 1")[0]["id"]
    for label, sql in [("seq_prepare_list", f"select seq_prepare_list('{lid_g}')"), ("start_emails", f"select start_emails('{lid_g}')"),
                       ("approve_list_copy", f"select approve_list_copy('{lid_g}')"), ("stop_sequence", f"select stop_sequence('{dial_g}')"),
                       ("complete_sequence_task", f"select complete_sequence_task('{task_g}')"),
                       ("email_queue_status", f"select email_queue_status('{uid(CALEB)}')"), ("trash_dial_list", f"select trash_dial_list('{lid_g}')")]:
        check(f"no signed-in user -> {label} raises (null-safe guard)", raises(sql), sql)
    check("the list was not trashed by the null-user call", q(f"select deleted_at from dial_lists where id='{lid_g}'")[0]["deleted_at"] is None)
    check("start_emails: another intern is refused (guard still works for people)", rpc(GAVIN, "start_emails", p_list_id=lid_g)[0] != 200)
    check("complete_sequence_task: another intern is refused", rpc(GAVIN, "complete_sequence_task", p_task_id=task_g)[0] != 200)
    q(f"update sequence_tasks set status='cancelled' where list_id='{lid_g}'")      # keep this lead out of the dispatcher's way
    # signup trigger still works with the function grants removed
    sr = {"apikey": SRK, "Authorization": "Bearer " + SRK}
    code, u = http("POST", URL + "/auth/v1/admin/users", {"email": f"hardtest-signup-{TAG}@example.com", "password": "Fake-Pass-9z!x", "email_confirm": True,
                   "user_metadata": {"full_name": "Hard Test"}}, sr)
    ok = code in (200, 201) and q(f"select count(*) n from profiles where id='{u.get('id')}'")[0]["n"] == 1 if isinstance(u, dict) else False
    check("signup trigger (handle_new_user) still creates the profile", ok, (code, u))
    if isinstance(u, dict) and u.get("id"):
        q(f"delete from profiles where id='{u['id']}'"); http("DELETE", URL + f"/auth/v1/admin/users/{u['id']}", None, sr)

    # ================================================================ 2. mailbox-admin
    print("-- 2. mailbox-admin")
    q("delete from mailbox_admin_audit")
    q("insert into app_secrets(key,value) values ('mailbox_host_allowlist','imap.example.com,smtp.example.com,localhost') on conflict (key) do update set value=excluded.value")
    q(f"delete from email_accounts where email_address ilike 'hardtest-mbx-{TAG}-%'")
    def mrow(i, **kw): return {"email": f"hardtest-mbx-{TAG}-{i}@example.com", "password": "Fake-Pass-9z!", "imap_host": "imap.example.com", "smtp_host": "smtp.example.com", **kw}
    code, r = ma({"action": "bulk_upsert", "mailboxes": [mrow(1), mrow(2, imap_host="imap.evil-host.test"), mrow(3, smtp_host="10.0.0.5"),
                                                         mrow(4, imap_host="localhost"), mrow(5, provider="google"), mrow(6, provider="microsoft")]})
    st = [x["status"] for x in r["results"]]
    check("allowlisted + provider presets created, others refused", st == ["created", "error", "error", "error", "created", "created"], r)
    check("not-on-allowlist host names the reason", "allowed mail server list" in r["results"][1].get("error", ""), r["results"][1])
    check("IP literal host refused", "not an IP" in r["results"][2].get("error", ""), r["results"][2])
    check("host that is private/local refused", "private" in r["results"][3].get("error", ""), r["results"][3])
    # host / port change needs the password in the same request
    code, r = ma({"action": "bulk_upsert", "mailboxes": [{"email": f"hardtest-mbx-{TAG}-1@example.com", "smtp_host": "smtp.gmail.com"}]})
    check("host change without password refused", r["results"][0]["status"] == "error" and "password" in r["results"][0]["error"], r)
    code, r = ma({"action": "bulk_upsert", "mailboxes": [{"email": f"hardtest-mbx-{TAG}-1@example.com", "smtp_port": 2525}]})
    check("port change without password refused", r["results"][0]["status"] == "error" and "password" in r["results"][0]["error"], r)
    code, r = ma({"action": "bulk_upsert", "mailboxes": [{"email": f"hardtest-mbx-{TAG}-1@example.com", "smtp_host": "smtp.gmail.com", "password": "New-Pass-1!"}]})
    check("host change WITH the password works", r["results"][0]["status"] == "updated", r)
    row = q(f"select smtp_host, password, password_secret_id from email_accounts where email_address='hardtest-mbx-{TAG}-1@example.com'")[0]
    check("host changed, plaintext column stays empty, secret stored in Vault", row["smtp_host"] == "smtp.gmail.com" and row["password"] is None and row["password_secret_id"], row)
    check("Vault returns the new password", q(f"select get_mailbox_password(id) p from email_accounts where email_address='hardtest-mbx-{TAG}-1@example.com'")[0]["p"] == "New-Pass-1!")
    code, r = ma({"action": "bulk_upsert", "mailboxes": [{"email": f"hardtest-mbx-{TAG}-1@example.com", "daily_send_limit": 9}]})
    check("update without host change needs no password", r["results"][0]["status"] == "updated", r)
    code, r = ma({"action": "update", "account_id": q(f"select id from email_accounts where email_address='hardtest-mbx-{TAG}-1@example.com'")[0]["id"], "ramp_start": "2026-12-01"})
    check("update ramp_start", code == 200 and q(f"select ramp_start::text d from email_accounts where email_address='hardtest-mbx-{TAG}-1@example.com'")[0]["d"] == "2026-12-01", r)
    check("bad ramp_start refused", ma({"action": "update", "account_id": q(f"select id from email_accounts where email_address='hardtest-mbx-{TAG}-1@example.com'")[0]["id"], "ramp_start": "soon"})[0] == 400)
    # key hashed
    secrets = {r["key"]: r["value"] for r in q("select key, value from app_secrets where key like 'mailbox_admin_api_key%'")}
    check("API key is stored only as a SHA-256 hash", "mailbox_admin_api_key" not in secrets and secrets.get("mailbox_admin_api_key_hash") == sha(KEY), list(secrets))
    check("the key still works", ma({"action": "list"}, who="key")[0] == 200)
    check("wrong key -> 401", ma({"action": "list"}, who="badkey")[0] == 401)
    check("get_api_key no longer reveals a key", ma({"action": "get_api_key"})[1].get("api_key") is None)
    check("rotate_api_key: not by key", ma({"action": "rotate_api_key"}, who="key")[0] == 403)
    check("rotate_api_key: not by intern", ma({"action": "rotate_api_key"}, who="intern")[0] == 403)
    code, r = ma({"action": "rotate_api_key"})
    new_key = r.get("api_key", "")
    check("rotate_api_key (admin) returns a new key once", code == 200 and new_key.startswith("wsk_") and len(new_key) > 40, r)
    try:
        check("old key stops working, new key works", ma({"action": "list"}, who="key")[0] == 401 and
              http("POST", FN_MA, {"action": "list"}, {"x-admin-api-key": new_key})[0] == 200)
        check("only the new hash is stored", q("select value from app_secrets where key='mailbox_admin_api_key_hash'")[0]["value"] == sha(new_key))
    finally:
        q(f"update app_secrets set value={lit(sha(KEY))} where key='mailbox_admin_api_key_hash'")    # restore the suite's key
    check("original key works again after restore", ma({"action": "list"}, who="key")[0] == 200)
    # audit
    au = q("select actor, actor_key, action, target, ip, at from mailbox_admin_audit order by id")
    acts = [a["action"] for a in au]
    check("audit: every call recorded (action, actor, time)", "bulk_upsert" in acts and "rotate_api_key" in acts and "update" in acts and all(a["actor"] and a["at"] for a in au), acts[:8])
    check("audit: failed key attempts recorded", "auth_failed" in acts, acts)
    check("audit: key actor and user actor distinguished", {a["actor_key"][:4] for a in au} >= {"key:", "user"}, {a["actor_key"] for a in au})
    check("audit: rows are not readable by users", http("GET", URL + "/rest/v1/mailbox_admin_audit?select=id", None, {"apikey": ANON, "Authorization": "Bearer " + login(ADMIN)})[0] >= 400)
    # rate limit: 60 calls / 10 min per key or user
    q("delete from mailbox_admin_audit")
    adm = uid(ADMIN)
    q(f"insert into mailbox_admin_audit (actor, actor_key, action) select '{adm}', 'user:{adm}', 'list' from generate_series(1,59)")
    check("rate limit: call number 60 still allowed", ma({"action": "list"})[0] == 200)
    code, r = ma({"action": "list"})
    check("rate limit: call number 61 -> 429", code == 429, (code, r))
    check("rate limit: the API key has its own bucket", ma({"action": "list"}, who="key")[0] == 200)
    q("delete from mailbox_admin_audit")
    # dry login test: stored (Vault) password, IMAP + SMTP login only, nothing is sent
    wa = q("select id, email_address, imap_host, smtp_host, smtp_port from email_accounts where email_address in ('austin.price@getwaystationadvisors.com','austin@getwaystationadvisors.com') order by 2 desc limit 1")
    if wa:
        code, r = ma({"action": "check_login", "account_id": wa[0]["id"]})
        check(f"dry login on a Waystation mailbox ({wa[0]['email_address']}): password came from Vault, IMAP+SMTP answered",
              code == 200 and isinstance(r.get("imap", {}).get("ok"), bool) and isinstance(r.get("smtp", {}).get("ok"), bool) and "No password" not in json.dumps(r), r)
        print(f"   (dry login result: imap={r.get('imap')} smtp={r.get('smtp')})")
    else:
        check("a Waystation mailbox exists for the dry login test", False)
    check("check_login refuses bad ids", ma({"action": "check_login", "account_id": "nope"})[0] == 400)
    q(f"delete from email_accounts where email_address ilike 'hardtest-mbx-{TAG}-%'")
    q("delete from mailbox_admin_audit")

    # ================================================================ 3. duplicate sends
    print("-- 3. duplicate sends")
    box, addr = tmp_box(OWNER, f"dup-{TAG}.example")
    lid = new_list(OWNER, [dict(email=f"hardtest-d1-{TAG}@example.com", **COPY)])
    activate(OWNER, lid, "2026-12-08")
    q(f"update dials set sender_account_id='{box}' where list_id='{lid}'")
    q("select sequence_dispatch('2026-12-08 10:00-07')")
    rows = q(f"select s.id from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id where t.list_id='{lid}'")
    if not rows:
        print("DEBUG", q(f"select d.seq_state, d.sender_account_id, d.copy_ok, d.tz from dials d where d.list_id='{lid}'"),
              q(f"select kind,status,due_on from sequence_tasks where list_id='{lid}'"),
              q(f"select id, owner_id, send_paused_reason, needs_assignment from email_accounts where id='{box}'"),
              q("select sequence_dispatch('2026-12-08 10:01-07') n"))
    sid = rows[0]["id"]
    check("setup: lead queued on the temp mailbox", q(f"select account_id from scheduled_emails where id='{sid}'")[0]["account_id"] == box)
    q(f"update scheduled_emails set status='sending', claimed_at = now() - interval '20 minutes' where id='{sid}'")
    q("select dispatch_scheduled_emails()")
    s = q(f"select status, error from scheduled_emails where id='{sid}'")[0]
    check("stuck in 'sending' >15 min -> 'unknown' (not failed, not retried)", s["status"] == "unknown", s)
    t = q(f"select status, last_error, attempts from sequence_tasks where scheduled_email_id='{sid}'")[0]
    check("task becomes needs-review: failed + 'Send result unknown — check Sent folder'", t["status"] == "failed" and t["last_error"] == "Send result unknown — check Sent folder", t)
    q("select dispatch_scheduled_emails()"); q("select sequence_dispatch('2026-12-08 11:00-07')")
    n = q(f"select count(*) n from scheduled_emails s join sequence_tasks t on t.dial_id=(select dial_id from sequence_tasks where scheduled_email_id='{sid}' limit 1) where s.id=t.scheduled_email_id")[0]["n"]
    check("unknown rows are never auto-retried (still one row, still unknown)", n == 1 and q(f"select status from scheduled_emails where id='{sid}'")[0]["status"] == "unknown", n)
    q(f"update scheduled_emails set status='sending', claimed_at=now() - interval '5 minutes' where id='{sid}'")
    q("select dispatch_scheduled_emails()")
    check("a 'sending' row younger than 15 min is left alone", q(f"select status from scheduled_emails where id='{sid}'")[0]["status"] == "sending")
    # idempotency in email-send
    mid1 = mid()
    q(f"""insert into email_messages (account_id, message_id, direction, from_address, to_addresses, subject, body_text, sent_at, created_by, scheduled_id, is_read)
          values ('{box}', '{mid1}', 'outbound', '{addr}', '[{{"address":"x@example.com"}}]', 's', 'b', now(), '{uid(OWNER)}', '{sid}', true)""")
    check("email_messages.scheduled_id is unique", raises(f"""insert into email_messages (account_id, message_id, direction, from_address, subject, body_text, sent_at, created_by, scheduled_id)
          values ('{box}', '{mid()}', 'outbound', '{addr}', 's', 'b', now(), '{uid(OWNER)}', '{sid}')"""))
    cron = q("select value from app_secrets where key='dispatch_cron_secret'")[0]["value"]
    hdr = {"apikey": ANON, "Authorization": "Bearer " + ANON, "x-cron-secret": cron}
    code, r = http("POST", URL + "/functions/v1/email-send", {"scheduled_id": sid}, hdr)
    check("email-send refuses to send a row that already has a stored message", code == 200 and r.get("already_sent") is True, (code, r))
    n = q(f"select count(*) n from email_messages where scheduled_id='{sid}'")[0]["n"]
    check("...and stores no second message", n == 1, n)
    time.sleep(1)
    check("...and the row is marked sent", q(f"select status from scheduled_emails where id='{sid}'")[0]["status"] == "sent", q(f"select status, error from scheduled_emails where id='{sid}'"))
    # suppressed recipient on the queue path
    sid2 = q(f"""insert into scheduled_emails (created_by, account_id, to_address, subject, body_text, send_at, status, claimed_at)
                 values ('{uid(OWNER)}', '{box}', 'hardtest-supp-{TAG}@example.com', 's', 'b', now(), 'sending', now()) returning id""")[0]["id"]
    q(f"insert into suppressed_emails (email, reason, source) values ('hardtest-supp-{TAG}@example.com', 'test', 'test')")
    code, r = http("POST", URL + "/functions/v1/email-send", {"scheduled_id": sid2}, hdr)
    check("email-send: queued send to a suppressed address is refused", code == 409 and r.get("code") == "suppressed", (code, r))
    time.sleep(1)
    check("...and the queue row is cancelled", q(f"select status from scheduled_emails where id='{sid2}'")[0]["status"] == "cancelled")
    # paused mailbox on the queue path
    q(f"update email_accounts set send_paused_reason='test pause' where id='{box}'")
    sid3 = q(f"""insert into scheduled_emails (created_by, account_id, to_address, subject, body_text, send_at, status, claimed_at)
                 values ('{uid(OWNER)}', '{box}', 'hardtest-p-{TAG}@example.com', 's', 'b', now(), 'sending', now()) returning id""")[0]["id"]
    code, r = http("POST", URL + "/functions/v1/email-send", {"scheduled_id": sid3}, hdr)
    check("email-send: a paused mailbox does not send", code == 409 and r.get("code") == "paused", (code, r))
    q(f"update email_accounts set send_paused_reason=null where id='{box}'")
    # dispatcher skips rows of paused mailboxes / paused lists
    sid4 = q(f"""insert into scheduled_emails (created_by, account_id, to_address, subject, body_text, send_at, status)
                 values ('{uid(OWNER)}', '{box}', 'hardtest-q-{TAG}@example.com', 's', 'b', now() - interval '1 minute', 'pending') returning id""")[0]["id"]
    q(f"update email_accounts set send_paused_reason='test pause' where id='{box}'")
    q("select dispatch_scheduled_emails()")
    check("dispatcher leaves a paused mailbox's pending rows alone", q(f"select status from scheduled_emails where id='{sid4}'")[0]["status"] == "pending")
    q(f"update email_accounts set send_paused_reason=null where id='{box}'")
    q(f"delete from scheduled_emails where id='{sid4}'")

    # ================================================================ 7. SMTP auth failure, header injection (before 4 to keep sections short)
    print("-- 7. SMTP auth failure + header injection")
    gbox, gaddr = tmp_box(OWNER, f"authfail-{TAG}.example", smtp=("smtp.gmail.com", 465), password="definitely-wrong-password")
    q(f"update email_accounts set imap_host='imap.gmail.com' where id='{gbox}'")
    lid = new_list(OWNER, [dict(email=f"hardtest-af-{TAG}@example.com", **COPY)])
    activate(OWNER, lid, "2026-12-09")
    q(f"update dials set sender_account_id='{gbox}' where list_id='{lid}'")
    q("select sequence_dispatch('2026-12-09 10:00-07')")
    sid = q(f"select s.id from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id where t.list_id='{lid}'")[0]["id"]
    q(f"update scheduled_emails set send_at = now() - interval '1 minute' where id='{sid}'")
    q("select dispatch_scheduled_emails()")
    for _ in range(40):
        s = q(f"select status, error from scheduled_emails where id='{sid}'")[0]
        if s["status"] not in ("pending", "sending"): break
        time.sleep(3)
    check("SMTP auth failure: queue row failed with 'Login failed'", s["status"] == "failed" and s["error"].startswith("Login failed"), s)
    check("SMTP auth failure: the mailbox is paused with the reason", q(f"select send_paused_reason r from email_accounts where id='{gbox}'")[0]["r"] == "Login failed — update the password")
    t = q(f"select status, attempts from sequence_tasks where list_id='{lid}' and kind='email'")[0]
    check("SMTP auth failure: the lead's attempt is not burned (task back to pending, 0 attempts)", t["status"] == "pending" and t["attempts"] == 0, t)
    check("SMTP auth failure: lead is unpinned from the dead mailbox", q(f"select sender_account_id s from dials where list_id='{lid}'")[0]["s"] is None)
    check("SMTP auth failure: password never in the stored error", "definitely-wrong" not in json.dumps(q(f"select error from scheduled_emails where id='{sid}'")))
    # header injection
    base = {"account_id": str(caleb_box), "subject": f"hardinj-{TAG}", "text": "b"}
    for label, extra in [("CR/LF in to", {"to": ["a@b.co\r\nBcc: evil@x.co"]}), ("LF in to", {"to": ["a@b.co\nBcc: evil@x.co"]}),
                         ("two recipients smuggled in one string", {"to": ["a@b.co, c@d.co"]}),
                         ("CR/LF in cc", {"to": ["a@b.co"], "cc": ["c@d.co\r\nX: 1"]}),
                         ("CR/LF in in_reply_to", {"to": ["a@b.co"], "in_reply_to": "<x@y>\r\nBcc: z@z.co"}),
                         ("CR/LF in attachment filename", {"to": ["a@b.co"], "attachments": [{"filename": "a.txt\r\nX: 1", "contentType": "text/plain", "base64": "QQ=="}]}),
                         ("quote in attachment filename", {"to": ["a@b.co"], "attachments": [{"filename": 'a".txt', "contentType": "text/plain", "base64": "QQ=="}]}),
                         ("CR/LF in attachment type", {"to": ["a@b.co"], "attachments": [{"filename": "a.txt", "contentType": "text/plain\r\nX: 1", "base64": "QQ=="}]})]:
        code, r = fn_user("email-send", {**base, **extra})
        check(f"email-send rejects {label}", code == 400, (code, r))
    n0 = q(f"select count(*) n from email_messages where subject like '%hardinj-{TAG}%'")[0]["n"]
    check("rejected injection attempts stored nothing", n0 == 0, n0)

    # ================================================================ 4. suppression + dedup
    print("-- 4. suppression + dedup")
    pos = ["Please unsubscribe me", "Remove me from your list", "stop", "STOP.", "Not interested, thanks", "We are no longer interested", "Please stop emailing me",
           "take me off your list", "do not contact me again", "Don't email me", "opt out", "leave me alone", "Unsubscribe", "never contact us again",
           "remove me from this mailing list please"]
    neg = ["Sounds good, call me Tuesday", "Who is the buyer?", "Tell me more about the offer", "Can we talk next week", "I will stop by your office on Friday",
           "Thanks for reaching out. Interested in a call.", "Please call my cell",
           "Not sure yet, ask me again in March", "What does the process look like"]
    bad_pos = [t for t in pos if not q(f"select reply_wants_stop(null, {lit(t)}) r")[0]["r"]]
    bad_neg = [t for t in neg if q(f"select reply_wants_stop(null, {lit(t)}) r")[0]["r"]]
    check("stop phrases detected", not bad_pos, bad_pos)
    check("ordinary replies not flagged", not bad_neg, bad_neg)
    check("quoted history is ignored", not q("select reply_wants_stop('Re: hello', E'Sounds good.\\n\\nOn Mon, Nov 23, Caleb wrote:\\n> reply stop to unsubscribe') r")[0]["r"])
    check("quoted lines (>) are ignored", not q("select reply_wants_stop('Re: hello', E'Great.\\n> unsubscribe here') r")[0]["r"])
    check("hard vs soft bounce classifier", q("select bounce_is_hard('Undelivered', '550 5.1.1 user unknown') a, bounce_is_hard('Undelivered', '452 4.2.2 mailbox full') b, bounce_is_hard('Undelivered', '550 5.7.1 blocked by policy') c")[0] == {"a": True, "b": False, "c": False})
    # admin-only edits
    check("intern cannot add to the suppression list", rpc(INTERN, "suppress_email", p_email="hardtest-x@example.com")[0] != 200)
    code, res = rpc(ADMIN, "suppress_email", p_email=f"HardTest-Admin-{TAG}@Example.com", p_reason="asked by phone")
    check("admin can suppress (stored lower-case, unique)", code == 200 and q(f"select count(*) n from suppressed_emails where email='hardtest-admin-{TAG}@example.com'")[0]["n"] == 1, (code, res))
    code, res = rpc(ADMIN, "suppress_email", p_email=f"hardtest-admin-{TAG}@example.com")
    check("suppressing twice is harmless", code == 200 and q(f"select count(*) n from suppressed_emails where email='hardtest-admin-{TAG}@example.com'")[0]["n"] == 1)
    check("gmail dots/plus are normalised", rpc(ADMIN, "suppress_email", p_email=f"jane.doe+hardtest{TAG}@gmail.com")[0] == 200 and
          q("select is_suppressed('janedoe@gmail.com') a, is_suppressed('JANE.DOE@gmail.com') b, is_suppressed('jane.other@gmail.com') c")[0] == {"a": True, "b": True, "c": False})
    rpc(ADMIN, "suppress_domain", p_domain=f"blocked-{TAG}.hardtest.org")
    check("suppressed domain blocks every address there", q(f"select is_suppressed('anyone@blocked-{TAG}.hardtest.org') a, is_suppressed('anyone@ok-{TAG}.hardtest.org') b")[0] == {"a": True, "b": False})
    # start_emails skips suppressed addresses
    emails = [f"hardtest-s{i}-{TAG}@example.com" for i in range(3)]
    q(f"insert into suppressed_emails (email, reason, source) values ('{emails[1]}', 'unsubscribed earlier', 'test')")
    lid = new_list(CALEB, [dict(email=e, **COPY) for e in emails])
    code, res = start(CALEB, lid)
    check("start: suppressed address -> backup, others start", code == 200 and res["started"] == 2 and res["suppressed"] == 1, res)
    d = q(f"select sequence, seq_state, seq_stop_reason from dials where list_id='{lid}' and email='{emails[1]}'")[0]
    check("start: suppressed lead is a backup number with the reason", d["sequence"] == "backup" and "suppression" in d["seq_stop_reason"], d)
    check("start: suppressed lead has no tasks", q(f"select count(*) n from sequence_tasks t join dials d on d.id=t.dial_id where d.list_id='{lid}' and d.email='{emails[1]}'")[0]["n"] == 0)
    # suppressed AFTER it started: admin RPC stops it at once; a raw table insert is caught by the dispatcher
    q(f"update dials set seq_day0='2026-12-10' where list_id='{lid}' and seq_state='active'"); q(f"select seq_build_tasks(id) from dials where list_id='{lid}' and seq_state='active'")
    rpc(ADMIN, "suppress_email", p_email=emails[0])
    d = q(f"select sequence, seq_state from dials where list_id='{lid}' and email='{emails[0]}'")[0]
    check("suppress_email moves an active, not-yet-emailed lead to backup immediately", d == {"sequence": "backup", "seq_state": None}, d)
    q(f"insert into suppressed_emails (email, reason, source) values ('{emails[2]}', 'raw insert', 'test')")
    q("select sequence_dispatch('2026-12-10 10:00-07')")
    d = q(f"select sequence, seq_state from dials where list_id='{lid}' and email='{emails[2]}'")[0]
    check("dispatcher never queues a suppressed address (lead -> backup)", d["sequence"] == "backup" and sched_count(lid) == 0, (d, sched_count(lid)))
    # inbound: reply says stop / bounces
    ibox = caleb_box
    lead_e = [f"hardtest-r{i}-{TAG}@example.com" for i in range(6)]
    lid = new_list(CALEB, [dict(email=e, **COPY) for e in lead_e])
    activate(CALEB, lid, "2026-12-10")
    q(f"update dials set sender_account_id='{ibox}', email_1_message_id='<hard-sent>' where list_id='{lid}'")
    def inbound(frm, subject, body):
        q(f"""insert into email_messages (account_id, message_id, direction, from_address, subject, body_text, sent_at, to_addresses, is_read)
              values ('{ibox}', '{mid()}', 'inbound', {lit(frm)}, {lit(subject)}, {lit(body)}, now(), '[]', false)""")
    def supp(e): return q(f"select reason, source from suppressed_emails where email={lit(e.lower())}")
    inbound(lead_e[0], "Re: quick question", "Please remove me from your list.")
    check("reply 'remove me' -> sender suppressed (source reply)", supp(lead_e[0]) and supp(lead_e[0])[0]["source"] == "reply", supp(lead_e[0]))
    check("...and the lead is marked replied with a reply task for the intern", q(f"select seq_state from dials where email='{lead_e[0]}'")[0]["seq_state"] == "replied"
          and q(f"select count(*) n from sequence_tasks t join dials d on d.id=t.dial_id where d.email='{lead_e[0]}' and t.kind='reply'")[0]["n"] == 1)
    inbound(lead_e[1], "Re: quick question", "Sounds good, call me Tuesday afternoon.")
    check("normal interested reply -> NOT suppressed", not supp(lead_e[1]))
    inbound(lead_e[2], "Re: quick question", "Thanks.\n\nOn Mon, Nov 23, 2026 Caleb wrote:\n> If you'd like to unsubscribe, reply STOP")
    check("quoted 'unsubscribe' in the reply history -> NOT suppressed", not supp(lead_e[2]))
    inbound(lead_e[3], "Re: quick question", "Not interested, thanks")
    check("'not interested' -> suppressed", bool(supp(lead_e[3])))
    inbound(f"hardtest-stranger-{TAG}@example.com", "unsubscribe", "unsubscribe me")
    check("someone we never emailed saying unsubscribe is not added", not supp(f"hardtest-stranger-{TAG}@example.com"))
    inbound("mailer-daemon@hardtest-mail.example", "Undelivered Mail Returned to Sender", f"Final-Recipient: rfc822; {lead_e[4]}\n550 5.1.1 <{lead_e[4]}>: user unknown")
    check("hard bounce -> address suppressed (source bounce)", supp(lead_e[4]) and supp(lead_e[4])[0]["source"] == "bounce", supp(lead_e[4]))
    check("...lead is bounced and bounced_at set", q(f"select seq_state, bounced_at is not null b from dials where email='{lead_e[4]}'")[0] == {"seq_state": "bounced", "b": True})
    inbound("mailer-daemon@hardtest-mail.example", "Delivery Status Notification (Delay)", f"Final-Recipient: rfc822; {lead_e[5]}\n452 4.2.2 mailbox full for {lead_e[5]}")
    check("soft bounce (mailbox full) -> lead bounced but address NOT suppressed", not supp(lead_e[5]) and q(f"select seq_state from dials where email='{lead_e[5]}'")[0]["seq_state"] == "bounced")
    # global dedup: same address / same company domain across interns; free-mail domains are not companies
    dom, dom2 = f"dupco-{TAG}.hardtest.org", f"other-{TAG}.hardtest.org"
    for e in (f"a@{dom}", f"b@{dom}", f"c@{dom2}", f"hardtestjohn{TAG}@gmail.com", f"hardtestother.person{TAG}@gmail.com"): seed_mv(e, "ok")
    l1 = new_list(CALEB, [dict(email=f"a@{dom}", **COPY), dict(email=f"hardtestjohn{TAG}@gmail.com", **COPY)])
    code, res = start(CALEB, l1)
    check("dedup: first owner starts both", code == 200 and res["started"] == 2 and res["duplicate"] == 0, res)
    l2 = new_list(GAVIN, [dict(email=f"A@{dom}", **COPY), dict(email=f"b@{dom}", **COPY), dict(email=f"c@{dom2}", **COPY),
                          dict(email=f"hardtest.j.o.h.n{TAG}+tag@gmail.com", **COPY), dict(email=f"hardtestother.person{TAG}@gmail.com", **COPY)])
    q(f"update dials set email = lower(email) where list_id='{l2}' and email like 'hardtest.j.o%'")
    code, res = start(GAVIN, l2)
    check("dedup: other intern, same address / same company domain -> duplicate; other company + other free-mail person start",
          code == 200 and res["duplicate"] == 3 and res["started"] == 2, res)
    rows = {r["email"].lower(): r for r in q(f"select email, sequence, seq_state, seq_stop_reason from dials where list_id='{l2}'")}
    check("dedup: same address (case-insensitive) is a backup with the reason", rows[f"a@{dom}"]["sequence"] == "backup" and "active sequence" in rows[f"a@{dom}"]["seq_stop_reason"], rows[f"a@{dom}"])
    check("dedup: colleague at the same company domain is a backup", rows[f"b@{dom}"]["sequence"] == "backup", rows[f"b@{dom}"])
    check("dedup: a different company starts", rows[f"c@{dom2}"]["seq_state"] == "active", rows[f"c@{dom2}"])
    check("dedup: two different gmail people both start (free mail is not a company)", rows[f"hardtestother.person{TAG}@gmail.com"]["seq_state"] == "active")
    gm = [r for e, r in rows.items() if e.startswith("hardtest.j.o.h.n")]
    check("dedup: gmail dots/plus tags count as the same address", gm and gm[0]["sequence"] == "backup", gm)
    # same batch: two people at one company in the same list -> the first wins
    dom3 = f"batch-{TAG}.hardtest.org"
    for e in (f"x@{dom3}", f"y@{dom3}"): seed_mv(e, "ok")
    l3 = new_list(CALEB, [dict(email=f"x@{dom3}", **COPY), dict(email=f"y@{dom3}", **COPY)])
    code, res = start(CALEB, l3)
    check("dedup inside one batch: first starts, second is a duplicate", res["started"] == 1 and res["duplicate"] == 1, res)
    code, res = rpc(CALEB, "start_emails", p_list_id=l1)
    check("start_emails result carries suppressed + duplicate counts", "suppressed" in res and "duplicate" in res, res)

    # ================================================================ 5. time zones, caps, ramp
    print("-- 5. time zones, caps, ramp")
    z = q("select state_tz('TX') a, state_tz('New York') b, state_tz('az') c, state_tz('CA') d, state_tz('UT') e, state_tz('ZZ') f, state_tz(null) g, state_tz('Hawaii') h")[0]
    check("state -> IANA zone map", z == {"a": "America/Chicago", "b": "America/New_York", "c": "America/Phoenix", "d": "America/Los_Angeles", "e": "America/Denver", "f": None, "g": None, "h": "Pacific/Honolulu"}, z)
    lid = new_list(OWNER, [dict(email=f"hardtest-tz-{TAG}@example.com", **COPY)])
    q(f"update dials set state='TX' where list_id='{lid}'")
    check("dials.tz is derived from the state", q(f"select tz from dials where list_id='{lid}'")[0]["tz"] == "America/Chicago")
    code, _ = api(OWNER, "PATCH", f"/dials?list_id=eq.{lid}", {"tz": "Asia/Tokyo"})
    check("a client cannot set tz (it follows the state)", q(f"select tz from dials where list_id='{lid}'")[0]["tz"] == "America/Chicago")
    q(f"update dials set state='Narnia' where list_id='{lid}'")
    check("unknown state -> tz null (owner's zone)", q(f"select tz from dials where list_id='{lid}'")[0]["tz"] is None)
    w = q("""select recipient_window_ok('America/New_York', '2026-12-15 08:59-05') a, recipient_window_ok('America/New_York', '2026-12-15 09:00-05') b,
             recipient_window_ok('America/New_York', '2026-12-15 15:59-05') c, recipient_window_ok('America/New_York', '2026-12-15 16:00-05') d,
             recipient_window_ok('America/New_York', '2026-12-19 10:00-05') e""")[0]
    check("recipient window: 9:00-16:00 local on weekdays only", w == {"a": False, "b": True, "c": True, "d": False, "e": False}, w)

    wbox, _ = tmp_box(OWNER, f"win-{TAG}.example")
    def window_case(label, state, when, expect):
        park()
        lid = new_list(OWNER, [dict(email=f"hardtest-w-{TAG}-{uuid.uuid4().hex[:6]}@example.com", **COPY)], state=state)
        activate(OWNER, lid, when[:10])
        q(f"select sequence_dispatch('{when}')")
        got = sched_count(lid) == 1
        check(f"window: {label}", got == expect, (got, when))
        T.reset_queue(lid)
    # owner Caleb is in America/Denver; Tuesday 2026-12-15
    window_case("NY lead, 08:35 Denver = 10:35 ET -> sends", "NY", "2026-12-15 08:35-07", True)
    window_case("NY lead, 14:30 Denver = 16:30 ET -> held (recipient window closed)", "NY", "2026-12-15 14:30-07", False)
    window_case("CA lead, 08:35 Denver = 07:35 PT -> held (too early for them)", "CA", "2026-12-15 08:35-07", False)
    window_case("CA lead, 10:05 Denver = 09:05 PT -> sends", "CA", "2026-12-15 10:05-07", True)
    window_case("CA lead, 16:30 Denver = 15:30 PT -> sends", "CA", "2026-12-15 16:30-07", True)
    window_case("no state: 08:35 Denver -> held (default window 9:00)", None, "2026-12-15 08:35-07", False)
    window_case("no state: 09:05 Denver -> sends", None, "2026-12-15 09:05-07", True)
    window_case("TX lead, 08:35 Denver = 09:35 CT -> sends", "TX", "2026-12-15 08:35-07", True)

    park(); q(f"delete from email_accounts where label='TEST-HARD-BOX-{TAG}'")
    # per-domain daily cap: three mailboxes on one sending domain, cap 2/day in total
    dd = f"domcap-{TAG}.example"
    boxes = [tmp_box(OWNER, dd)[0] for _ in range(3)]
    q("insert into app_secrets(key,value) values ('domain_daily_cap','2') on conflict (key) do update set value='2'")
    lid = new_list(OWNER, [dict(email=f"hardtest-dc{i}-{TAG}@example.com", **COPY) for i in range(6)])
    activate(OWNER, lid, "2026-12-16")
    t0 = "2026-12-16 09:00-07"
    q(f"select sequence_dispatch(g) from generate_series('{t0}'::timestamptz, '2026-12-16 15:00-07', interval '5 minutes') g")
    check("domain cap: 3 mailboxes on one domain together send at most the configured cap (2)", sched_count(lid) == 2, sched_count(lid))
    check("domain_used_today counts all mailboxes on the domain", q(f"select domain_used_today('{boxes[0]}', '2026-12-16 12:00-07') n")[0]["n"] == 2)
    q("update app_secrets set value='60' where key='domain_daily_cap'")
    T.reset_queue(lid)
    q(f"select sequence_dispatch(g) from generate_series('2026-12-16 09:00-07'::timestamptz, '2026-12-16 16:30-07', interval '5 minutes') g")
    check("domain cap default 60: the 3 mailboxes then send up to their own caps", sched_count(lid) > 2, sched_count(lid))
    q("delete from app_secrets where key='domain_daily_cap'")
    check("domain_cap() defaults to 60", q("select domain_cap() c")[0]["c"] == 60)
    q(f"delete from scheduled_emails where account_id in ({','.join(repr(b) for b in boxes)})")
    q(f"delete from email_accounts where label='TEST-HARD-BOX-{TAG}'")
    # new-mailbox ramp: 2 on the first day, +1 per day, never above the normal cap
    park()
    rb, _ = tmp_box(OWNER, f"ramp-{TAG}.example", ramp="2026-12-17")
    caps = q(f"""select mailbox_day_cap('{rb}', '2026-12-17 10:00-07') d0, mailbox_day_cap('{rb}', '2026-12-18 10:00-07') d1,
                 mailbox_day_cap('{rb}', '2026-12-21 10:00-07') d4, mailbox_day_cap('{rb}', '2026-12-16 10:00-07') before,
                 mailbox_day_cap('{rb}', '2027-02-01 10:00-07') late""")[0]
    check("ramp: cap = 2 + days since ramp_start, never above 20", caps == {"d0": 2, "d1": 3, "d4": 6, "before": 2, "late": 20}, caps)
    q(f"update email_accounts set ramp_start=null where id='{rb}'")
    check("no ramp_start: normal cap", q(f"select mailbox_day_cap('{rb}') c")[0]["c"] == 20)
    q(f"update email_accounts set ramp_start='2026-12-17', daily_send_limit=3 where id='{rb}'")
    check("ramp never exceeds the mailbox's own limit", q(f"select mailbox_day_cap('{rb}', '2026-12-30 10:00-07') c")[0]["c"] == 3)
    q(f"update email_accounts set daily_send_limit=null where id='{rb}'")
    lid = new_list(OWNER, [dict(email=f"hardtest-rp{i}-{TAG}@example.com", **COPY) for i in range(6)])
    activate(OWNER, lid, "2026-12-17")
    q(f"select sequence_dispatch(g) from generate_series('2026-12-17 09:00-07'::timestamptz, '2026-12-17 15:00-07', interval '5 minutes') g")
    check("ramp: the dispatcher sends only 2 on the first ramp day from the new mailbox", sched_count(lid) == 2, sched_count(lid))
    q(f"delete from scheduled_emails where account_id='{rb}'"); q(f"delete from email_accounts where label='TEST-HARD-BOX-{TAG}'")

    # ================================================================ 6. bounce auto-pause
    print("-- 6. bounce auto-pause")
    def bounce_case(label, sends, bounces, expect_pause):
        b, _ = tmp_box(OWNER, f"bnc-{uuid.uuid4().hex[:5]}.example")
        lid = make_list(OWNER, [dict(email=f"hardtest-b-{TAG}-{uuid.uuid4().hex[:6]}@example.com", **COPY)], name=f"TEST-HARD {TAG} bounce {uuid.uuid4().hex[:6]}")
        q(f"delete from dials where list_id='{lid}'")
        q(f"""insert into dials (list_id, created_by, company_name, full_name, email, sequence, seq_state, sender_account_id, email_1_message_id)
              select '{lid}', '{uid(OWNER)}', 'Bnc ' || g, 'P', 'hardtest-bn-' || g || '-{TAG}{uuid.uuid4().hex[:5]}@example.com', 'email5', 'completed', '{b}', '<hard-x>' from generate_series(1,{sends}) g""")
        q(f"""insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on, status, completed_at)
              select id, list_id, created_by, 1, 1, 'email', current_date, 'done', now() from dials where list_id='{lid}'""")
        if bounces: q(f"update dials set bounced_at=now() where id in (select id from dials where list_id='{lid}' limit {bounces})")
        n = q("select check_bounce_rates() n")[0]["n"]
        r = q(f"select send_paused_reason from email_accounts where id='{b}'")[0]["send_paused_reason"]
        l = q(f"select send_paused_reason from dial_lists where id='{lid}'")[0]["send_paused_reason"]
        check(f"bounce guard: {label}", (r is not None and l is not None) == expect_pause and (not expect_pause or (r.startswith("Auto-paused: bounce rate") and l.startswith("Auto-paused: bounce rate"))), (r, l))
        return b, lid, r
    bounce_case("19 sends, 5 bounced -> under the 20-send minimum, no pause", 19, 5, False)
    bounce_case("40 sends, 1 bounced (2.5%) -> fine", 40, 1, False)
    bounce_case("100 sends, 3 bounced (exactly 3%) -> fine, the limit is 'over 3%'", 100, 3, False)
    b, lid_p, reason = bounce_case("30 sends, 1 bounced (3.3%) -> mailbox AND list paused", 30, 1, True)
    check("pause reason shows the rate", "3.3%" in reason, reason)
    # paused list: nothing dispatched, cannot be started
    code, res = rpc(OWNER, "start_emails", p_list_id=lid_p)
    check("a paused list cannot be (re)started", code != 200 and "paused" in str(res).lower(), (code, res))
    park()
    qbox, _ = tmp_box(OWNER, f"pl-{TAG}.example")
    lead = [dict(email=f"hardtest-pl-{TAG}@example.com", **COPY)]
    lid_q = new_list(OWNER, lead)
    activate(OWNER, lid_q, "2026-12-14")
    q(f"update dial_lists set send_paused_reason='Auto-paused: bounce rate 9%' where id='{lid_q}'")
    q("select sequence_dispatch('2026-12-14 10:00-07')")
    check("dispatcher skips a paused list", sched_count(lid_q) == 0)
    check("intern cannot resume", rpc(OWNER, "resume_sending", p_kind="list", p_id=lid_q)[0] != 200)
    code, res = rpc(ADMIN, "resume_sending", p_kind="list", p_id=lid_q)
    check("admin resumes a list", code == 200 and q(f"select send_paused_reason r from dial_lists where id='{lid_q}'")[0]["r"] is None, (code, res))
    q("select sequence_dispatch('2026-12-14 10:10-07')")
    check("...and the dispatcher sends again", sched_count(lid_q) == 1)
    T.reset_queue(lid_q)
    code, res = rpc(ADMIN, "resume_sending", p_kind="mailbox", p_id=b)
    check("admin resumes a mailbox", code == 200 and q(f"select send_paused_reason r from email_accounts where id='{b}'")[0]["r"] is None, (code, res))
    q("select check_bounce_rates()")
    check("resumed mailbox is not re-paused by the same old bounces", q(f"select send_paused_reason r from email_accounts where id='{b}'")[0]["r"] is None)
    check("resume_sending: bad kind refused", rpc(ADMIN, "resume_sending", p_kind="x", p_id=b)[0] != 200)
    check("bounce-guard cron job is scheduled every 15 minutes", q("select schedule from cron.job where jobname='bounce-guard'")[0]["schedule"] == "*/15 * * * *")

    # ================================================================ 8. deleting a list / lead
    print("-- 8. deleting a list or a lead cancels what is queued")
    park()
    dbox, _ = tmp_box(OWNER, f"del-{TAG}.example")
    lid = new_list(OWNER, [dict(email=f"hardtest-dl1-{TAG}@example.com", **COPY), dict(email=f"hardtest-dl2-{TAG}@example.com", **COPY)])
    activate(OWNER, lid, "2026-12-11")
    q(f"update dials set sender_account_id='{dbox}' where list_id='{lid}'")
    q("select sequence_dispatch(g) from generate_series('2026-12-11 09:00-07'::timestamptz, '2026-12-11 12:00-07', interval '5 minutes') g")
    check("setup: two sends queued", sched_count(lid) == 2, sched_count(lid))
    one = q(f"select d.id from dials d join sequence_tasks t on t.dial_id=d.id where d.list_id='{lid}' and t.status='queued' limit 1")[0]["id"]
    q(f"delete from dials where id='{one}'")
    check("deleting a lead cancels its queued send", sched_count(lid) == 1 and q(f"select count(*) n from scheduled_emails where dial_id='{one}' and status='cancelled'")[0]["n"] == 1)
    code, res = rpc(OWNER, "trash_dial_list", p_list_id=lid)
    check("owner trashes the list", code == 200, (code, res))
    check("trashing a list cancels queued sends", sched_count(lid) == 0, sched_count(lid))
    check("...and every pending/queued task", q(f"select count(*) n from sequence_tasks where list_id='{lid}' and status in ('pending','queued')")[0]["n"] == 0)
    check("trash_dial_list: another intern is refused", rpc(CALEB, "trash_dial_list", p_list_id=lid_q)[0] != 200)

    # ================================================================ 9. Vault
    print("-- 9. Vault")
    a = q("select count(*) n, count(password) pw, count(password_secret_id) sid from email_accounts where label not like 'TEST-HARD-BOX%'")[0]
    check("every mailbox password lives in Vault; plaintext column is empty on test", a["pw"] == 0 and a["sid"] == a["n"], a)
    pwb, _ = tmp_box(CALEB, f"vault-{TAG}.example", password="Sup3r-Secret-Value")
    raw = q(f"select s.secret from vault.secrets s join email_accounts a on a.password_secret_id=s.id where a.id='{pwb}'")[0]["secret"]
    check("Vault stores it encrypted (not the plain value)", "Sup3r-Secret-Value" not in raw)
    check("get_mailbox_password returns it", q(f"select get_mailbox_password('{pwb}') p")[0]["p"] == "Sup3r-Secret-Value")
    q(f"select set_mailbox_password('{pwb}', 'Changed-Secret-2')")
    check("set_mailbox_password rotates the same secret", q(f"select get_mailbox_password('{pwb}') p")[0]["p"] == "Changed-Secret-2"
          and q(f"select count(*) n from vault.secrets where name='mailbox_password_{pwb}'")[0]["n"] == 1)
    code, body = http("POST", URL + "/rest/v1/rpc/get_mailbox_password", {"p_account": pwb}, {"apikey": ANON, "Authorization": "Bearer " + login(ADMIN)})
    check("a signed-in admin cannot read a mailbox password through the API", code >= 400, (code, body))
    code, body = http("POST", URL + "/rest/v1/rpc/get_mailbox_password", {"p_account": pwb}, {"apikey": SRK, "Authorization": "Bearer " + SRK})
    check("service_role can (edge functions)", code == 200 and body == "Changed-Secret-2", (code, body))
    q(f"update email_accounts set password='legacy-plain', password_secret_id=null where id='{pwb}'")
    check("rollout fallback: legacy plaintext is used if Vault has nothing", q(f"select get_mailbox_password('{pwb}') p")[0]["p"] == "legacy-plain")

if __name__ == "__main__":
    ok = True
    try:
        run()
    except Exception:
        traceback.print_exc(); ok = False
    finally:
        cleanup()
        q("delete from app_secrets where key='mailbox_host_allowlist' and value like '%localhost%'")
        q("insert into app_secrets(key,value) values ('mailbox_host_allowlist','imap.example.com,smtp.example.com') on conflict (key) do update set value=excluded.value")
    print(f"\n{sum(results)}/{len(results)} passed" + ("" if ok else " (run aborted)"))
