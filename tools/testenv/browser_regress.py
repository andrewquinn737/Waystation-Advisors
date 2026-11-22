"""Browser smoke/regression pass against localhost:5173 (TEST project). Real Chrome via Playwright.
Usage: python3 browser_regress.py [role ...]   roles: admin lead intern  (default all)
Logs in per role, opens every page, records console/page errors and failed requests, and checks menu items exist."""
import re, sys, json, os
from playwright.sync_api import sync_playwright
BASE = os.environ.get("WS_BASE", "http://localhost:5173/")
LOG = os.path.expanduser("~/Projects/First Project/TEST_LOGINS.md")
USERS = {"admin": "Test Admin", "lead": "Andrew Quinn", "intern": "Caleb Hong"}
def creds(name):
    for l in open(LOG):
        if l.startswith("| " + name):
            c = [x.strip().strip("`") for x in l.split("|")]
            return c[3], c[4]
def login(page, role):
    email, pw = creds(USERS[role])
    page.goto(BASE + "login.html"); page.fill("#email", email); page.fill("#password", pw)
    page.click("#submitBtn"); page.wait_for_url(re.compile(r"(profile|dials|admin|clients)\.html"), timeout=20000)
def new_page(ctx, errs):
    ctx.add_init_script("try{sessionStorage.setItem('ws_onboarding_skip','1')}catch(e){}")
    p = ctx.new_page()
    p.on("pageerror", lambda e: errs.append("PAGEERR " + str(e)[:200]))
    p.on("console", lambda m: errs.append("CONSOLE " + m.text[:200]) if m.type == "error" else None)
    p.on("response", lambda r: errs.append(f"HTTP {r.status} {r.url[:140]}") if r.status >= 400 and "favicon" not in r.url else None)
    return p
if __name__ == "__main__":
    roles = sys.argv[1:] or list(USERS)
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
        for role in roles:
            ctx = b.new_context(viewport={"width": 1100, "height": 800}); errs = []; p = new_page(ctx, errs)
            login(p, role)
            for page_name in ["profile", "clients", "dials", "messages", "admin", "campaigns", "mailboxes", "team", "today"]:
                errs.clear(); p.goto(BASE + page_name + ".html"); p.wait_for_timeout(2500)
                print(role, page_name, "->", p.url.split("/")[-1], "| nav:", p.eval_on_selector_all(".topnav-bar .links a", "a=>a.map(x=>x.textContent)"), "|", errs[:6])
            ctx.close()
        b.close()
