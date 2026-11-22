"""Browser regression (real Chrome via Playwright) against http://localhost:5173 + the TEST project. Read-only: logs in as each role and checks
pages load clean, nav per role, no sideways scroll at 375px, and the menu items the original app had are still reachable.
Run: python3 test_browser.py   (needs the local server on :5173 and Google Chrome installed)"""
import sys, re, time
import sb
from playwright.sync_api import sync_playwright
from browser_regress import BASE, login, new_page, USERS
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))
NOISE = ("Auto-sync failed", "Failed to send a request to the Edge Function", "net::ERR_ABORTED")
NAV = {"admin": ["Profile", "Clients", "Calls", "Inbox", "Admin"], "lead": ["Profile", "Clients", "Calls", "Inbox"], "intern": ["Profile", "Clients", "Calls", "Inbox"]}
def items(p, sel):
    return p.eval_on_selector_all(sel, "b=>b.filter(x=>x.offsetParent!==null).map(x=>x.id)")
LUM = """(c) => { const m = c.match(/[\\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
  return .2126 * f(m[0]) + .7152 * f(m[1]) + .0722 * f(m[2]); }"""
def contrast(p, sel, hover=False):
    if hover: p.hover(sel)
    return p.evaluate("(sel) => { const L = " + LUM + "; const e = document.querySelector(sel), cs = getComputedStyle(e); let bg = cs.backgroundColor, n = e;"
                      " while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && n.parentElement) { n = n.parentElement; bg = getComputedStyle(n).backgroundColor; }"
                      " const a = L(cs.color), b = L(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }", sel)

def round1(b):
    """Round-1 page-by-page review fixes (calls, inbox, clients, admin, profile). Desktop 1280 + phone 375."""
    print("-- round 1 review fixes")
    for role in USERS:
        ctx = b.new_context(viewport={"width": 375, "height": 812}); errs = []; p = new_page(ctx, errs); login(p, role)
        for pg in ["dials", "messages", "profile", "clients"]:
            p.goto(BASE + pg + ".html"); p.wait_for_timeout(2500)
            n = p.locator("#callbackBanners .callback-banner").count()
            h = p.locator("#callbackBanners .callback-banner").first.bounding_box()["height"] if n else 0
            check(f"{role}: {pg} at 375: callbacks are ONE compact line (never a stack)", n <= 1 and h <= 48, (n, h))
        p.goto(BASE + "dials.html"); p.wait_for_timeout(2500)
        p.click("#headerSearchBtn"); p.keyboard.type("a"); p.wait_for_timeout(900)
        check(f"{role}: Calls search at 375 has no sideways scroll (cards, not a 5-column table)", p.evaluate("document.documentElement.scrollWidth") <= 376, p.evaluate("document.documentElement.scrollWidth"))
        ctx.close()
    ctx = b.new_context(viewport={"width": 1280, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, "admin")
    # Calls: card buttons muted, readable on hover, clear selected state
    p.goto(BASE + "dials.html"); p.wait_for_timeout(2500)
    p.locator(".dh-row").first.click(); p.wait_for_selector(".dial-outcome", timeout=8000)
    check("Calls: outcome buttons are readable when hovered (contrast >= 4.5)", contrast(p, '.dial-outcome[data-outcome="no_response"]', hover=True) >= 4.5, contrast(p, '.dial-outcome[data-outcome="no_response"]'))
    check("Calls: no saturated blue fill on call buttons or outcomes", p.evaluate("[...document.querySelectorAll('.dial-call-btn,.dial-outcome')].every(e => getComputedStyle(e).backgroundColor !== 'rgb(47, 95, 237)')"))
    p.evaluate("document.querySelector('.dial-outcome[data-outcome=\"no_response\"]').classList.add('current')")
    check("Calls: the selected outcome shows a check mark and a visibly different background", p.evaluate("(() => { const e = document.querySelector('.dial-outcome.current'); const cs = getComputedStyle(e); return getComputedStyle(e, '::before').content.includes('\\u2713') && cs.backgroundColor !== getComputedStyle(document.querySelector('.dial-outcome:not(.current)')).backgroundColor; })()"))
    # Clients: the original gear is back (Accounts visible, Sellers/Buyers/Brokers for admin, Notifications, Advanced) and the header says what is in view
    p.goto(BASE + "clients.html"); p.wait_for_timeout(3000)
    p.click("#pageSettingsBtn"); p.wait_for_timeout(300)
    gear = items(p, "#settingsMenu .page-header-menu-item")
    check("Clients (admin): gear has Sellers/Buyers/Brokers, Accounts visible, Notifications, Advanced", {"dealSideToggleBtn", "menuAccountsVisibleBtn", "menuNotificationsBtn", "menuAdvancedBtn"} <= set(gear), gear)
    p.click("#dealSideToggleBtn"); p.wait_for_timeout(300)
    check("Clients (admin): Brokers view is reachable", p.eval_on_selector_all("#dealSideOptions [data-side]", "b=>b.map(x=>x.dataset.side)") == ["seller", "buyer", "broker"])
    p.click('#dealSideOptions [data-side="broker"]'); p.wait_for_timeout(2500)
    check("Clients: header line says which side + accounts are in view", re.search(r"\d+ brokers? \u00b7 (my account|all accounts|\d+ accounts?)", p.inner_text("#countBadge")) is not None, p.inner_text("#countBadge"))
    p.fill("#search", "zzzz-no-such-client"); p.wait_for_timeout(500)
    check("Clients: a search with no match says so (not 'No clients yet')", "match" in p.inner_text("#tableWrap") and "yet" not in p.inner_text("#tableWrap"), p.inner_text("#tableWrap"))
    # Messages: mailbox picker can be cleared, a failed ?from= keeps the list, Inbox tab works from inside a thread, tab title counts unread
    p.goto(BASE + "messages.html"); p.wait_for_selector(".message-thread-row", timeout=20000)
    check("Inbox: tab title shows the unread count when there is any", re.match(r"^(\(\d+\+?\) )?Inbox", p.title()) is not None, p.title())
    p.click("#pageSettingsBtn"); p.click("#menuMailboxesBtn"); p.wait_for_timeout(500)
    p.click(".select-all"); p.wait_for_timeout(300)
    check("Inbox: Mailboxes 'Select all' can be unticked (stays empty; Done blocked)", p.evaluate("!document.querySelector('.select-all input').checked && document.querySelectorAll('.mailbox-row input:checked').length === 0 && document.getElementById('mailboxesPopupClose').disabled"))
    p.click(".select-all"); p.click("#mailboxesPopupClose"); p.wait_for_timeout(1200)
    p.goto(BASE + "messages.html?from=zz_no%25match%40nowhere.test"); p.wait_for_selector(".message-thread-row", timeout=20000); p.wait_for_timeout(1500)
    check("Inbox: ?from= with no match keeps the list and says so", p.locator(".message-thread-row").count() > 0 and "isn't in the inbox" in p.inner_text("#errorBox"))
    p.locator(".message-thread-row").first.click(); p.wait_for_selector(".thread-detail", timeout=20000)
    p.click('.mail-tab[data-folder="received"]'); p.wait_for_timeout(1500)
    check("Inbox: the Inbox tab returns to the list from inside a thread", p.locator(".thread-detail").count() == 0 and p.locator(".message-thread-row").count() > 0)
    check("Inbox: thread rows are keyboard-reachable", p.evaluate("[...document.querySelectorAll('.message-thread-row')].every(r => r.tabIndex === 0 && r.getAttribute('role') === 'button')"))
    check("Inbox: no old bounce shows as a normal message (all backfilled)", sb.test_sql("select count(*) n from email_messages where direction='inbound' and is_system=false and email_system_kind(from_address, subject) is not null")[0]["n"] == 0)
    # Profile: no unused stylesheet; this week's companies-contacted count loads (fast) instead of a placeholder
    p.goto(BASE + "profile.html"); p.wait_for_function("!document.getElementById('callsThisWeekText').textContent.startsWith('\u2014')", timeout=12000)
    check("Profile: 'companies contacted this week' loads (no endless placeholder)", "contacted this week" in p.inner_text("#callsThisWeekText") and "Couldn't" not in p.inner_text("#callsThisWeekText"), p.inner_text("#callsThisWeekText"))
    check("Profile does not load the unused copyReview.css", p.evaluate("![...document.styleSheets].some(s => (s.href || '').includes('copyReview'))"))
    # Admin: campaigns open fast from cached stats, totals add up the rows shown, no server address/ssh path in Settings, honest copy
    t0 = time.time(); p.goto(BASE + "admin.html#campaigns"); p.wait_for_selector(".cp-row:not(.cp-total)", timeout=15000); dt = time.time() - t0
    check("Admin > Campaigns shows rows quickly (cached stats, no refresh pass first)", dt < 5, dt)
    sums = p.evaluate("(() => { const n = (r) => [...r.querySelectorAll('.cp-n b')].map(b => +b.textContent.replace(/,/g, '')); const rows = [...document.querySelectorAll('.cp-row:not(.cp-total)')].map(n); const tot = n(document.querySelector('.cp-total')); return [rows.reduce((a, r) => r.map((v, i) => (a[i] || 0) + v), []), tot]; })()")
    check("Admin > Campaigns: the totals row equals the sum of the rows on screen", sums[0] == sums[1], sums)
    check("Admin > Campaigns: a row with no sending mailbox never has an enabled Launch", p.evaluate("[...document.querySelectorAll('.cp-row')].filter(r => /no sending mailbox/.test(r.textContent)).every(r => { const b = r.querySelector('[data-a=launch]'); return !b || b.disabled; })"))
    edges = p.evaluate("(() => { const x = s => { const e = document.querySelector(s), r = document.createRange(); r.selectNodeContents(e); return Math.round(r.getBoundingClientRect().left); }; return [x('.page-header h1'), x('#adCampH'), x('.cp-head div'), x('.cp-row .cp-name b')]; })()")
    check("Admin: page title, section heading and table text share one left edge", max(edges) - min(edges) <= 1, edges)
    p.goto(BASE + "admin.html#settings"); p.wait_for_timeout(3000); html = p.content()
    check("Admin > Settings: no server address or ssh key path on the page", "129.146" not in html and "ssh-key" not in html and "comes later" not in html)
    ctx.close()
    print()

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
            p.goto(BASE + "profile.html"); p.wait_for_timeout(2000); p.click("#pageSettingsBtn"); p.wait_for_timeout(500)
            check(f"{role}: Profile gear has Notifications + Advanced", {"menuNotificationsBtn", "menuAdvancedBtn"} <= set(items(p, "#settingsMenu .page-header-menu-item")))
            ctx.close()
            ctx = b.new_context(viewport={"width": 375, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, role)
            for pg in ["profile", "dials", "messages"]:
                p.goto(BASE + pg + ".html"); p.wait_for_timeout(1800)
                w = p.evaluate("document.documentElement.scrollWidth")
                check(f"{role}: {pg}.html has no sideways scroll at 375px", w <= 376, w)
            ctx.close()
        round1(b)
        b.close()
    print(f"\n{sum(results)}/{len(results)} passed")
run()
