"""Browser regression (real Chrome via Playwright) against http://localhost:5173 + the TEST project. Read-only: logs in as each role and checks
pages load clean, nav per role, no sideways scroll at 375px, and the menu items the original app had are still reachable.
Run: python3 test_browser.py   (needs the local server on :5173 and Google Chrome installed)"""
import sys
from playwright.sync_api import sync_playwright
from browser_regress import BASE, login, new_page, USERS
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))
NOISE = ("Auto-sync failed", "Failed to send a request to the Edge Function", "net::ERR_ABORTED")
NAV = {"admin": ["Profile", "Clients", "Calls", "Inbox", "Admin"], "lead": ["Profile", "Clients", "Calls", "Inbox"], "intern": ["Profile", "Clients", "Calls", "Inbox"]}
def items(p, sel):
    return p.eval_on_selector_all(sel, "b=>b.filter(x=>x.offsetParent!==null).map(x=>x.id)")
def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
        for role in USERS:
            ctx = b.new_context(viewport={"width": 1100, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, role)
            for pg in ["profile", "clients", "dials", "messages"] + (["admin"] if role == "admin" else []):
                errs.clear(); p.goto(BASE + pg + ".html"); p.wait_for_timeout(2500)
                bad = [e for e in errs if not any(n in e for n in NOISE)]
                check(f"{role}: {pg}.html loads with no errors", not bad, bad[:3])
            p.goto(BASE + "dials.html"); p.wait_for_timeout(1500)
            check(f"{role}: nav tabs", p.eval_on_selector_all(".topnav-bar .links a", "a=>a.map(x=>x.textContent)") == NAV[role])
            check(f"{role}: Calls gear (Advanced settings) is reachable", p.is_visible("#pageSettingsBtn"))
            if role == "intern":
                check("intern: no triangle menu on Calls", not p.is_visible("#pageMenuToggle"))
                p.click("#pageSettingsBtn"); p.click("#menuAdvancedBtn"); p.wait_for_timeout(500)
                rows = items(p, "#advancedSettingsPopup .advanced-settings-row")
                check("intern: Autodial, Transcript calling, Call recording, Record all calls rows exist", {"autodialRow", "transcriptCallingRow", "callRecordingRow", "recordAllCallsRow"} <= set(rows), rows)
            else:
                p.click("#pageMenuToggle"); p.wait_for_timeout(200)
                m = items(p, "#pageHeaderMenu .page-header-menu-item")
                check(f"{role}: Calls menu has Add new, Import, Select, Search, Categories", {"menuAddNewBtn", "menuImportBtn", "menuSelectBtn", "menuSearchBtn", "menuCategoriesBtn"} <= set(m), m)
            p.goto(BASE + "profile.html"); p.wait_for_timeout(2000); p.click("#pageSettingsBtn")
            check(f"{role}: Profile gear has Notifications + Advanced", {"menuNotificationsBtn", "menuAdvancedBtn"} <= set(items(p, "#settingsMenu .page-header-menu-item")))
            ctx.close()
            ctx = b.new_context(viewport={"width": 375, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, role)
            for pg in ["profile", "dials", "messages"]:
                p.goto(BASE + pg + ".html"); p.wait_for_timeout(1800)
                w = p.evaluate("document.documentElement.scrollWidth")
                check(f"{role}: {pg}.html has no sideways scroll at 375px", w <= 376, w)
            ctx.close()
        b.close()
    print(f"\n{sum(results)}/{len(results)} passed")
run()
