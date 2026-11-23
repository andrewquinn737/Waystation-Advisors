"""Round-5 design review regressions, part 1 (real Chrome, TEST project): Esc + focus trap + focus return on every dialog type, and network failure.
Never calls, launches, resumes or sends: the Campaigns page runs on mocked data with every sending call aborted.
Run: python3 test_round5.py   (needs the local server; WS_BASE=http://localhost:5198/ to use another port)"""
import time
from playwright.sync_api import sync_playwright
from browser_regress import BASE, login, new_page
from r5_common import check, summary, mock_campaigns

IS_OPEN = "(id) => { const e = document.querySelector(id); return !!e && !e.classList.contains('hidden') && e.getClientRects().length > 0; }"
def is_open(p, sel): return p.evaluate(IS_OPEN, sel)
def esc_closes(p, name, sel, focus_back=None):
    p.keyboard.press("Escape"); p.wait_for_timeout(2500)
    check(f"Esc closes: {name}", not is_open(p, sel), sel)
    if focus_back: check(f"focus returns to the opener after Esc: {name}", p.evaluate("(s) => document.activeElement === document.querySelector(s) || !!document.activeElement.closest(s)", focus_back), p.evaluate("document.activeElement.id || document.activeElement.className"))
def stays_inside(p, sel, n=30):
    bad = 0
    for _ in range(n):
        p.keyboard.press("Tab")
        if not p.evaluate("(s) => !!document.activeElement.closest(s)", sel): bad += 1
    return bad
def rows(p, sel, t=40000):
    p.wait_for_selector(sel, timeout=t); p.wait_for_timeout(600)

def esc_and_focus(b):
    print("-- Esc, focus trap, focus return")
    ctx = b.new_context(viewport={"width": 1280, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, "admin")
    p.goto(BASE + "dials.html"); rows(p, ".dh-row")
    p.click("#pageSettingsBtn"); p.wait_for_timeout(300)
    check("gear menu opens", is_open(p, "#settingsMenu"))
    esc_closes(p, "Calls gear menu", "#settingsMenu", "#pageSettingsBtn")
    p.locator(".dh-row").first.click(); p.wait_for_selector("#dialModalBackdrop:not(.hidden)"); p.wait_for_timeout(600)
    check("Tab stays inside the dial card (30 presses)", stays_inside(p, "#dialModalBackdrop") == 0)
    p.keyboard.press("Shift+Tab")
    check("Shift+Tab stays inside the dial card", p.evaluate("!!document.activeElement.closest('#dialModalBackdrop')"))
    esc_closes(p, "dial card", "#dialModalBackdrop", ".dh-row")
    p.evaluate("import('/js/notice.js').then(m => m.showConnectEmailNotice())"); p.wait_for_timeout(500)
    check("'Connect an email first' notice is open", is_open(p, "#noticeModal"))
    check("notice: Tab stays inside", stays_inside(p, "#noticeModal", 8) == 0)
    esc_closes(p, "'Connect an email first' notice", "#noticeModal")
    # Calls: the "New list" dialog from the + next to the tabs
    p.click("#addTabBtn") if p.locator("#addTabBtn").count() else None
    p.wait_for_timeout(300)
    if is_open(p, "#newListModal"): esc_closes(p, "new list dialog", "#newListModal")
    # Inbox: Mailboxes popup
    p.goto(BASE + "messages.html"); rows(p, ".message-thread-row")
    p.click("#pageSettingsBtn"); p.wait_for_selector("#menuMailboxesBtn", state="visible"); p.click("#menuMailboxesBtn"); p.wait_for_timeout(500)
    check("Mailboxes popup is open", is_open(p, "#mailboxesPopup"))
    check("Mailboxes popup: Tab stays inside", stays_inside(p, "#mailboxesPopup", 25) == 0)
    esc_closes(p, "Mailboxes popup", "#mailboxesPopup")
    # Clients: client modal (focus trap + keyboard row), gear menu, side picker, accounts popup, timeline dialogs
    p.goto(BASE + "clients.html"); rows(p, "tr.clickable-row")
    p.click("#pageSettingsBtn"); p.wait_for_timeout(300); esc_closes(p, "Clients gear menu", "#settingsMenu", "#pageSettingsBtn")
    p.click("#pageSettingsBtn"); p.click("#dealSideToggleBtn"); p.wait_for_selector("#dealSidePopup:not(.hidden)"); p.wait_for_timeout(300)
    check("side picker: Tab stays inside", stays_inside(p, "#dealSidePopup", 12) == 0)
    esc_closes(p, "Sellers/Buyers side picker", "#dealSidePopup")
    p.click("#pageSettingsBtn"); p.click("#menuAccountsVisibleBtn"); p.wait_for_selector("#accountsVisiblePopup:not(.hidden)"); p.wait_for_timeout(300)
    esc_closes(p, "Accounts visible popup", "#accountsVisiblePopup")
    row = p.locator("tr.clickable-row").first
    check("client rows are keyboard-reachable (tabindex 0)", p.evaluate("[...document.querySelectorAll('tr.clickable-row')].every(r => r.tabIndex === 0)"))
    row.focus(); p.keyboard.press("Enter"); p.wait_for_selector("#clientModal:not(.hidden)"); p.wait_for_timeout(800)
    check("Enter on a client row opens the client", is_open(p, "#clientModal"))
    check("client modal: 40 Tabs never leave it", stays_inside(p, "#clientModal", 40) == 0)
    p.click('#clientSubtabs [data-tab="timeline"]'); p.wait_for_selector("#timelineAddBtn"); p.wait_for_timeout(300)
    for cat in ("meeting", "task"):
        p.click("#timelineAddBtn"); p.click(f'#timelineAddMenu [data-category="{cat}"]'); p.wait_for_timeout(500)
        modal = "#eventDateModal" if is_open(p, "#eventDateModal") else "#requiredPopup"
        check(f"timeline dialog opens ({cat})", is_open(p, modal), modal)
        esc_closes(p, f"timeline {cat} dialog", modal)
    check("Esc closes the timeline '+' menu", (p.click("#timelineAddBtn"), p.keyboard.press("Escape"), p.wait_for_timeout(300), not is_open(p, "#timelineAddMenu"))[-1])
    esc_closes(p, "client modal", "#clientModal", "tr.clickable-row")
    ctx.close()

def admin_sheets(b):
    print("-- Admin: launch sheet, list details, confirm dialogs, Resume confirm (mocked data, nothing is sent)")
    ctx = b.new_context(viewport={"width": 1280, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, "admin")
    attempts = mock_campaigns(ctx)
    p.goto(BASE + "admin.html#campaigns"); rows(p, ".cp-row:not(.cp-total)")
    ready = p.locator('.cp-row[data-id$="a1"]')
    btn = ready.locator('[data-a="launch"]')
    check("Launch label shows the count and is not clipped", "1,240" in btn.inner_text() and btn.evaluate("e => e.scrollWidth <= e.clientWidth + 1"), (btn.inner_text(), btn.evaluate("e => [e.scrollWidth, e.clientWidth]")))
    check("Review label shows the count", "12" in p.locator('.cp-row[data-id$="a4"] [data-a="review"]').first.inner_text(), p.locator('.cp-row[data-id$="a4"] [data-a="review"]').first.inner_text())
    btn.click(); p.wait_for_selector(".ad-sheet-bd"); p.wait_for_timeout(500)
    check("launch sheet is a dialog with a label", p.evaluate("(() => { const e = document.querySelector('.ad-sheet-bd'); return e.getAttribute('aria-modal') === 'true' && !!e.getAttribute('aria-label'); })()"))
    check("launch sheet: Tab stays inside", stays_inside(p, ".ad-sheet-bd", 15) == 0)
    p.keyboard.press("Escape"); p.wait_for_timeout(300)
    check("Esc closes the launch sheet and focus returns to Launch", p.locator(".ad-sheet-bd").count() == 0 and p.evaluate("document.activeElement.dataset.a") == "launch", p.evaluate("document.activeElement.outerHTML.slice(0,80)"))
    ready.locator("[data-menu]").click(); p.click('.cp-menu [data-a="details"]'); p.wait_for_selector(".ad-sheet-bd"); p.wait_for_timeout(400)
    check("list details: Tab stays inside", stays_inside(p, ".ad-sheet-bd", 12) == 0)
    p.keyboard.press("Escape"); p.wait_for_timeout(300)
    check("Esc closes list details", p.locator(".ad-sheet-bd").count() == 0)
    p.locator('.cp-row[data-id$="a3"] [data-menu]').click(); p.click('.cp-menu [data-a="pause"]'); p.wait_for_selector(".cr-modal-bd"); p.wait_for_timeout(300)
    check("Pause confirm: Tab stays inside", stays_inside(p, ".cr-modal-bd", 8) == 0)
    p.keyboard.press("Escape"); p.wait_for_timeout(300)
    check("Esc closes the Pause confirm without pausing", p.locator(".cr-modal-bd").count() == 0 and "campaign_pause" not in attempts, attempts)
    p.locator('.cp-row[data-id$="a1"] [data-menu]').click(); p.keyboard.press("Escape"); p.wait_for_timeout(300)
    check("Esc closes the '...' menu and focus returns to it", p.locator(".cp-menu").count() == 0 and p.evaluate("document.activeElement.hasAttribute('data-menu')"))
    # Resume on a bounce-paused campaign asks first and says the bounce rate
    p.locator('.cp-row[data-id$="a2"] [data-a="resume"]').first.click(); p.wait_for_selector(".cr-modal-bd"); p.wait_for_timeout(300)
    txt = p.inner_text(".cr-modal-bd")
    check("Resume (bounce-paused) asks for confirmation and states the bounce rate", "7.2%" in txt and "bounce" in txt.lower() and "campaign_resume" not in attempts, txt[:200])
    p.click(".cr-modal-bd [data-n]"); p.wait_for_timeout(300)
    check("cancelling the Resume confirm resumes nothing", "campaign_resume" not in attempts and p.locator(".cr-modal-bd").count() == 0, attempts)
    check("nothing was launched, paused or resumed during these checks", attempts == [], attempts)
    ctx.close()

def network(b):
    print("-- network failure")
    ctx = b.new_context(viewport={"width": 1280, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, "admin")
    p.goto(BASE + "dials.html"); rows(p, ".dh-row")                       # warms the cached profile
    ctx.route("**/*.supabase.co/rest/v1/**", lambda r: r.abort())
    t = time.time(); p.reload()
    try: p.wait_for_selector("#offlineNotice:not(.hidden), .dials-load-failed, #netFatal", timeout=14000)
    except Exception: pass
    dt = time.time() - t; body = p.inner_text("body")
    check("blocked requests do NOT send a signed-in user to the login page", "login.html" not in p.url, p.url)
    check("the skeleton gives way to a message or cached data within ~8s", dt < 10, dt)
    check("no raw 'TypeError' / 'Failed to fetch' text on the page", "TypeError" not in body and "Failed to fetch" not in body, body[:200])
    check("the failure message has a Retry button", p.locator("#offlineNotice .retry-btn, .dials-load-failed button, #netFatal button").count() > 0)
    check("wording is accurate: 'No internet connection' is not claimed while the browser is online", "No internet connection" not in body, body[:200])
    # no cached profile at all: a full-page message with Retry, still not the login page
    p.evaluate("Object.keys(localStorage).filter(k => k.startsWith('waystation_cache_')).forEach(k => localStorage.removeItem(k))")
    t = time.time(); p.reload()
    try: p.wait_for_selector("#netFatal", timeout=16000)
    except Exception: pass
    dt = time.time() - t; body = p.inner_text("body")
    check("no cache + blocked: friendly full-page error with Retry (not login)", p.locator("#netFatal button").count() == 1 and "login.html" not in p.url, (p.url, body[:150]))
    check("... shown within ~10s, no raw error text", dt < 12 and "TypeError" not in body and "Failed to fetch" not in body, (dt, body[:150]))
    ctx.unroute("**/*.supabase.co/rest/v1/**")
    p.click("#netFatal button"); p.wait_for_selector(".dh-row", timeout=40000)
    check("Retry loads the page once the connection is back", "login.html" not in p.url and p.locator(".dh-row").count() > 0)
    # Inbox list error and timeline load error
    ctx.route("**/rest/v1/email_messages*", lambda r: r.abort())
    p.goto(BASE + "messages.html"); p.wait_for_selector("#errorBox:not(.hidden)", timeout=30000); p.wait_for_timeout(500)
    eb = p.inner_text("#errorBox")
    check("Inbox load failure: friendly message + Retry, no raw error", "TypeError" not in eb and "Failed to fetch" not in eb and p.locator("#errorBox .retry-btn").count() == 1, eb)
    ctx.unroute("**/rest/v1/email_messages*")
    p.goto(BASE + "clients.html"); rows(p, "tr.clickable-row")
    ctx.route("**/rest/v1/client_events*", lambda r: r.abort())
    p.locator("tr.clickable-row").first.click(); p.wait_for_selector("#clientModal:not(.hidden)"); p.wait_for_timeout(800)
    p.click('#clientSubtabs [data-tab="timeline"]'); p.wait_for_timeout(800)
    body = p.inner_text("#clientModalBody")
    check("Timeline load failure is an error with Retry, never 'No events yet'", "No events yet" not in body and "Couldn't load the timeline" in body and p.locator("#timelineRetryBtn").count() == 1, body[:200])
    ctx.unroute("**/rest/v1/client_events*")
    p.click("#timelineRetryBtn"); p.wait_for_timeout(1500)
    check("Timeline Retry loads it", "Couldn't load the timeline" not in p.inner_text("#clientModalBody"))
    ctx.close()

if __name__ == "__main__":
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
        for fn in (esc_and_focus, admin_sheets, network):
            try: fn(b)
            except Exception as e: check(f"{fn.__name__} ran to the end", False, repr(e)[:300])
        b.close()
    raise SystemExit(0 if summary() else 1)
