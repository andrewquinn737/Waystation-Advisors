"""Seed TEST project with fake teams + accounts. Credentials go to a local, git-ignored file."""
import sb, json, secrets, urllib.request, os
SECF = os.path.expanduser("~/Projects/First Project/.waystation_test_secrets.json")
sec = json.load(open(SECF))
keys = sb.test_api("/api-keys")
srk = [k for k in keys if k["name"] == "service_role"][0]["api_key"]
URL = f"https://{sb.TEST_REF}.supabase.co"
def admin_create(email, pw, name):
    r = urllib.request.Request(URL + "/auth/v1/admin/users", method="POST",
        data=json.dumps({"email": email, "password": pw, "email_confirm": True, "user_metadata": {"full_name": name}}).encode(),
        headers={"apikey": srk, "Authorization": "Bearer " + srk, "Content-Type": "application/json"})
    try: return json.load(urllib.request.urlopen(r))["id"]
    except urllib.error.HTTPError as e:
        if e.code == 422:  # exists
            return sb.test_sql(f"select id from auth.users where email='{email}'")[0]["id"]
        raise RuntimeError(e.read().decode())
sb.test_sql("insert into public.teams (name, sort_order) select x, o from (values ('Test Team A',1),('Test Team B',2)) v(x,o) where not exists (select 1 from public.teams where name=x)")
teams = {r["name"]: r["id"] for r in sb.test_sql("select id, name from public.teams")}
people = [("Test Admin", "admin", None), ("Taylor Lead", "team_lead", "Test Team A"),
          ("Jordan Intern", "intern", "Test Team A"), ("Riley Intern", "intern", "Test Team A"),
          ("Casey Intern", "intern", "Test Team B"),
          # real names from the hub's mailboxes (fake @example.com logins) so name-matching can be tested
          ("Andrew Quinn", "team_lead", "Test Team A"), ("Jonah Johnson", "team_lead", "Test Team B"),
          ("Austin Price", "team_lead", "Test Team B"),
          ("Caleb Hong", "intern", "Test Team A"), ("Gavin Hopkinson", "intern", "Test Team A"),
          ("Cteel Olsen", "intern", "Test Team A"), ("Jacob Farnsworth", "intern", "Test Team A"),
          ("Yaseen Chaudhry", "intern", "Test Team A"), ("Daren Mumford", "intern", "Test Team B"),
          ("Mikaela Harris", "intern", "Test Team B"), ("Harry Kouyoumjian", "intern", "Test Team B"),
          ("Kayden Hyde", "intern", "Test Team B")]
accts = sec.get("accounts", {})
for name, role, team in people:
    email = "test." + name.lower().replace(" ", ".") + "@example.com" if not name.startswith(("Test ","Taylor ","Jordan ","Riley ","Casey ")) else name.lower().replace(" ", ".") + "@example.com"
    pw = accts.get(email, {}).get("password") or secrets.token_urlsafe(14)
    uid = admin_create(email, pw, name)
    t = f"'{teams[team]}'" if team else "null"
    sb.test_sql(f"alter table public.profiles disable trigger profiles_protect_admin_fields; update public.profiles set role='{role}', team_id={t}, full_name='{name}' where id='{uid}'; alter table public.profiles enable trigger profiles_protect_admin_fields;")
    accts[email] = {"password": pw, "role": role, "name": name, "id": uid}
sec["accounts"] = accts; sec["service_role"] = srk
json.dump(sec, open(SECF, "w"), indent=1); os.chmod(SECF, 0o600)
print(sb.test_sql("select p.full_name, p.role, t.name team from public.profiles p left join public.teams t on t.id=p.team_id order by 2,1"))
