"""Set up the live team as PILOT users on the TEST project (Mason approved 2026-11-23: "Mirror live team", real calls + real emails).

  python3 seed_pilot.py accounts     # TEST auth users (REAL email as login) + profiles + secrets file + distribution file
  python3 seed_pilot.py lists        # fresh copy of each person's current live lists + dials, owned by their pilot profile
  python3 seed_pilot.py secrets      # TEST_CALL_FREE_USERS (app_secrets + edge secret) and TEST_REAL_SEND_OWNERS (edge secret)
  python3 seed_pilot.py names        # suffix colliding FIXTURE display names with ' (fixture)' (only where no test matches the name)
  python3 seed_pilot.py mailboxes    # Austin's two real mailboxes move to his pilot profile

Safety:
  * LIVE is only read (sb.live_sql). Every write goes to TEST.
  * Writes that name pilot accounts are refused by sb.test_sql (the pilot guard), so this file uses sb._req directly, ONLY for
    TEST and ONLY for the pilot rows it creates. It never touches Andrew Quinn's or Jonah Johnson's rows, scheduled_emails,
    cron.job, sequence-dispatch or TEST_REDIRECT_TO.
  * Phones are copied live -> TEST inside SQL payloads and never printed.
  * Idempotent: an existing pilot keeps its password; a list already copied for a pilot (same name) is skipped.
"""
import sb, sys, json, os, re, secrets, urllib.request, urllib.error, uuid

SITE = "https://andrewquinn737.github.io/Waystation-Advisors/"
DIST = os.path.expanduser("~/Projects/First Project/Pilot_Logins_2026-11-24.txt")
SKIP_NAMES = ("Andrew Quinn", "Jonah Johnson")           # already pilots, never touched here
FOUNDING_PILOT_IDS = list(sb.PILOT_IDS)                   # Andrew, Jonah: kept in every list below
URL = f"https://{sb.TEST_REF}.supabase.co"

def W(sql):
    """TEST write/read that may name pilot accounts (bypasses the sb.test_sql pilot guard on purpose; TEST project only)."""
    return sb._req(sb.TEST_TOK, f"/projects/{sb.TEST_REF}/database/query", {"query": sql})
def lit(v): return "null" if v is None else "'" + str(v).replace("'", "''") + "'"
def load_sec(): return json.load(open(sb.SECRETS_FILE))
def save_sec(sec): json.dump(sec, open(sb.SECRETS_FILE, "w"), indent=1); os.chmod(sb.SECRETS_FILE, 0o600)
def srk(): return [k for k in sb.test_api("/api-keys") if k["name"] == "service_role"][0]["api_key"]

def roster():
    rows = sb.live_sql("select p.id, p.full_name, p.role, t.name team, lower(p.email) email, p.phone from public.profiles p left join public.teams t on t.id = p.team_id order by p.role, p.full_name")
    return [r for r in rows if r["full_name"] not in SKIP_NAMES]

def admin_create(key, email, pw, name):
    r = urllib.request.Request(URL + "/auth/v1/admin/users", method="POST",
        data=json.dumps({"email": email, "password": pw, "email_confirm": True, "user_metadata": {"full_name": name}}).encode(),
        headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try: return json.load(urllib.request.urlopen(r, timeout=60))["id"]
    except urllib.error.HTTPError as e:
        if e.code == 422:
            return W(f"select id from auth.users where lower(email) = {lit(email)}")[0]["id"]
        raise RuntimeError(e.read().decode())

def accounts():
    people = roster(); key = srk(); sec = load_sec(); acc = sec.setdefault("accounts", {})
    W("insert into public.teams (name, sort_order) select x, 100 + o from (values " + ",".join(f"({lit(t)},{i})" for i, t in enumerate(sorted({p['team'] for p in people if p['team']}))) +
      ") v(x, o) where not exists (select 1 from public.teams where name = x)")
    teams = {r["name"]: r["id"] for r in W("select id, name from public.teams")}
    made = 0
    for p in people:
        em = p["email"]
        e = acc.get(em)
        pw = (e or {}).get("password") or secrets.token_urlsafe(14)
        uid = (e or {}).get("id") or admin_create(key, em, pw, p["full_name"])
        made += 0 if e else 1
        acc[em] = {"password": pw, "role": p["role"], "name": p["full_name"], "id": uid, "pilot": True, "team": p["team"]}
        save_sec(sec)                                            # persist each credential the moment it exists
        t = lit(teams[p["team"]]) if p["team"] else "null"
        W(f"update public.profiles set full_name = {lit(p['full_name'])}, role = {lit(p['role'])}, team_id = {t}, phone = {lit(p['phone'])}, email = {lit(em)} where id = {lit(uid)}")
    # distribution file: site, then name, role, login email, password
    lines = [SITE, ""]
    for p in sorted(people, key=lambda r: ({"admin": 0, "team_lead": 1, "independent_lead": 2, "intern": 3}[r["role"]], r["full_name"])):
        a = acc[p["email"]]; lines.append(f"{p['full_name']} | {p['role']} | {p['email']} | {a['password']}")
    open(DIST, "w").write("\n".join(lines) + "\n"); os.chmod(DIST, 0o600)
    print(f"pilot accounts: {len(people)} ({made} newly created); distribution file written ({DIST})")

def pilots():
    sec = load_sec()
    return {a["name"]: a for e, a in sec["accounts"].items() if a.get("pilot") and a["name"] not in SKIP_NAMES}, sec

def lists():
    pil, sec = pilots(); roster_by_name = {p["full_name"]: p for p in roster()}
    tot_l = tot_d = 0; per = []
    for name, a in sorted(pil.items()):
        live_id = roster_by_name[name]["id"]
        ls = sb.live_sql(f"select * from public.dial_lists where created_by = '{live_id}' and deleted_at is null order by created_at")
        have = {r["name"] for r in W(f"select name from public.dial_lists where created_by = '{a['id']}'")}
        nl = nd = 0
        lcols = [r["column_name"] for r in W("select column_name from information_schema.columns where table_schema='public' and table_name='dial_lists'")]
        dcols = [r["column_name"] for r in W("select column_name from information_schema.columns where table_schema='public' and table_name='dials'")]
        for l in ls:
            if l["name"] in have: continue
            new_id = str(uuid.uuid4())
            row = {c: l[c] for c in l if c in lcols and c not in ("deleted_by",)}
            row.update(id=new_id, created_by=a["id"])
            lc = ", ".join(f'"{c}"' for c in row)
            W(f"begin; set local session_replication_role = replica; insert into public.dial_lists ({lc}) select {lc} from jsonb_populate_recordset(null::public.dial_lists, $q${json.dumps([row])}$q$::jsonb); commit;")
            nl += 1
            off = 0
            while True:
                ds = sb.live_sql(f"select * from public.dials where list_id = '{l['id']}' order by created_at, id offset {off} limit 300")
                if not ds: break
                rows = []
                for d in ds:
                    r = {c: d[c] for c in d if c in dcols}
                    r.update(id=str(uuid.uuid4()), list_id=new_id, created_by=a["id"])
                    r["callback_user_id"] = a["id"] if d.get("callback_user_id") else None
                    rows.append(r)
                cl = ", ".join(f'"{c}"' for c in rows[0])
                W(f"begin; set local session_replication_role = replica; insert into public.dials ({cl}) select {cl} from jsonb_populate_recordset(null::public.dials, $q${json.dumps(rows)}$q$::jsonb); commit;")
                nd += len(ds); off += 300
        per.append((name, nl, nd)); tot_l += nl; tot_d += nd
        print(f"  {name:22s} lists +{nl} dials +{nd}", flush=True)
    print(f"lists copied this run: {tot_l}, dials: {tot_d}")

def set_secret(name, value):
    sb.test_api("/secrets", [{"name": name, "value": value}], "POST")

def secrets_():
    pil, _ = pilots(); ids = [a["id"] for a in pil.values()]
    free = FOUNDING_PILOT_IDS + ids
    # app_secrets (database side of the call lock) and the edge secret
    W("update public.app_secrets set value = " + lit(",".join(free)) + " where key = 'TEST_CALL_FREE_USERS'")
    set_secret("TEST_CALL_FREE_USERS", ",".join(free))
    set_secret("TEST_REAL_SEND_OWNERS", ",".join(free))
    print(f"TEST_CALL_FREE_USERS: {len(free)} ids (app_secrets + edge); TEST_REAL_SEND_OWNERS: {len(free)} ids (edge)")

# fixtures whose display name collides with a pilot AND that no test matches by display name (grep'd on 2026-11-24).
# Caleb Hong (test_mailbox_admin, test_import) and Gavin Hopkinson (test_campaigns) are matched by name: left alone.
FIXTURE_SUFFIX = ["Austin Price", "Cteel Olsen", "Daren Mumford", "Harry Kouyoumjian", "Mikaela Harris", "Yaseen Chaudhry", "Jacob Farnsworth", "Kayden Hyde"]
def names():
    for n in FIXTURE_SUFFIX:
        W(f"update public.profiles set full_name = {lit(n + ' (fixture)')} where full_name = {lit(n)} and email = {lit('test.' + n.lower().replace(' ', '.') + '@example.com')}")
    print(W("select full_name, email from public.profiles where full_name like '%(fixture)' order by 1"))

def mailboxes():
    pil, _ = pilots(); au = pil["Austin Price"]["id"]
    print(W(f"update public.email_accounts set owner_id = {lit(au)} where lower(email_address) in ('austin.price@getwaystationadvisors.com','austin@getwaystationadvisors.com') and source = 'oracle_hub' returning email_address"))

if __name__ == "__main__":
    {"accounts": accounts, "lists": lists, "secrets": secrets_, "names": names, "mailboxes": mailboxes}[sys.argv[1]]()
