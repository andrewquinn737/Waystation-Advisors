"""Shared helpers for the live-data-copy regression (TEST project, real roles). Logins come from the
git-ignored ~/Projects/First Project/TEST_LOGINS_LIVE_COPY.md."""
import os, re
from playwright.sync_api import sync_playwright
BASE = "http://localhost:5173/"
LOG = os.path.expanduser("~/Projects/First Project/TEST_LOGINS_LIVE_COPY.md")
def creds(name):
    for l in open(LOG):
        c = [x.strip().strip("`") for x in l.split("|")]
        if len(c) > 5 and c[1] == name: return c[4], c[5]
    raise KeyError(name)
# real people (live copies; auth emails are @example.com)
WHO = {"admin": "Mason Quinn", "lead": "Jonah Johnson", "intern": "Brian Skoubye", "indlead": "Kayden Hyde", "intern2": "Jacob Farnsworth"}
def login(page, email, pw):
    page.goto(BASE + "login.html"); page.fill("#email", email); page.fill("#password", pw)
    page.click("#submitBtn"); page.wait_for_url(re.compile(r"(profile|dials|admin|clients)\.html"), timeout=25000)
def new_page(ctx, errs):
    ctx.add_init_script("try{sessionStorage.setItem('ws_onboarding_skip','1')}catch(e){}")
    p = ctx.new_page()
    p.on("pageerror", lambda e: errs.append("PAGEERR " + str(e)[:200]))
    p.on("console", lambda m: errs.append("CONSOLE " + m.text[:200]) if m.type == "error" else None)
    p.on("response", lambda r: errs.append(f"HTTP {r.status} {r.url[:140]}") if r.status >= 400 and "favicon" not in r.url else None)
    return p
