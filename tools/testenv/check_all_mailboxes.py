#!/usr/bin/env python3
"""Real login checks for every TEST mailbox (no sends). SMTP: password AUTH on the stored host/port, plus XOAUTH2 SMTP for
ms_oauth mailboxes. IMAP: XOAUTH2 (app-only token per tenant) for ms_oauth, password LOGIN otherwise.
Passwords come from Vault via the Management API, in memory only (never printed). MS client id/secret: env or hub .env over SSH.
  python3 check_all_mailboxes.py [--store]   # --store also writes sending/reading results into email_accounts"""
import imaplib, os, re, smtplib, subprocess, sys, json, urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor
import sb

HUB = ["ssh", "-i", os.path.expanduser("~/Desktop/ssh-key-2026-11-09.key"), "-o", "StrictHostKeyChecking=no",
       "ubuntu@129.146.6.202", "grep -E '^MS_OAUTH_CLIENT_(ID|SECRET)=' /opt/waystation-email-hub/.env"]

def creds():
    cid, sec = os.environ.get("MS_OAUTH_CLIENT_ID"), os.environ.get("MS_OAUTH_CLIENT_SECRET")
    if cid and sec: return cid, sec
    env = {}
    for ln in subprocess.run(HUB, capture_output=True, text=True, timeout=30).stdout.splitlines():
        k, _, v = ln.partition("="); env[k] = v.strip().strip('"\'')
    return env.get("MS_OAUTH_CLIENT_ID", ""), env.get("MS_OAUTH_CLIENT_SECRET", "")

CID, SEC = creds()
_tok = {}
def token(tenant):
    if tenant in _tok: return _tok[tenant]
    data = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": CID, "client_secret": SEC,
                                   "scope": "https://outlook.office365.com/.default"}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", data=data), timeout=30) as f:
            _tok[tenant] = (json.load(f)["access_token"], None)
    except urllib.error.HTTPError as e:
        try: _tok[tenant] = (None, (json.load(e).get("error_description") or "").split("\n")[0][:140])
        except Exception: _tok[tenant] = (None, f"token HTTP {e.code}")
    except Exception as e: _tok[tenant] = (None, str(e)[:140])
    return _tok[tenant]

def clean(e): return re.sub(r"\s+", " ", str(e))[:150]

def smtp_pw(host, port, user, pw):
    try:
        s = smtplib.SMTP_SSL(host, port, timeout=30) if port == 465 else smtplib.SMTP(host, port, timeout=30)
        if port != 465: s.ehlo(); s.starttls(); s.ehlo()
        s.login(user, pw); s.quit(); return True, ""
    except Exception as e: return False, clean(e)

def smtp_xoauth(host, port, user, tok):
    try:
        s = smtplib.SMTP(host, port, timeout=30); s.ehlo(); s.starttls(); s.ehlo()
        code, resp = s.docmd("AUTH", "XOAUTH2 " + __import__("base64").b64encode(f"user={user}\x01auth=Bearer {tok}\x01\x01".encode()).decode())
        if code == 334: code, resp = s.docmd("")
        s.quit() if code == 235 else s.close()
        return code == 235, "" if code == 235 else f"{code} {clean(resp)}"
    except Exception as e: return False, clean(e)

def imap_try(host, port, user, pw=None, tok=None):
    try:
        m = imaplib.IMAP4_SSL(host, port, timeout=30)
        if tok:
            a = f"user={user}\x01auth=Bearer {tok}\x01\x01".encode(); m.authenticate("XOAUTH2", lambda _: a)
        else: m.login(user, pw)
        m.select("INBOX", readonly=True); m.logout(); return True, ""
    except Exception as e: return False, clean(e)

def check(r):
    user, ms = r["username"], r["auth_method"] == "ms_oauth"
    out = dict(id=r["id"], email=r["email_address"], ms=ms, smtp_pw=(None, ""), smtp_oauth=(None, ""), imap=(None, ""))
    pw = r["pw"] or ""
    out["smtp_pw"] = smtp_pw(r["smtp_host"], r["smtp_port"], user, pw) if pw else (False, "no password stored")
    if ms:
        tok, err = token(user.rsplit("@", 1)[1].lower())
        out["smtp_oauth"] = smtp_xoauth(r["smtp_host"], r["smtp_port"], user, tok) if tok else (False, "token: " + (err or ""))
        out["imap"] = imap_try(r["imap_host"], r["imap_port"], user, tok=tok) if tok else (False, "token: " + (err or ""))
    else:
        out["imap"] = imap_try(r["imap_host"], r["imap_port"], user, pw=pw) if pw else (False, "no password stored")
    return out

def main():
    rows = sb.test_sql("""select a.id, a.email_address, a.username, a.auth_method, a.imap_host, a.imap_port, a.smtp_host, a.smtp_port,
        (select decrypted_secret from vault.decrypted_secrets v where v.id=a.password_secret_id) pw from email_accounts a order by 2""")
    with ThreadPoolExecutor(8) as ex: res = list(ex.map(check, rows))
    f = lambda t: "ok" if t[0] else ("-" if t[0] is None else "FAIL")
    print(f"{'mailbox':44} {'auth':8} {'SMTP pw':8} {'SMTP oauth':10} {'IMAP':6} error")
    for o in res:
        err = "; ".join(x for x in (("smtp-pw: " + o["smtp_pw"][1]) if o["smtp_pw"][1] else "", ("smtp-oauth: " + o["smtp_oauth"][1]) if o["smtp_oauth"][1] else "", ("imap: " + o["imap"][1]) if o["imap"][1] else "") if x)
        print(f"{o['email']:44} {'ms' if o['ms'] else 'pw':8} {f(o['smtp_pw']):8} {f(o['smtp_oauth']):10} {f(o['imap']):6} {err[:200]}")
    send = lambda o: o["smtp_pw"][0] or o["smtp_oauth"][0]
    print(f"\n{len(res)} mailboxes: sending ok {sum(1 for o in res if send(o))}, reading ok {sum(1 for o in res if o['imap'][0])}")
    json.dump([{k: v for k, v in o.items()} for o in res], open("/tmp/mbx_check.json", "w"))
    if "--store" in sys.argv:
        for o in res:
            errs = " | ".join(x for x in (("Sending: " + (o["smtp_pw"][1] or o["smtp_oauth"][1])) if not send(o) else "", ("Reading: " + o["imap"][1]) if not o["imap"][0] else "") if x).replace("'", "''")[:500]
            sb.test_sql(f"update email_accounts set sending_ok={'true' if send(o) else 'false'}, credentials_verified={'true' if send(o) else 'false'}, reading_ok={'true' if o['imap'][0] else 'false'}, checked_at=now(), check_error={('null' if not errs else repr(errs))} where id='{o['id']}'")

main()
