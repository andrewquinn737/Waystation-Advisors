"""TEST project setup for the in-app Claude chat worker (idempotent): creates the 'AI Assistant' admin profile, a long-lived
connector token for it (label 'ai-worker', stored hashed; the plain token goes only to the local git-ignored secrets file),
and turns the feature flag on. With --env it prints the /etc/waystation-ai/env content (TEST values) to stdout, with an EMPTY
CLAUDE_CODE_OAUTH_TOKEN line (the owner sets that himself). Usage: python3 setup_ai_worker.py [--env] [--flag off]"""
import sb, json, os, secrets, sys, hashlib, urllib.request
SECF = os.path.expanduser("~/Projects/First Project/.waystation_test_secrets.json")
sec = json.load(open(SECF))
URL = f"https://{sb.TEST_REF}.supabase.co"
EMAIL = "ai.assistant@example.com"
srk = sec["service_role"]

def ensure_user():
    r = sb.test_sql(f"select id from auth.users where email='{EMAIL}'")
    if r: return r[0]["id"]
    pw = secrets.token_urlsafe(24)       # nobody logs in as this profile; the password is discarded
    req = urllib.request.Request(URL + "/auth/v1/admin/users", method="POST",
        data=json.dumps({"email": EMAIL, "password": pw, "email_confirm": True, "user_metadata": {"full_name": "AI Assistant"}}).encode(),
        headers={"apikey": srk, "Authorization": "Bearer " + srk, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))["id"]

uid = ensure_user()
sb.test_sql(f"alter table public.profiles disable trigger profiles_protect_admin_fields; update public.profiles set role='admin', full_name='AI Assistant' where id='{uid}'; alter table public.profiles enable trigger profiles_protect_admin_fields;")
tok = sec.get("ai_connector_token")
ok = tok and sb.test_sql(f"select 1 from claude_connector_tokens where profile_id='{uid}' and revoked_at is null and token_hash=encode(extensions.digest('{tok}','sha256'),'hex') and expires_at > now() + interval '30 days'")
if not ok:
    tok = secrets.token_hex(32)
    sb.test_sql(f"update claude_connector_tokens set revoked_at=now() where profile_id='{uid}' and revoked_at is null; "
                f"insert into claude_connector_tokens (profile_id, token_hash, label, expires_at) values ('{uid}', encode(extensions.digest('{tok}','sha256'),'hex'), 'ai-worker', now() + interval '365 days')")
    sec["ai_connector_token"] = tok; json.dump(sec, open(SECF, "w"), indent=1); os.chmod(SECF, 0o600)
flag = "false" if "--flag" in sys.argv and sys.argv[sys.argv.index("--flag") + 1] == "off" else "true"
sb.test_sql(f"insert into app_secrets (key, value) values ('ai_chat_enabled', '{flag}') on conflict (key) do update set value=excluded.value")
if "--env" in sys.argv:
    print(f"SUPABASE_URL={URL}\nSUPABASE_SERVICE_ROLE_KEY={srk}\nCONNECTOR_TOKEN={tok}\nCLAUDE_CODE_OAUTH_TOKEN=\nCLAUDE_BIN=/home/waystation-ai/.local/bin/claude\nLIST_NAME_NOT_LIKE=\"TEST-AI %\"")
else:
    print("AI Assistant admin profile", uid, "| connector token ok | ai_chat_enabled =", flag)
