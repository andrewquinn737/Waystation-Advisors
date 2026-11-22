"""Copy ALL live business data into the TEST project (read live, write test). Idempotent + re-runnable.

  python3 copy_live_to_test.py --dry-run      # plan + live/test counts, writes nothing
  python3 copy_live_to_test.py                # auth users, then every table, then a live-vs-test count report
  python3 copy_live_to_test.py --tables dials,calls   # subset (auth users always ensured)

Safety (read before changing):
  * LIVE is only ever read through sb.live_sql (server-enforced read-only). All writes go through sb.test_sql.
  * Auth users: one TEST user per live profile with the SAME uuid, email '<test.live.local>@example.com' (never a
    real address, so no auth mail can reach a person). Logins are written to ~/Projects/First Project/
    TEST_LOGINS_LIVE_COPY.md (chmod 600, outside the repo). Existing users keep their password.
  * NOT copied (credentials / device endpoints): app_secrets, profile_temp_passwords, push_subscriptions,
    telnyx_credentials, email passwords. Live email_accounts arrive with no credentials, sync disabled.
  * scheduled_emails arrive 'cancelled'. profiles.email_2/3 are cleared (no real address on a user row).
  * Test-only rows (test users, DEMO lists, mailboxes, campaigns, guidelines...) are never deleted.
  * Writes run with session_replication_role=replica (no triggers fire, so nothing is notified or re-stamped).
"""
import sb, sys, json, os, re, secrets, time, urllib.request, urllib.error

LOGINS = os.path.expanduser("~/Projects/First Project/TEST_LOGINS_LIVE_COPY.md")
DRY = "--dry-run" in sys.argv
ONLY = None
if "--tables" in sys.argv: ONLY = set(sys.argv[sys.argv.index("--tables") + 1].split(","))

# parent tables first (FK order); everything is business data unless listed in SKIP
TABLES = ["teams", "profiles", "team_lead_teams", "dial_lists", "email_accounts", "clients", "dials", "client_events",
          "buyers", "sellers", "deals", "commissions", "subscription_payments", "intro_call_log", "call_status_changes",
          "calls", "call_lines", "inbound_calls", "callback_tasks", "notifications", "email_messages", "email_attachments",
          "scheduled_emails", "linkedin_touches", "report_dial_rollups", "survey_responses", "sourcing_tabs",
          "sourcing_scraping_options", "sourcing_rows", "wp_lists", "wp_dials"]
SKIP = {"app_secrets": "secrets", "profile_temp_passwords": "temp passwords", "push_subscriptions": "live device endpoints",
        "telnyx_credentials": "Telnyx credentials", "caller_numbers": "TEST already has its configured pool number (unique e164)", "area_codes": "reference, already on TEST", "state_centroids": "reference, already on TEST"}
PAGE = {"call_lines": 1500, "dials": 400, "calls": 400, "email_messages": 100, "notifications": 800, "report_dial_rollups": 800, "wp_dials": 250}

def lsql(q): return sb.live_sql(q)
def tsql(q): return sb.test_sql(q)

def cols(run, t):
    return [r["column_name"] for r in run(f"select column_name from information_schema.columns where table_schema='public' and table_name='{t}' order by ordinal_position")]
def pk(t):
    r = tsql(f"""select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
                 where i.indrelid='public.{t}'::regclass and i.indisprimary""")
    return [x["attname"] for x in r]

def test_email(live_email, taken):
    local, dom = live_email.lower().split("@")
    e = f"live.{re.sub(r'[^a-z0-9._-]', '', local)}@example.com"
    if e in taken:
        e = f"live.{re.sub(r'[^a-z0-9._-]', '', local)}.{re.sub(r'[^a-z0-9]', '', dom.split('.')[0])}@example.com"
    taken.add(e); return e

# ---------------------------------------------------------------- auth users
def srk():
    return [k for k in sb.test_api("/api-keys") if k["name"] == "service_role"][0]["api_key"]

def admin_create(key, uid, email, pw, name):
    r = urllib.request.Request(f"https://{sb.TEST_REF}.supabase.co/auth/v1/admin/users", method="POST",
        data=json.dumps({"id": uid, "email": email, "password": pw, "email_confirm": True, "user_metadata": {"full_name": name}}).encode(),
        headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try: urllib.request.urlopen(r, timeout=60).read(); return True
    except urllib.error.HTTPError as e:
        if e.code == 422: return False
        raise RuntimeError(e.read().decode())

def read_logins():
    d = {}
    if os.path.exists(LOGINS):
        for ln in open(LOGINS):
            m = re.match(r"\| (.+?) \| (.+?) \| (.+?) \| (.+?) \| `(.+?)` \|", ln)
            if m and m.group(1) != "Name": d[m.group(4).strip()] = {"name": m.group(1), "role": m.group(2), "live_email": m.group(3), "email": m.group(4).strip(), "pw": m.group(5)}
    return d

def write_logins(rows):
    rows = sorted(rows, key=lambda r: (r["live_email"] != "masonquinn10@gmail.com", r["live_email"] != "masonquinn9@gmail.com", r["role"], r["name"]))
    out = ["# TEST logins for the live-data copy (TEST project only, never the live app)", "",
           "Login at the TEST site with the TEST email below (not the real address). Written by tools/testenv/copy_live_to_test.py.", "",
           "| Name | Role | Live address (for reference only) | TEST email | Password |", "|---|---|---|---|---|"]
    out += [f"| {r['name']} | {r['role']} | {r['live_email']} | {r['email']} | `{r['pw']}` |" for r in rows]
    open(LOGINS, "w").write("\n".join(out) + "\n"); os.chmod(LOGINS, 0o600)

def ensure_users(profiles):
    have = {r["id"] for r in tsql("select id from auth.users")}
    emails = {r["email"] for r in tsql("select email from auth.users")}
    known = read_logins(); by_id = {}
    mapping = {}                                     # live profile id -> test email
    for p in profiles:
        ex = tsql(f"select email from auth.users where id='{p['id']}'")
        mapping[p["id"]] = ex[0]["email"] if ex else test_email(p["email"], emails)
    new = [p for p in profiles if p["id"] not in have]
    print(f"auth users: {len(profiles)} live profiles, {len(have & {p['id'] for p in profiles})} already on TEST, {len(new)} to create")
    if DRY: return mapping
    key = srk(); rows = list(known.values()); seen = {r["email"] for r in rows}
    for p in profiles:
        te = mapping[p["id"]]
        if p["id"] in have:
            if te not in seen:                        # user exists but its password isn't recorded: set a new one
                pw = secrets.token_urlsafe(12)
                r = urllib.request.Request(f"https://{sb.TEST_REF}.supabase.co/auth/v1/admin/users/{p['id']}", method="PUT",
                    data=json.dumps({"password": pw}).encode(), headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"})
                urllib.request.urlopen(r, timeout=60).read()
                rows.append({"name": p["full_name"], "role": p["role"], "live_email": p["email"], "email": te, "pw": pw})
            continue
        pw = secrets.token_urlsafe(12)
        admin_create(key, p["id"], te, pw, p["full_name"] or te)
        rows.append({"name": p["full_name"], "role": p["role"], "live_email": p["email"], "email": te, "pw": pw})
    write_logins(rows)
    left = tsql("select count(*) c from auth.users where email !~ '@example\\.com$'")[0]["c"]
    unconf = tsql("select count(*) c from auth.users where id = any(%s) and email_confirmed_at is null" % ("array[" + ",".join(f"'{p['id']}'" for p in profiles) + "]::uuid[]"))[0]["c"]
    print(f"TEST auth users with a non-example.com address: {left}; copied users without email_confirmed_at: {unconf}")
    return mapping

# ---------------------------------------------------------------- per-table transforms
def transform(t, r, ctx):
    if t == "profiles":
        r["email"] = ctx["emails"][r["id"]]; r["email_2"] = None; r["email_3"] = None
        # a real person who shares a name with a TEST fixture account gets a suffix: name matching (mailbox owners, reports)
        # treats two people with one name as ambiguous, exactly as it should, and the fixtures rely on unique names
        if re.sub(r"\s+", " ", (r["full_name"] or "").strip().lower()) in ctx["fixture_names"]: r["full_name"] = r["full_name"].strip() + " (live copy)"
    elif t == "email_accounts":
        for c in ("password", "last_sync_error"): r[c] = None
        r["sync_enabled"] = False; r["source"] = "live_copy"
        if r["email_address"].lower() in ctx["test_boxes"]:     # same mailbox already on TEST (test-owned): keep both, copy unsendable
            l, d = r["email_address"].split("@"); r["email_address"] = f"{l}+livecopy@{d}"
    elif t == "scheduled_emails":
        r["status"] = "cancelled"; r["claimed_at"] = None
    return r

def copy_table(t, ctx):
    lc, tc = cols(lsql, t), cols(tsql, t)
    common = [c for c in lc if c in tc]; key = pk(t)
    n_live = lsql(f"select count(*) c from public.{t}")[0]["c"]
    if DRY: print(f"  {t:28s} live {n_live:>6}  cols {len(common)}/{len(lc)} (test has {len(tc)})  pk {key}"); return
    if not key: raise SystemExit(f"{t}: no primary key on TEST; cannot upsert")
    page = PAGE.get(t, 500); done = 0; order = ", ".join(key)
    while done < n_live:
        sel = ", ".join(f'"{c}"' for c in common)
        rows = lsql(f"select coalesce(jsonb_agg(x), '[]'::jsonb) j from (select {sel} from public.{t} order by {order} offset {done} limit {page}) x")[0]["j"]
        if isinstance(rows, str): rows = json.loads(rows)
        if not rows: break
        rows = [transform(t, r, ctx) for r in rows]
        tag = "q" + secrets.token_hex(4)
        cl = ", ".join(f'"{c}"' for c in common)
        upd = ", ".join(f'"{c}" = excluded."{c}"' for c in common if c not in key) or f'"{key[0]}" = excluded."{key[0]}"'
        sql = (f"begin; set local session_replication_role = replica; insert into public.{t} ({cl}) overriding system value select {cl} from jsonb_populate_recordset(null::public.{t}, ${tag}${json.dumps(rows)}${tag}$::jsonb) "
               f"on conflict ({', '.join(key)}) do update set {upd}; commit;")
        tsql(sql); done += len(rows)
        print(f"  {t}: {done}/{n_live}", end="\r")
    seq = tsql(f"select pg_get_serial_sequence('public.{t}', '{key[0]}') s")[0]["s"]
    if seq and done: tsql(f"select setval('{seq}', (select max({key[0]}) from public.{t}))")
    print(f"  {t:28s} copied {done}/{n_live}")

def main():
    profiles = lsql("select id, email, full_name, role from public.profiles order by created_at")
    print(f"{'DRY RUN - nothing is written' if DRY else 'COPY live -> TEST'}; live profiles {len(profiles)}")
    mapping = ensure_users(profiles)
    live_ids = ",".join(f"'{p['id']}'" for p in profiles)
    fx = {re.sub(r"\s+", " ", r["n"].strip().lower()) for r in tsql(f"select full_name n from public.profiles where id not in ({live_ids}) and full_name is not null")}
    ctx = {"fixture_names": fx, "emails": mapping, "test_boxes": {r["a"] for r in tsql("select lower(email_address) a from email_accounts where coalesce(source,'')<>'live_copy'")}}
    for t in TABLES:
        if ONLY and t not in ONLY: continue
        copy_table(t, ctx)
    if not DRY and (not ONLY or "email_accounts" in ONLY):   # `source` only exists on TEST: tag the copied live mailboxes so suites can tell them apart
        ids = ",".join(f"'{r['id']}'" for r in lsql("select id from public.email_accounts"))
        if ids: tsql(f"update public.email_accounts set source='live_copy', sync_enabled=false, password=null where id in ({ids})")
    # live public tables not handled either way (so a new live table is never silently ignored)
    allt = {r["tablename"] for r in lsql("select tablename from pg_tables where schemaname='public'")}
    print("not copied (by design):", {t: SKIP[t] for t in sorted(allt & set(SKIP))}, "| unlisted live tables:", sorted(allt - set(TABLES) - set(SKIP)))
    if DRY: return
    print("\nlive vs TEST row counts (TEST also holds its own test-only rows):")
    for t in TABLES:
        a = lsql(f"select count(*) c from public.{t}")[0]["c"]; b = tsql(f"select count(*) c from public.{t}")[0]["c"]
        ids = pk(t)
        miss = ""
        if len(ids) == 1 and a:   # every live id must be present on TEST
            print(f"  {t:28s} live {a:>6}  test {b:>6}") if b >= a else print(f"  {t:28s} live {a:>6}  test {b:>6}  <-- SHORT")
        else: print(f"  {t:28s} live {a:>6}  test {b:>6}")

if __name__ == "__main__":
    main()
