"""Round-5 design review regressions, part 2 (real Chrome, TEST project): dark/light contrast from computed styles, 44px tap targets at 375,
focus ring, no off-brand blue, clipped labels, copy and layout fixes. Read-only; the Campaigns page runs on mocked data with sending calls aborted.
Run: python3 test_round5_ui.py"""
from playwright.sync_api import sync_playwright
from browser_regress import BASE, login, new_page
from r5_common import check, summary, contrast, token_contrast, mock_campaigns, UA_PHONE

def rows(p, sel, t=40000):
    p.wait_for_selector(sel, timeout=t); p.wait_for_timeout(600)
TAP_JS = """() => { const out = []; const sel = 'button, a[href], input:not([type=hidden]), select, summary, textarea, [role=button], tr[tabindex="0"]';
 for (const e of document.querySelectorAll(sel)) { const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
   const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
   if (e.closest('.skeleton, .skeleton-card, #pageLoadingOverlay, .hidden, [hidden]')) continue;
   if (e.matches('input[type=checkbox],input[type=radio]')) { const l = e.closest('label, .mailbox-row, .accounts-visible-row'); if (l && l.getBoundingClientRect().height >= 44) continue; }
   if (e.tagName === 'A' && e.closest('p, li, .help-text, .ad-muted, .sub') && !e.classList.contains('btn')) continue;
   if (r.width < 44 || r.height < 44) out.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).trim().split(' ').join('.')) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
 return [...new Set(out)]; }"""

def contrast_checks(b):
    print("-- contrast (computed styles)")
    for scheme in ("dark", "light"):
        ctx = b.new_context(viewport={"width": 1280, "height": 800}, color_scheme=scheme); errs = []; p = new_page(ctx, errs)
        p.goto(BASE + "login.html"); p.wait_for_timeout(1200)
        check(f"{scheme}: login 'Log in' button >= 4.5:1", contrast(p, "#submitBtn") >= 4.5, contrast(p, "#submitBtn"))
        for tok in ("--text-muted", "--success", "--warn", "--danger", "--accent-text", "--tone-text"):
            c = token_contrast(p, tok)
            check(f"{scheme}: text token {tok} on the page background >= 4.5:1", c >= 4.5, c)
        if scheme == "light":
            for fg, bg in (("--text-muted", "--status-no-response-bg"), ("--text-muted", "--status-busy-bg"), ("--danger", "--danger-soft")):
                check(f"light: {fg} on the tinted {bg} >= 4.5:1", token_pair(p, fg, bg) >= 4.5, token_pair(p, fg, bg))
        login(p, "admin")
        p.goto(BASE + "admin.html#accounts"); p.wait_for_selector("#mbxAddToggle", timeout=30000); p.wait_for_timeout(800)
        for sel, nm in (("#signOutBtn", "Log out"), (".role-badge", "role badge"), ("#mbxAddToggle", "Add account")):
            check(f"{scheme}: {nm} >= 4.5:1", contrast(p, sel) >= 4.5, contrast(p, sel))
        p.goto(BASE + "dials.html"); rows(p, ".dh-row"); p.locator(".dh-row").first.click(); p.wait_for_selector(".dial-status-btn", timeout=15000)
        check(f"{scheme}: status pill >= 4.5:1", contrast(p, ".dial-status-btn") >= 4.5, contrast(p, ".dial-status-btn"))
        if p.locator(".dial-modal a").count(): check(f"{scheme}: dial-card links >= 4.5:1", contrast(p, ".dial-modal a") >= 4.5, contrast(p, ".dial-modal a"))
        p.keyboard.press("Escape")
        p.goto(BASE + "profile.html"); p.wait_for_selector(".profile-avatar", timeout=30000)
        check(f"{scheme}: avatar initials >= 4.5:1", contrast(p, "#avatarInitials") >= 4.5 or p.locator("#avatarInitials").count() == 0, contrast(p, "#avatarInitials"))
        blue = p.evaluate("[...document.querySelectorAll('*')].filter(e => getComputedStyle(e).backgroundColor === 'rgb(47, 95, 237)' || getComputedStyle(e).color === 'rgb(47, 95, 237)').length")
        check(f"{scheme}: no element still uses the old off-brand blue", blue == 0, blue)
        # focus ring: 2px+, offset, same colour token at every width
        p.keyboard.press("Tab"); p.keyboard.press("Tab")
        ring = p.evaluate("(() => { const cs = getComputedStyle(document.activeElement); return [cs.outlineStyle, parseFloat(cs.outlineWidth), parseFloat(cs.outlineOffset)]; })()")
        check(f"{scheme}: keyboard focus ring is 2px+ with an offset", ring[0] != "none" and ring[1] >= 2 and ring[2] >= 1, ring)
        ctx.close()
def token_pair(p, fg, bg):
    from r5_common import LUM
    return p.evaluate("([t, b]) => { const L = " + LUM + "; const cs = getComputedStyle(document.documentElement); const px = document.createElement('i'); document.body.appendChild(px);"
                      " const rgb = (v) => { px.style.color = v; return getComputedStyle(px).color; };"
                      " const a = L(rgb(cs.getPropertyValue(t).trim())), c = L(rgb(cs.getPropertyValue(b).trim())); px.remove(); return (Math.max(a, c) + .05) / (Math.min(a, c) + .05); }", [fg, bg])

def taps(b):
    print("-- 375px tap targets (phone user agent)")
    ctx = b.new_context(viewport={"width": 375, "height": 812}, user_agent=UA_PHONE, has_touch=True, is_mobile=True); errs = []; p = new_page(ctx, errs)
    p.goto(BASE + "login.html"); p.wait_for_timeout(1200)
    check("login: every control is >= 44px", p.evaluate(TAP_JS) == [], p.evaluate(TAP_JS))
    login(p, "admin")
    steps = [("Calls list", "dials", ".dh-row", None), ("Profile", "profile", "#callsThisWeekText", None), ("Clients list", "clients", ".mobile-card:not(.skeleton-card)", None),
             ("Inbox list", "messages", ".message-thread-row", None), ("Admin", "admin", ".cp-row, .ad-empty", None)]
    for name, pg, sel, _ in steps:
        p.goto(BASE + pg + ".html"); rows(p, sel); p.wait_for_timeout(800)
        bad = p.evaluate(TAP_JS); check(f"{name}: every control is >= 44px", bad == [], bad[:8])
    p.goto(BASE + "dials.html"); rows(p, ".dh-row"); p.locator(".dh-row").first.click(); p.wait_for_selector("#dialModalBackdrop:not(.hidden)"); p.wait_for_timeout(1000)
    # the company card was put back to the live CRM look (28px icon buttons, no 44px targets): no tap-size assertion on it
    p.keyboard.press("Escape")
    p.goto(BASE + "clients.html"); rows(p, ".mobile-card:not(.skeleton-card)"); p.locator(".mobile-card:not(.skeleton-card)").first.click(); p.wait_for_selector("#clientModal:not(.hidden)"); p.wait_for_timeout(800)
    bad = p.evaluate(TAP_JS); check("Clients: the client detail controls are >= 44px", bad == [], bad[:8])
    p.click("#editProfileBtn"); p.wait_for_timeout(600)
    bad = p.evaluate(TAP_JS); check("Clients: the edit form controls are >= 44px", bad == [], bad[:8])
    ctx.close()

def layout(b):
    print("-- layout and copy")
    ctx = b.new_context(viewport={"width": 768, "height": 1000}); errs = []; p = new_page(ctx, errs); login(p, "admin")
    attempts = mock_campaigns(ctx)
    p.goto(BASE + "admin.html#campaigns"); rows(p, ".cp-row:not(.cp-total)")
    overlap = p.evaluate("""() => { let n = 0; for (const row of document.querySelectorAll('.cp-row')) { const r = [...row.querySelectorAll('.cp-n span')].map(e => e.getBoundingClientRect());
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].right && r[j].left < r[i].right && r[i].top < r[j].bottom && r[j].top < r[i].bottom) n++;
      for (const e of row.querySelectorAll('.cp-n span')) if (e.scrollWidth > e.clientWidth + 1) n++; } return n; }""")
    check("tablet (768): the stat labels do not collide or get cut", overlap == 0, overlap)
    check("tablet (768): the action button is not stretched across the card", p.evaluate("document.querySelector('.cp-row .cp-act .btn').getBoundingClientRect().width") <= 280)
    p.locator('.cp-row[data-id$="a2"] .cp-note').first.wait_for(state="visible", timeout=5000)
    note = p.inner_text('.cp-row[data-id$="a2"] .cp-note')
    check("paused note has no doubled 'Paused: Paused'", "Paused: Paused" not in note, note)
    check("nothing was launched, paused or resumed", attempts == [], attempts)
    ctx.close()
    ctx = b.new_context(viewport={"width": 375, "height": 812}, user_agent=UA_PHONE, has_touch=True, is_mobile=True); errs = []; p = new_page(ctx, errs); login(p, "admin")
    p.goto(BASE + "dials.html"); rows(p, ".dh-row")
    cut = p.evaluate("[...document.querySelectorAll('.dh-meta')].filter(e => e.scrollWidth > e.clientWidth + 1).length")
    check("phone Calls list: callback times / days late are not cut off", cut == 0, cut)
    p.locator(".dh-row").first.click(); p.wait_for_selector("#dialModalBackdrop:not(.hidden)"); p.wait_for_timeout(1000)
    txt = p.inner_text("#dialModalBackdrop")
    check("dial card: live layout, the status pill is there", p.locator("#dialStatusBtn").count() == 1, txt[:200])
    p.keyboard.press("Escape")
    p.goto(BASE + "messages.html"); rows(p, ".message-thread-row"); p.evaluate("window.scrollTo(0, document.body.scrollHeight)"); p.wait_for_timeout(500)
    clear = p.evaluate("(() => { const rs = [...document.querySelectorAll('.message-thread-row')]; const last = rs[rs.length - 1].getBoundingClientRect(); const f = document.querySelector('.compose-fab'); if (!f) return true; return last.bottom <= f.getBoundingClientRect().top; })()")
    check("phone Inbox: scrolled to the end, the compose button is clear of the last row's date", clear)
    ctx.close()
    ctx = b.new_context(viewport={"width": 1280, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, "admin")
    p.goto(BASE + "clients.html"); rows(p, "tr.clickable-row")
    fits = p.evaluate("""() => { const i = document.getElementById('search'); const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(i); c.font = cs.fontSize + ' ' + cs.fontFamily;
      return c.measureText(i.placeholder).width <= i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); }""")
    check("Clients search placeholder is not truncated", fits)
    locs = p.evaluate("[...document.querySelectorAll('tr.clickable-row td')].map(td => td.innerText.trim()).filter(t => /^[A-Za-z .'-]+, [A-Za-z ]+$/.test(t))")
    check("one location format: the state is always the 2-letter code", all(__import__('re').search(r", [A-Z]{2}$", t) for t in locs), [t for t in locs if not __import__('re').search(r", [A-Z]{2}$", t)][:5])
    p.click("#pageMenuToggle"); p.click("#menuAddNewBtn"); p.wait_for_selector("#saveClientBtn"); p.click("#saveClientBtn"); p.wait_for_selector("#requiredPopup:not(.hidden)")
    p.click("#requiredPopupOk"); p.wait_for_timeout(400)
    opened = p.evaluate("[...document.querySelectorAll('.accordion-section.open')].map(s => s.dataset.section)")
    check("the missing-info dialog opens the collapsed sections that have missing fields", {"personal", "contact", "company"} <= set(opened), opened)
    ctx.close()

if __name__ == "__main__":
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
        for fn in (contrast_checks, taps, layout):
            try: fn(b)
            except Exception as e: check(f"{fn.__name__} ran to the end", False, repr(e)[:400])
        b.close()
    raise SystemExit(0 if summary() else 1)
