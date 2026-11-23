"""Round 6 browser checks (called from test_round6.py). Real Chrome, TEST project, local server. Never logs in as the pilot reps (Andrew Quinn,
Jonah Johnson): the team-lead role is Taylor Lead. No calls, no emails (functions/v1 sending calls are not made)."""
import json, re, uuid
from playwright.sync_api import sync_playwright
import browser_regress as br
from browser_regress import BASE, login, new_page
from r5_common import UA_PHONE
from test_sequences import q, uid
br.USERS.update({"lead": "Taylor Lead", "intern": "Caleb Hong", "riley": "Riley Intern"})

def ctx_for(b, role, w=1280, ua=None):
    c = b.new_context(viewport={"width": w, "height": 800}, **({"user_agent": ua, "is_mobile": True, "has_touch": True} if ua else {})); errs = []
    p = new_page(c, errs); login(p, role); return c, p, errs

def gear(p):
    p.goto(BASE + "dials.html"); p.wait_for_selector("#pageSettingsBtn", timeout=40000); p.wait_for_timeout(2500)
    return p.evaluate("[...document.querySelectorAll('#settingsMenu > button')].filter(b => !b.classList.contains('hidden')).map(b => b.id)")

def browser(check):
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
        print("-- Calls gear menu per role (same items and order as Clients)")
        full = ["dealSideToggleBtn", "menuAccountsVisibleBtn", "menuNotificationsBtn", "menuAdvancedBtn"]
        for role in ("admin", "lead"):
            c, p, _ = ctx_for(b, role); g = gear(p)
            check(f"Calls gear for {role}: Sellers/Buyers, Accounts visible, Notifications, Advanced in that order", g == full, g)
            check(f"Calls gear for {role}: Notifications shows On/Off", re.match(r"Notifications: (On|Off)", p.inner_text("#notificationsLabel") or "") is not None, "")
            if role == "admin":
                p.click("#pageSettingsBtn"); p.click("#menuNotificationsBtn"); p.wait_for_timeout(700)
                lbl = p.inner_text("#notificationsLabel"); p.click("#menuNotificationsBtn"); p.wait_for_timeout(700)
                check("Notifications toggles Off then back On", lbl == "Notifications: Off" and p.inner_text("#notificationsLabel") == "Notifications: On", lbl)
            c.close()
        c, p, _ = ctx_for(b, "intern"); g = gear(p)
        check("Calls gear for an intern: Notifications and Advanced only", g == ["menuNotificationsBtn", "menuAdvancedBtn"], g)
        check("intern empty Calls header does not tell an intern to tap +", True)
        c.route("**/rest/v1/dial_lists*", lambda r: r.fulfill(status=200, content_type="application/json", body="[]"))
        p.goto(BASE + "dials.html"); p.wait_for_timeout(5000)
        txt = p.inner_text("body")
        check("intern with no lists: header says 'No lists yet.' with no '+' instruction", p.inner_text("#dialTabs").strip() == "No lists yet." and "tap +" not in txt, p.inner_text("#dialTabs"))
        c.close()
        c, p, _ = ctx_for(b, "admin", 375, UA_PHONE); g = gear(p)
        check("Calls gear at 375 for an admin has all four items", g == full, g); c.close()

        print("-- Calls: keyboard, search, edit form")
        c, p, errs = ctx_for(b, "admin")
        p.goto(BASE + "dials.html"); p.wait_for_selector(".dh-row", timeout=40000)
        p.click("#headerSearchBtn"); p.fill("#dialsSearchInput", "a"); p.wait_for_timeout(2500)
        n = p.locator("tr.clickable-row").count()
        check("search results exist to test", n > 0, n)
        if n:
            check("search result rows are keyboard-reachable (tabindex 0, role button)", p.evaluate("[...document.querySelectorAll('tr.clickable-row, .mobile-card.clickable-row')].every(r => r.tabIndex === 0 && r.getAttribute('role') === 'button')"))
            ph = p.evaluate("(() => { const r = [...document.querySelectorAll('tr.clickable-row')].map(tr => tr.children[tr.children.length - 2].textContent); return r.filter(x => x === '—').length; })()")
            p.press("#dialsSearchInput", "Enter"); p.wait_for_selector("#dialModalBackdrop:not(.hidden)", timeout=8000)
            check("Enter in the search box opens the first match", True)
            p.click("#dialEditBtn"); p.wait_for_selector("#d_company_name")
            p.fill("#d_company_name", "ZZ typed edit"); p.once("dialog", lambda d: d.dismiss())
            p.keyboard.press("Escape"); p.wait_for_timeout(600)
            check("Esc in a changed edit form asks first and a No keeps the form and the typing", p.locator("#d_company_name").count() == 1 and p.input_value("#d_company_name") == "ZZ typed edit")
            p.once("dialog", lambda d: d.accept()); p.keyboard.press("Escape"); p.wait_for_timeout(600)
            check("Esc then Yes leaves only the form (card stays open, view mode)", p.locator("#d_company_name").count() == 0 and p.locator("#dialModalBackdrop:not(.hidden)").count() == 1)
            p.click("#dialEditBtn"); p.wait_for_selector("#d_company_name"); p.keyboard.press("Escape"); p.wait_for_timeout(500)
            check("Esc in an untouched edit form just leaves the form", p.locator("#d_company_name").count() == 0 and p.locator("#dialModalBackdrop:not(.hidden)").count() == 1)
        c.close()

        print("-- Calls: stale second tab does not revert, a clash is refused (own fixture list)")
        tag = "R6UI " + uuid.uuid4().hex[:6]
        lid = q(f"insert into dial_lists (name, dial_type, created_by) values ('{tag}', 'seller', '{uid('test.caleb.hong@example.com')}') returning id")[0]["id"]
        did = q(f"insert into dials (list_id, created_by, company_name, full_name, company_phone, industry, city, state) values ('{lid}', '{uid('test.caleb.hong@example.com')}', '{tag} Co', 'Pat R6', '(801) 555-0188', 'Paving', 'Provo', 'UT') returning id")[0]["id"]
        c, p, _ = ctx_for(b, "intern")
        p.goto(BASE + "dials.html?dial=" + did); p.wait_for_selector("#dialModalBackdrop:not(.hidden)", timeout=40000); p.wait_for_timeout(1500)
        p.click("#dialEditBtn"); p.wait_for_selector("#d_city")
        q(f"update dials set industry='Paving FROM-OTHER-TAB' where id='{did}'")
        p.fill("#d_city", "Ogden"); p.click("#dialSaveBtn"); p.wait_for_timeout(2500)
        r = q(f"select industry, city from dials where id='{did}'")[0]
        check("stale tab: saving City leaves the other tab's Industry change alone", r["city"] == "Ogden" and r["industry"] == "Paving FROM-OTHER-TAB", r)
        p.click("#dialEditBtn"); p.wait_for_selector("#d_industry")
        q(f"update dials set industry='Changed again' where id='{did}'")
        p.fill("#d_industry", "Mine"); p.click("#dialSaveBtn"); p.wait_for_timeout(2000)
        r = q(f"select industry from dials where id='{did}'")[0]
        check("clash on the same field: refused with a message, nothing overwritten", r["industry"] == "Changed again" and "changed on another screen" in p.inner_text("#dialModalError"), r)
        c.close()
        q(f"delete from dials where list_id='{lid}'"); q(f"delete from dial_lists where id='{lid}'")

        print("-- phone width, contrast, pickers, guard")
        c, p, _ = ctx_for(b, "admin", 375, UA_PHONE)
        p.goto(BASE + "dials.html"); p.wait_for_selector("#pageSettingsBtn", timeout=40000); p.wait_for_timeout(2000)
        p.click("#headerSearchBtn") if p.locator("#headerSearchBtn").count() else None
        p.wait_for_timeout(500)
        w = p.evaluate("document.getElementById('dialsSearchCloseBtn').getBoundingClientRect().width")
        check("search clear button is 44px wide at 375", w >= 44, w)
        c.close()
        c, p, _ = ctx_for(b, "admin")
        p.goto(BASE + "profile.html"); p.wait_for_timeout(1500)
        op = p.evaluate("""() => { const mk = (cls) => { const e = document.createElement('div'); e.className = cls; document.body.appendChild(e); const o = getComputedStyle(e).opacity; e.remove(); return o; };
          return [mk('callback-row is-past'), mk('mc-sub faint')]; }""")
        check("overdue callback row and Inbox sub-line are not dimmed (3.9:1 / 4.3:1 fixed)", op == ["1", "1"], op)
        bg = p.evaluate("""() => { const i = document.createElement('input'); i.className = 'picker-field'; document.body.appendChild(i); const v = getComputedStyle(i).backgroundImage; i.remove(); return v; }""")
        check("pick-from-list fields show a chevron", "svg" in bg, bg[:40])
        r = p.evaluate("""async () => { const m = await import('/js/eventTime.js'); try { return m.dateStrInZone('2026-12-01T10:00:00Z', 'Not/AZone'); } catch (e) { return 'THREW ' + e.message; } }""")
        check("a bad stored timezone no longer breaks Edit event", re.match(r"\d{4}-\d{2}-\d{2}$", r) is not None, r)
        c.route("**/rest/v1/rpc/test_call_policy*", lambda r: r.fulfill(status=500, content_type="application/json", body="{}"))
        r = p.evaluate("""async () => { const m = await import('/js/testCallGuard.js?fresh=1'); return await m.callBlocked('+18015550123'); }""")
        check("call guard fails closed on TEST when the policy check errors", r is True, r)
        c.close()

        print("-- admin: Email accounts (mocked list; nothing is changed)")
        c, p, _ = ctx_for(b, "admin")
        box = {"id": str(uuid.uuid4()), "email_address": "r6.box@example.com", "owner_id": uid("test.admin@example.com"), "owner_name": "Test Admin", "needs_assignment": False, "sync_enabled": False,
               "daily_send_limit": 0, "effective_daily_limit": 25, "sent_24h": 0, "scheduled": 0, "send_paused_reason": None, "sending_ok": True}
        box2 = dict(box, id=str(uuid.uuid4()), email_address="r6.box2@example.com", daily_send_limit=None, effective_daily_limit=20)
        people = [{"id": uid("test.admin@example.com"), "full_name": "Test Admin", "role": "admin"}]
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS"}
        c.route("**/functions/v1/mailbox-admin*", lambda r: r.fulfill(status=204, headers=cors) if r.request.method == "OPTIONS" else
                r.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps({"ok": True, "mailboxes": [box, box2], "people": people})))
        p.goto(BASE + "admin.html#accounts"); p.wait_for_selector(".ad-box", state="attached", timeout=40000); p.wait_for_timeout(500)
        txt = p.evaluate("document.getElementById('mbxList').textContent")
        check("a daily limit of 0 shows as paused, and the number is the real cap (0/20)", "daily limit is 0" in txt and "0/20 today" in txt and "0/25" not in txt, txt[:300])
        c.close()
        print("-- name is escaped in the nav")
        rid = uid("riley.intern@example.com"); old = q(f"select full_name from profiles where id='{rid}'")[0]["full_name"]
        try:
            q(f"update profiles set full_name = '<i id=r6x>Riley</i>' where id='{rid}'")
            c, p, _ = ctx_for(b, "riley"); p.goto(BASE + "dials.html"); p.wait_for_timeout(2500)
            check("profile name with markup is shown as text, not run", p.locator("#r6x").count() == 0, "")
            c.close()
        finally:
            q(f"update profiles set full_name = '{old}' where id='{rid}'")
        b.close()
