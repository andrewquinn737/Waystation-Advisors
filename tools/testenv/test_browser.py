"""Browser regression (real Chrome via Playwright) against http://localhost:5173 + the TEST project. Read-only: logs in as each role and checks
pages load clean, nav per role, no sideways scroll at 375px, and the menu items the original app had are still reachable.
Run: python3 test_browser.py   (needs the local server on :5173 and Google Chrome installed)"""
import sys, re, time
import sb
from playwright.sync_api import sync_playwright
from browser_regress import BASE, login, new_page, USERS, creds
creds_for = lambda role: creds(USERS[role])
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

def round2(b):
    """Round-2 review fixes: Calls load failure, outcome-save error, intro-time Cancel, tab scoping, transfer picker, touch targets, nav badge,
    scheduled folder, Reports week, AI Assistant in pickers, login deep link. Test data is TEST-R2 and removed at the end."""
    print("-- round 2 review fixes")
    adm = sb.test_sql("select id from profiles where full_name='Test Admin'")[0]["id"]
    ids = {}
    try:
        for k in ("A", "B"):
            ids[k] = sb.test_sql(f"insert into dial_lists(name,dial_type,status,created_by,mandate,sort_order) values ('TEST-R2 list {k}','seller','current','{adm}','ma',900) returning id")[0]["id"]
        d = {}
        for k in ("A", "B"):
            for n in (1, 2):
                d[k + str(n)] = sb.test_sql(f"insert into dials(list_id,created_by,company_name,full_name,email,mobile_phone,city,state,industry,contact_status) values ('{ids[k]}','{adm}','TEST-R2 Co {k}{n}','Rae {k}{n}','r2{k.lower()}{n}@testr2.example','(801) 555-01{ord(k) % 10}{n}','Provo','UT','Plumbing','uncontacted') returning id")[0]["id"]
        for k in ("A", "B"):   # one overdue call task per list
            sb.test_sql(f"insert into sequence_tasks(dial_id,list_id,owner_id,step,seq_day,kind,due_on,status) values ('{d[k+'1']}','{ids[k]}','{adm}',1,1,'call',current_date-2,'pending')")
        ctx = b.new_context(viewport={"width": 375, "height": 812}); errs = []; p = new_page(ctx, errs); login(p, "admin")
        def click_tab(k):
            if not p.query_selector(f'.dial-tab[data-id="{ids[k]}"]') and p.query_selector("#dialTabMoreBtn"): p.click("#dialTabMoreBtn")
            p.click(f'.dial-tab[data-id="{ids[k]}"]:not(.active)') if p.query_selector(f'.dial-tab[data-id="{ids[k]}"]:not(.active)') else None; p.wait_for_timeout(2500)
        def open_list(k):
            p.goto(BASE + "dials.html"); p.wait_for_selector(".dial-tab", timeout=15000); click_tab(k)
        # -- tab scoping
        open_list("A")
        txt = p.inner_text("#dialsTableWrap")
        check("Calls: Past due shows only this tab's follow-ups (not other lists')", "TEST-R2 Co A1" in txt and "TEST-R2 Co B1" not in txt, txt[:300])
        check("Calls: a note says follow-ups are due in other lists, with a way to show them", "due in other lists" in txt and p.locator("[data-scope]").count() == 1, txt[:200])
        p.click("[data-scope]"); p.wait_for_timeout(400)
        check("Calls: 'Show all lists' adds the other tabs' follow-ups", "TEST-R2 Co B1" in p.inner_text("#dialsTableWrap"))
        # -- Show N more has no '(N left)'
        check("Calls: no 'N left' wording on Show more", "left)" not in p.inner_text("#dialsTableWrap"))
        # -- load failure: retry state, never 'all caught up'
        open_list("A")
        p.route("**/rest/v1/dials?*list_id=eq.*", lambda r: r.fulfill(status=500, body='{"message":"boom"}', headers={"content-type": "application/json"}))
        click_tab("B")
        t = p.inner_text("#dialsTableWrap")
        check("Calls: a failed load shows a Retry state, never 'all caught up'", "Retry" in t and "caught up" not in t and p.locator(".dials-load-failed").count() == 1, t[:200])
        p.unroute("**/rest/v1/dials?*list_id=eq.*"); p.click("[data-reload-dials]"); p.wait_for_timeout(2500)
        check("Calls: Retry reloads the list", p.locator(".dials-load-failed").count() == 0 and "TEST-R2 Co B" in p.inner_text("#dialsTableWrap"), p.inner_text("#dialsTableWrap")[:200])
        # -- outcome save failure stays visible
        open_list("A"); p.locator(".dh-row", has_text="TEST-R2 Co A2").first.click(); p.wait_for_selector(".dial-outcome", timeout=8000)
        p.route("**/rest/v1/dials?id=eq.*", lambda r: r.fulfill(status=500, body='{"message":"new row violates row-level security"}', headers={"content-type": "application/json"}) if r.request.method == "PATCH" else r.continue_())
        p.click('.dial-outcome[data-outcome="no_response"]'); p.wait_for_timeout(1500)
        vis = p.is_visible("#dialModalError"); et = p.inner_text("#dialModalError") if vis else ""
        check("Calls: a failed outcome save leaves a visible error (not cleared by the re-render)", vis and "not saved" in et and "row-level" not in et.lower(), et)
        check("Calls: the outcome buttons work again after the failure", p.locator(".dial-outcome:not([disabled])").count() >= 4)
        p.unroute("**/rest/v1/dials?id=eq.*")
        # -- intro-time Cancel puts the status back and leaves no client
        p.click('.dial-outcome[data-outcome="intro_call_scheduled"]'); p.wait_for_selector("#manualIntroBtn", timeout=8000); p.click("#manualIntroBtn")
        p.wait_for_selector("#introCallTimeModal:not(.hidden)", timeout=8000)
        check("Calls: 'Confirm the scheduled time' has a Cancel button", p.is_visible("#introCallTimeCancelBtn"))
        p.click("#introCallTimeCancelBtn"); p.wait_for_timeout(1500)
        row = sb.test_sql(f"select contact_status, (select count(*) from clients where source_dial_id='{d['A2']}') c from dials where id='{d['A2']}'")[0]
        check("Calls: Cancel on the time step puts the dial back and leaves no client", not p.is_visible("#introCallTimeModal") and row["contact_status"] != "intro_call_scheduled" and row["c"] == 0, row)
        p.click('.dial-outcome[data-outcome="intro_call_scheduled"]'); p.wait_for_selector("#manualIntroBtn", timeout=8000); p.click("#manualIntroBtn"); p.wait_for_selector("#introCallTimeModal:not(.hidden)")
        p.keyboard.press("Escape"); p.wait_for_timeout(1500)
        row = sb.test_sql(f"select contact_status from dials where id='{d['A2']}'")[0]
        check("Calls: Esc on the time step also backs out", not p.is_visible("#introCallTimeModal") and row["contact_status"] != "intro_call_scheduled", row)
        # -- touch targets (375): inbox tabs, gear
        p.goto(BASE + "messages.html"); p.wait_for_selector(".mail-tab", timeout=15000)
        hs = p.evaluate("[...document.querySelectorAll('.mail-tab, #pageSettingsBtn')].map(e => Math.round(e.getBoundingClientRect().height))")
        check("Inbox: tabs and gear are 44px tall", all(h >= 44 for h in hs), hs)
        ctx.close()
        # -- 1280: transfer picker
        ctx = b.new_context(viewport={"width": 1280, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, "admin"); open_list("A")
        p.click(".dial-tab.active"); p.wait_for_timeout(500)
        if p.is_visible("#dialTabTransferBtn"):
            p.click("#dialTabTransferBtn"); p.wait_for_selector(".dial-tab-transfer-option", timeout=8000)
            names = p.eval_on_selector_all(".dial-tab-transfer-option", "o=>o.map(x=>x.textContent)")
            check("Transfer: People list has role labels, no AI Assistant, and a search box", all(re.search(r"(admin|team lead|intern|lead)$", n) for n in names) and not any("AI Assistant" in n for n in names) and p.is_visible(".dial-tab-transfer-search"), names[:5])
            p.fill(".dial-tab-transfer-search", "caleb"); p.wait_for_timeout(200)
            check("Transfer: search narrows the list", 0 < p.locator(".dial-tab-transfer-option:visible").count() < len(names))
            p.locator(".dial-tab-transfer-option:visible").first.click()
            check("Transfer: choosing someone asks to confirm first (Cancel / Send)", p.is_visible("[data-yes]") and p.is_visible("[data-no]"))
        else:
            check("Transfer: the tab menu is reachable", False, "no transfer button")
        ctx.close()
        # -- DB-side checks
        defs = sb.test_sql("select prosrc from pg_proc where proname='compute_report_rollups'")[0]["prosrc"]
        check("Reports: a week runs Monday to Sunday (weekend work counted)", "v_period_start + 7" in defs and "v_period_start + 5" not in defs)
        ai = sb.test_sql("select id from profiles where full_name='AI Assistant'")
        ctx = b.new_context(viewport={"width": 1280, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, "admin")
        p.goto(BASE + "clients.html"); p.wait_for_timeout(2500); p.click("#pageSettingsBtn"); p.click("#menuAccountsVisibleBtn"); p.wait_for_timeout(1500)
        p.goto(BASE + "admin.html#campaigns"); p.wait_for_function("document.querySelector('#cpList') && document.querySelector('#cpList').innerText.length > 20", timeout=20000); p.wait_for_timeout(1500)
        check("Admin > Campaigns loads, and the column is named 'Companies emailed'", "Couldn't load" not in p.inner_text("#cpList") and "Companies emailed" in p.inner_text("#cpList"), p.inner_text("#cpList")[:200])
        src = sb.test_sql("select prosrc from pg_proc where proname='admin_campaigns'")[0]["prosrc"]
        line = [l for l in src.split("\n") if "'contacted'" in l][0]
        check("Companies emailed counts first emails that went out (email_1_message_id), not replies/completions", "email_1_message_id is not null" in line and "replied" not in line, line)
        p.goto(BASE + "clients.html"); p.wait_for_timeout(2500); p.click("#pageSettingsBtn"); p.click("#menuAccountsVisibleBtn"); p.wait_for_timeout(1500)
        check("Accounts visible does not list the AI Assistant", "AI Assistant" not in p.inner_text("#accountsVisiblePopup"), p.inner_text("#accountsVisiblePopup")[:200])
        ctx.close()
        # -- logged-out deep link returns to the page that was asked for
        ctx = b.new_context(viewport={"width": 1280, "height": 800}); errs = []; p = new_page(ctx, errs)
        p.goto(BASE + "messages.html?from=zz%40nowhere.test"); p.wait_for_url(re.compile(r"login\.html"), timeout=15000)
        email, pw = creds_for("admin"); p.fill("#email", email); p.fill("#password", pw); p.click("#submitBtn"); p.wait_for_url(re.compile(r"messages\.html"), timeout=20000)
        check("Login: a logged-out deep link returns to that page after signing in", "messages.html" in p.url and "from=" in p.url, p.url)
        ctx.close()
    finally:
        sb.test_sql("delete from sequence_tasks where list_id in (select id from dial_lists where name like 'TEST-R2 %')")
        sb.test_sql("delete from clients where source_dial_id in (select d.id from dials d join dial_lists l on l.id=d.list_id where l.name like 'TEST-R2 %')")
        sb.test_sql("delete from dial_lists where name like 'TEST-R2 %'")
    print()

def round3(b):
    """Round-3 review fixes: Calls (Retry survives follow-ups, missed callbacks, failed note save, intro prompts, in-call outcome set), Reports default,
    suppression screen, review paging (120-row fixture), client Timeline calls, launch preview. Test data is TEST-R3 and removed at the end."""
    print("-- round 3 review fixes")
    adm = sb.test_sql("select id from profiles where full_name='Test Admin'")[0]["id"]
    ids, made_lists = {}, []
    try:
        for k in ("A", "B"):
            ids[k] = sb.test_sql(f"insert into dial_lists(name,dial_type,status,created_by,mandate,sort_order) values ('TEST-R3 list {k}','seller','current','{adm}','ma',901) returning id")[0]["id"]
        d = {}
        for n, (k, extra) in enumerate([("A", ""), ("A", ""), ("A", ""), ("B", "")]):
            key = k + str(n)
            d[key] = sb.test_sql(f"insert into dials(list_id,created_by,company_name,full_name,email,mobile_phone,city,state,industry,contact_status) values ('{ids[k]}','{adm}','TEST-R3 Co {key}','Rae {key}','r3{key.lower()}@testr3.example','(801) 555-02{n}0','Provo','UT','Plumbing','uncontacted') returning id")[0]["id"]
        # a callback missed 45 minutes ago, one due in 30 minutes, an overdue call task for the Retry test, and one dial with no industry
        sb.test_sql(f"update dials set contact_status='busy_callback', callback_user_id='{adm}' where id='{d['A1']}'")   # the status change sets a default callback time...
        sb.test_sql(f"update dials set contact_status='callback_interested', callback_user_id='{adm}' where id='{d['A2']}'")
        sb.test_sql(f"update dials set callback_at=now() - interval '45 minutes' where id='{d['A1']}'")   # ...which is then moved to the time we want
        sb.test_sql(f"update dials set callback_at=now() + interval '30 minutes' where id='{d['A2']}'")
        sb.test_sql(f"insert into sequence_tasks(dial_id,list_id,owner_id,step,seq_day,kind,due_on,status) values ('{d['B3']}','{ids['B']}','{adm}',1,1,'call',current_date-2,'pending')")
        sb.test_sql(f"update dials set industry=null where id='{d['A0']}'")
        ctx = b.new_context(viewport={"width": 1280, "height": 900}); errs = []; p = new_page(ctx, errs); login(p, "admin")
        def open_list(k):
            p.goto(BASE + "dials.html"); p.wait_for_selector(".dial-tab", timeout=15000)
            if not p.query_selector(f'.dial-tab[data-id="{ids[k]}"]') and p.query_selector("#dialTabMoreBtn"): p.click("#dialTabMoreBtn")
            if p.query_selector(f'.dial-tab[data-id="{ids[k]}"]:not(.active)'): p.click(f'.dial-tab[data-id="{ids[k]}"]:not(.active)')
            p.wait_for_timeout(2500)
        # -- Retry survives the follow-ups finishing (the real sheet view)
        open_list("A")
        p.route("**/rest/v1/dials?*list_id=eq.*", lambda r: r.fulfill(status=500, body='{"message":"boom"}', headers={"content-type": "application/json"}))
        p.click(f'.dial-tab[data-id="{ids["B"]}"]') if p.query_selector(f'.dial-tab[data-id="{ids["B"]}"]') else (p.click("#dialTabMoreBtn"), p.click(f'.dial-tab[data-id="{ids["B"]}"]'))
        p.wait_for_timeout(9000)   # long enough for loadFollowups (and the 6s fallback timer) to finish and re-render
        t = p.inner_text("#dialsTableWrap")
        check("Calls: the load-failure Retry is still there after the follow-ups finish (10s later)", p.locator(".dials-load-failed").count() == 1 and "caught up" not in t and "No internet" not in t, t[:200])
        p.unroute("**/rest/v1/dials?*list_id=eq.*"); p.click("[data-reload-dials]"); p.wait_for_timeout(2500)
        check("Calls: Retry reloads the list", p.locator(".dials-load-failed").count() == 0 and "TEST-R3 Co B" in p.inner_text("#dialsTableWrap"))
        # -- missed callbacks are in Past due, later today in Due today, and the banner lists the missed one
        open_list("A")
        grp = lambda n: p.inner_text(f'[data-g="{n}"]') if p.query_selector(f'[data-g="{n}"]') else ""
        check("Calls: a callback missed earlier today is in Past due, marked 'Missed callback'", "TEST-R3 Co A1" in grp(1) and "Missed callback" in grp(1), grp(1)[:200])
        check("Calls: a callback due later today is in Due today", "TEST-R3 Co A2" in grp(2), grp(2)[:200])
        c2 = b.new_context(viewport={"width": 1280, "height": 900}); p2 = new_page(c2, []); login(p2, "admin")   # the banner lists once per day per browser: a fresh browser sees it
        p2.goto(BASE + "dials.html"); p2.wait_for_timeout(3500)
        check("Calls: the callback banner lists the missed one as overdue", "overdue callback" in p2.inner_text("#callbackBanners"), p2.inner_text("#callbackBanners")[:100])
        c2.close()
        # -- failed note save: plain words, never 'Saved', no raw error at the top of the card
        p.locator(".dh-row", has_text="TEST-R3 Co A0").first.click(); p.wait_for_selector(".dial-outcome", timeout=8000)
        p.click(".dial-more summary")
        p.route("**/rest/v1/dials?id=eq.*", lambda r: r.abort() if r.request.method == "PATCH" else r.continue_())
        p.fill("#d_call_notes_live", "owner wants a call next week"); p.click("#dialModalTitle") if p.query_selector("#dialModalTitle") else p.keyboard.press("Tab"); p.wait_for_timeout(1500)
        msg = p.inner_text("#callNotesSavedMsg") if p.is_visible("#callNotesSavedMsg") else ""
        check("Calls: a failed note save says so in plain words (not 'Saved', no raw TypeError)", msg.startswith("Note not saved") and "TypeError" not in msg and "Failed to fetch" not in msg and not p.is_visible("#dialModalError"), msg)
        p.unroute("**/rest/v1/dials?id=eq.*")
        # -- intro: the missing-information prompt comes BEFORE the status flips
        p.click('.dial-outcome[data-outcome="intro_call_scheduled"]'); p.wait_for_timeout(1200)
        row = sb.test_sql(f"select contact_status, (select count(*) from clients where source_dial_id='{d['A0']}') c from dials where id='{d['A0']}'")[0]
        check("Calls: 'Intro call booked' on a dial with no industry asks first (Fill in now) and changes nothing", p.is_visible("#requiredPopup") and p.is_visible("#requiredPopupFill") and row["contact_status"] != "intro_call_scheduled" and row["c"] == 0, row)
        p.click("#requiredPopupFill"); p.wait_for_timeout(600)
        check("Calls: 'Fill in now' opens the edit form", p.is_visible("#dialSaveBtn"))
        p.click("#dialCancelBtn"); p.wait_for_timeout(500)
        # -- intro: closing the first chooser puts the dial back and removes the placeholder client
        sb.test_sql(f"update dials set industry='Plumbing' where id='{d['A0']}'")
        open_list("A"); p.locator(".dh-row", has_text="TEST-R3 Co A0").first.click(); p.wait_for_selector(".dial-outcome", timeout=8000)
        p.click('.dial-outcome[data-outcome="intro_call_scheduled"]'); p.wait_for_selector("#manualIntroBtn", timeout=8000)
        p.click("#introCallPopupClose"); p.wait_for_timeout(1800)
        row = sb.test_sql(f"select contact_status, (select count(*) from clients where source_dial_id='{d['A0']}') c from dials where id='{d['A0']}'")[0]
        check("Calls: closing the Schedule Intro Call chooser reverts the dial and leaves no client", row["contact_status"] != "intro_call_scheduled" and row["c"] == 0, row)
        # -- in-call bar: the same outcome set as the card, no keypad after hangup
        out = p.evaluate("""async () => { const m = await import('/js/callPanel.js'); const pnl = m.openCallPanel({ name: 'X', onHangup() {}, onOutcome: async () => true, onNext() {}, outcomes: [["a", "A"], ["b", "B"]] });
            pnl.ended('Call ended'); const r = { chips: [...document.querySelectorAll('.call-outcome-chip')].map((x) => x.textContent), keypad: !!document.querySelector('[data-act="keypad"]'), close: document.querySelector('[data-act="hangup"]').className }; pnl.close(); return r; }""")
        check("Calls: the in-call outcome chips are the list handed in (one outcome set), the Keypad is gone, Close is neutral", out["chips"] == ["A", "B"] and not out["keypad"] and "secondary" in out["close"], out)
        hr = p.evaluate("""async () => { const m = await import('/js/copyReview.js'); const gate = { summary: { passed: 0, held: 2 }, results: [
            { ok: false, errors: [{ message: 'Same sentence is in 5 other lead email(s)' }, { message: 'Subject contains an em/en dash' }] }, { ok: false, errors: [{ message: 'Same sentence is in 3 other lead email(s)' }] }] };
            return { why: m.heldReasons(gate), line: m.describePrepare({ email_sequence: 2, call_sequence: 1, generic_email: 1, gate }) }; }""")
        check("Import result: reasons are real sentences (no '#'), every kind of problem is counted once per lead", hr["why"][0].startswith("Same sentence is in") and "#" not in hr["line"] and hr["why"][0].endswith("(2)") and "(1)" in hr["why"][1] and "generic address like info@" in hr["line"], hr)
        src = open(__import__("os").path.join(__import__("os").path.dirname(__file__), "..", "..", "dealflow-app", "js", "dials.js")).read()
        i = src.index("function nextCompanyTarget()")
        check("Calls: 'Next company' looks at due callbacks first", "callback_at" in src[i:i + 900] and "busy_callback" in src[i:i + 900])
        ctx.close()
        # -- Reports default: a team lead sees the team, an admin sees everyone (not an empty table)
        for role in ("lead", "admin"):
            ctx = b.new_context(viewport={"width": 1280, "height": 900}); errs = []; p = new_page(ctx, errs); login(p, role)
            p.goto(BASE + "profile.html"); p.wait_for_timeout(2500)
            p.evaluate("document.getElementById('reportsBtn').click()"); p.wait_for_selector("#reportsTableWrap table", timeout=20000); p.wait_for_timeout(1500)
            rows = p.locator("#reportsTableWrap tbody tr").count(); t = p.inner_text("#reportsTableWrap")
            check(f"Reports ({role}): opens on the team / everyone (more than the totals row), not an empty table", rows >= 3 and "No accounts selected" not in t, (rows, t[:120]))
            check(f"Reports ({role}): the week is labelled, there is an Accounts button and a CSV download", "Week of" in t and p.is_visible("#reportsAccountsInlineBtn") and p.is_visible("#reportsCsvBtn"), t[:120])
            ctx.close()
        # -- admin: Do not email screen + review paging + launch preview
        ctx = b.new_context(viewport={"width": 1280, "height": 900}); errs = []; p = new_page(ctx, errs); login(p, "admin")
        p.goto(BASE + "admin.html#suppression"); p.wait_for_selector("#supAdd", timeout=15000); p.wait_for_timeout(1500)
        addr = f"r3-ui-{__import__('uuid').uuid4().hex[:6]}@testr3.example"
        p.fill("#supText", addr + "\nr3-ui.testr3.example"); p.fill("#supReason", "asked by phone (test)"); p.click("#supAdd"); p.wait_for_timeout(1500)
        check("Admin > Do not email: adding an address and a domain works and shows reason + date", addr in p.inner_text("#supList") and "asked by phone" in p.inner_text("#supList") and re.search(r"[A-Z][a-z]{2} \d+, 20\d\d", p.inner_text("#supList")), p.inner_text("#supMsg"))
        p.fill("#supSearch", addr); p.wait_for_timeout(900)
        check("Admin > Do not email: search narrows the list", p.locator(".sup-row").count() == 1)
        p.click(".sup-row .btn"); p.wait_for_selector("[data-y]", timeout=5000); p.click("[data-y]"); p.wait_for_timeout(1200)
        check("Admin > Do not email: remove (with a confirm) takes it off", sb.test_sql(f"select count(*) n from suppressed_emails where email='{addr}'")[0]["n"] == 0)
        sb.test_sql("delete from suppressed_domains where domain='r3-ui.testr3.example'")
        # review paging: 120 drafts, 50 at a time
        rl = sb.test_sql(f"insert into dial_lists(name,dial_type,status,created_by,mandate,sort_order) values ('TEST-R3 review','seller','current','{adm}','ma',902) returning id")[0]["id"]
        sb.test_sql(f"""insert into dials(list_id,created_by,company_name,full_name,email,sequence,seq_state,email_subject,email_1,email_2)
            select '{rl}','{adm}','R3 Review ' || lpad(g::text,3,'0'),'Pat','r3rev' || g || '@testr3.example','email5','awaiting_copy','Subject ' || g,'Hi Pat, note ' || g,'Follow up ' || g from generate_series(1,120) g""")
        p.evaluate(f"import('/js/copyReviewScreen.js').then((m) => m.openCopyReview({{ id: '{rl}', name: 'TEST-R3 review' }}, {{ all: true }}))")
        p.wait_for_selector(".cr-card", timeout=20000)
        n1 = p.locator(".cr-card").count(); cnt = p.inner_text("#crCount")
        check("Review: 120 drafts render 50 cards, with 'Showing 50 of 120' and a Show more button", n1 == 50 and "Showing 50 of 120" in cnt and p.is_visible("#crMore"), (n1, cnt))
        p.click("#crMore"); p.wait_for_timeout(400)
        check("Review: Show more adds the next 50", p.locator(".cr-card").count() == 100 and "Showing 100 of 120" in p.inner_text("#crCount"))
        p.click("#crMore"); p.wait_for_timeout(400)
        check("Review: the last page has no more button", p.locator(".cr-card").count() == 120 and not p.query_selector("#crMore"))
        p.click(".cr-close"); p.wait_for_timeout(300)
        # launch sheet preview before the click
        import test_sequences as T
        ll = T.make_list("test.caleb.hong@example.com", [dict(email=f"r3prev{i}@testr3.example", subj="Quick note", e1=f"Hi Pat,\n\nShort note {i}.\n\nBest,\nCaleb", e2=f"Hi Pat, circling back on note {i} ref r3.\n\nCaleb") for i in range(3)], name="TEST-R3 launch " + __import__("uuid").uuid4().hex[:5])
        made_lists.append(ll)
        T.rpc("test.caleb.hong@example.com", "seq_prepare_list", p_list_id=ll); T.gate("test.caleb.hong@example.com", ll)
        p.goto(BASE + "admin.html#campaigns"); p.wait_for_function("document.querySelector('#cpList') && document.querySelector('#cpList').innerText.length > 20", timeout=20000)
        row = p.locator(".cp-row", has_text="TEST-R3 launch").first
        row.locator('[data-a="launch"]').click(); p.wait_for_function("document.querySelector('#adPrev') && !document.querySelector('#adPrev').innerText.includes('Working out')", timeout=15000)
        t = p.inner_text("#adPrev")
        check("Launch sheet: before the click it shows how many are ready, who sends, how many a day, and when the first emails finish", "3 emails are ready" in t and " a day" in t and re.search(r"(finish|are all out|start)", t) is not None and "First email:" in t, t[:300])
        p.click("#adCancel")
        ctx.close()
        # -- client Timeline shows the call that led to the client
        cl = sb.test_sql(f"insert into clients(client_type, full_name, company_name, assigned_to, source_dial_id) values ('seller','R3 Client','TEST-R3 Co','{adm}','{d['B3']}') returning id")[0]["id"]
        sb.test_sql(f"insert into calls(user_id, dial_id, list_id, direction, mode, answered, transcribed, summary, duration_sec) values ('{adm}','{d['B3']}','{ids['A']}','outbound','in_app',true,false,'Owner said the shop is not for sale yet but would talk in spring.',95)")
        ctx = b.new_context(viewport={"width": 1280, "height": 900}); errs = []; p = new_page(ctx, errs); login(p, "admin")
        p.goto(BASE + f"clients.html?client={cl}&tab=timeline"); p.wait_for_selector(".client-calls", timeout=20000); p.wait_for_timeout(1000)
        check("Client Timeline: the call that led to the client shows with its summary and length", "not for sale yet" in p.inner_text(".client-calls") and "1:35" in p.inner_text(".client-calls"), p.inner_text(".client-calls")[:200])
        ctx.close()
    finally:
        sb.test_sql("delete from sequence_tasks where list_id in (select id from dial_lists where name like 'TEST-R3 %')")
        sb.test_sql("delete from calls where list_id in (select id from dial_lists where name like 'TEST-R3 %')")
        sb.test_sql("delete from clients where company_name = 'TEST-R3 Co' or source_dial_id in (select d.id from dials d join dial_lists l on l.id=d.list_id where l.name like 'TEST-R3 %')")
        sb.test_sql("delete from dial_lists where name like 'TEST-R3 %'")
        sb.test_sql("delete from suppressed_emails where email like '%testr3.example'")
        sb.test_sql("delete from call_status_changes where company_name like 'TEST-R3 %'")
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
        round2(b)
        round3(b)
        b.close()
    print(f"\n{sum(results)}/{len(results)} passed")
run()
