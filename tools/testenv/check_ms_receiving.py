#!/usr/bin/env python3
"""Re-runnable Microsoft 365 receiving check for the 51 Working Signal mailboxes (TEST project).

Per tenant (= mailbox domain): (1) client-credentials token ok? (2) IMAP XOAUTH2 login ok on one mailbox
(or all with --all-mailboxes). Writes email_hub_oauth/RECEIVING_STATUS.md. Sends nothing.
  python3 check_ms_receiving.py                 # report only
  python3 check_ms_receiving.py --flip          # also set sync_enabled=true on mailboxes whose IMAP login passed
  python3 check_ms_receiving.py --all-mailboxes # test every mailbox, not one per tenant
Client id/secret come from MS_OAUTH_CLIENT_ID / MS_OAUTH_CLIENT_SECRET if set, else are read in memory from the
hub .env over SSH (read-only; never printed or stored)."""
import base64, imaplib, json, os, re, subprocess, sys, time, urllib.request, urllib.parse, urllib.error
from datetime import datetime
import sb

HUB = ["ssh", "-i", os.path.expanduser("~/Desktop/ssh-key-2026-11-09.key"), "-o", "StrictHostKeyChecking=no",
       "ubuntu@129.146.6.202", "grep -E '^MS_OAUTH_CLIENT_(ID|SECRET)=' /opt/waystation-email-hub/.env"]
OUT = os.path.expanduser("~/Projects/First Project/email_hub_oauth/RECEIVING_STATUS.md")

def creds():
    cid, sec = os.environ.get("MS_OAUTH_CLIENT_ID"), os.environ.get("MS_OAUTH_CLIENT_SECRET")
    if cid and sec: return cid, sec
    env = {}
    for ln in subprocess.run(HUB, capture_output=True, text=True, timeout=30).stdout.splitlines():
        k, _, v = ln.partition("="); env[k] = v.strip().strip('"\'')
    return env.get("MS_OAUTH_CLIENT_ID", ""), env.get("MS_OAUTH_CLIENT_SECRET", "")

def token(tenant, cid, sec):
    data = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": cid, "client_secret": sec,
                                   "scope": "https://outlook.office365.com/.default"}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", data=data), timeout=30) as f:
            return json.load(f)["access_token"], None
    except urllib.error.HTTPError as e:
        try: b = json.load(e); return None, f"{(b.get('error_description') or '').split(chr(10))[0][:160]}"
        except Exception: return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)[:160]

def imap_try(user, tok):
    auth = f"user={user}\x01auth=Bearer {tok}\x01\x01".encode()
    try:
        m = imaplib.IMAP4_SSL("outlook.office365.com", 993, timeout=30)
        m.authenticate("XOAUTH2", lambda _: auth)
        typ, d = m.select("INBOX", readonly=True)
        n = d[0].decode() if d else "?"
        m.logout(); return True, f"login ok, INBOX {n} msgs"
    except Exception as e:
        return False, re.sub(r"\s+", " ", str(e))[:160]

def main():
    flip, allbox = "--flip" in sys.argv, "--all-mailboxes" in sys.argv
    cid, sec = creds()
    if not (cid and sec): sys.exit("no MS_OAUTH client credentials available")
    rows = sb.test_sql("select id, email_address, username from email_accounts where imap_host='outlook.office365.com' order by email_address")
    by = {}
    for r in rows: by.setdefault(r["username"].rsplit("@", 1)[1].lower(), []).append(r)
    table, passed = [], []
    for dom, boxes in by.items():
        tok, terr = token(dom, cid, sec)
        if not tok:
            table.append((dom, "NO", terr, "-", len(boxes))); continue
        res = []
        for b in (boxes if allbox else boxes[:1]):
            ok, msg = imap_try(b["username"], tok); res.append((b, ok, msg))
            if ok: passed.append(b["id"])
        okc = sum(1 for _, o, _ in res if o)
        table.append((dom, "yes", "", f"{okc}/{len(res)} " + "; ".join(sorted({m for _, _, m in res}))[:150], len(boxes)))
        print(dom, "token ok", [(b['username'], o) for b, o, _ in res], flush=True)
        if not allbox and okc and "--flip" in sys.argv:   # tenant-level pass: test the rest before flipping
            for b in boxes[1:]:
                ok, msg = imap_try(b["username"], tok)
                if ok: passed.append(b["id"])
    consent = sum(1 for t in table if t[1] == "yes"); imap_ok = sum(1 for t in table if t[3].startswith(tuple("123456789")) and not t[3].startswith("0/"))
    L = [f"# Microsoft 365 receiving status", f"Checked {datetime.now():%Y-%m-%d %H:%M} (TEST project). Tenants: {len(table)}; consent/token OK: {consent}; IMAP XOAUTH2 OK: {imap_ok}.", "",
         "| Tenant | Consent / token ok? | Mailboxes | IMAP XOAUTH2 result |", "|---|---|---|---|"]
    for d, c, e, i, n in table: L.append(f"| {d} | {c}{(' - ' + e) if e else ''} | {n} | {i} |")
    open(OUT, "w").write("\n".join(L) + "\n"); print("\n".join(L))
    if flip and passed:
        ids = ",".join(f"'{i}'" for i in passed)
        sb.test_sql(f"update email_accounts set sync_enabled=true where id in ({ids})"); print(f"sync_enabled set on {len(passed)} mailboxes")

main()
