"""Copy the Oracle hub's mailboxes into the TEST project's email_accounts.
Passwords are decrypted on the hub server and streamed over SSH straight into the
test DB (never written to disk here). Owners are matched by full name; no match =
owned by the admin with needs_assignment = true. Sync starts OFF."""
import sb, json, subprocess, sys
REMOTE = r'''
import json, os, sqlite3, sys
sys.path.insert(0, "/opt/waystation-email-hub")
for line in open("/opt/waystation-email-hub/.env"):
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.rstrip("\n").split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
from app.security import decrypt_secret
db = sqlite3.connect("file:/opt/waystation-email-hub/data/waystation.db?mode=ro", uri=True); db.row_factory = sqlite3.Row
out = []
for r in db.execute("select * from mail_accounts"):
    d = dict(r)
    for k in ("imap_password_enc", "smtp_password_enc"):
        d[k.replace("_enc", "")] = decrypt_secret(d.pop(k)) if d.get(k) else None
    out.append(d)
print(json.dumps(out))
'''
raw = subprocess.run(["ssh", "-i", "/Users/masonquinn/Desktop/ssh-key-2026-11-09.key", "-o", "BatchMode=yes",
                      "ubuntu@129.146.6.202", "sudo -n /opt/waystation-email-hub/.venv/bin/python -"],
                     input=REMOTE, capture_output=True, text=True, check=True).stdout
rows = json.loads(raw)
admin = sb.test_sql("select id from profiles where role='admin' order by created_at limit 1")[0]["id"]
def lit(v): return "null" if v is None else "'" + str(v).replace("'", "''") + "'"
done = {"assigned": 0, "unassigned": 0}
for r in rows:
    if (r["imap_password"] or "") != (r["smtp_password"] or ""):
        print("note: IMAP/SMTP passwords differ for", r["email_address"], "- using SMTP one")
    mandate = "ma" if "waystation" in r["email_address"].lower() else "data"
    owner = sb.test_sql(f"select public.match_mailbox_owner({lit(r['display_name'])}, {lit(r['email_address'])}) id")[0]["id"]
    sec = (r.get("smtp_security") or "").lower()
    sb.test_sql(f"""insert into email_accounts (owner_id, label, email_address, imap_host, imap_port, smtp_host, smtp_port,
        username, password, use_ssl, sync_enabled, daily_send_limit, mandate, source, needs_assignment, suggested_owner_id, credentials_verified)
      values ({lit(owner or admin)}, {lit(r['display_name'] or r['email_address'])}, {lit(r['email_address'].lower())},
        {lit(r['imap_host'])}, {int(r['imap_port'] or 993)}, {lit(r['smtp_host'])}, {int(r['smtp_port'] or 465)},
        {lit(r['smtp_username'] or r['email_address'])}, {lit(r['smtp_password'] or r['imap_password'])}, true, false,
        {int(r['daily_send_limit'] or 5)}, '{mandate}', 'oracle_hub', {str(owner is None).lower()}, null, {str(bool(r['credentials_verified'])).lower()})
      on conflict (lower(email_address)) do update set password = excluded.password, daily_send_limit = excluded.daily_send_limit""")
    done["assigned" if owner else "unassigned"] += 1
print(len(rows), "mailboxes;", done)
print(sb.test_sql("""select coalesce(p.full_name,'(unassigned)') owner, a.needs_assignment, count(*), string_agg(distinct a.mandate, ',') mandate, max(a.daily_send_limit) lim
  from email_accounts a left join profiles p on p.id = a.owner_id group by 1,2 order by 1"""))
