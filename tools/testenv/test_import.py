"""Import flow end to end on the TEST project (real Chrome, http://localhost:5173): odd CSVs -> preview/mapping -> duplicates ->
assign-to -> list callable. All data is prefixed TEST-IMPORT and removed at the end. Run: python3 test_import.py"""
import os, re, sys, time, json, tempfile
from playwright.sync_api import sync_playwright
import sb
from browser_regress import BASE, login, new_page
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))
NOISE = ("Auto-sync failed", "Failed to send a request to the Edge Function", "net::ERR_ABORTED")
TMP = tempfile.mkdtemp(prefix="ti_"); SHOT = os.environ.get("IMPORT_SHOTS")
STD = "Full name,Company name,City,State,Email,Mobile number,Company number,LinkedIn,Website,Industry sector,Summary"

def w(name, text, enc="utf-8"):
    p = os.path.join(TMP, name); open(p, "wb").write(text.encode(enc)); return p

def big_csv(n=2100):
    rows = [STD]
    for i in range(n):
        email = f"owner{i}@testimport{i}.com" if i % 5 else ("info@" if i % 10 == 0 else "") + (f"testimport{i}.com" if i % 10 == 0 else "")
        email = email if "@" in email else ""
        rows.append(f'Owner {i},"TEST-IMPORT Co {i}, LLC",Provo,UT,{email},(999) 555-{i:04d},,https://linkedin.com/in/o{i},https://testimport{i}.com,Plumbing,"Does plumbing, ""fast"""')
    rows.append(rows[5]); rows.append(rows[6])                        # 2 in-file repeats
    rows.append(",,,,,,,,,,")                                         # blank row
    return "﻿" + "\r\n".join(rows) + "\r\n"

def run():
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
        # ---- intern must not see Import
        ctx = b.new_context(viewport={"width": 1100, "height": 800}); errs = []; p = new_page(ctx, errs); login(p, "intern"); p.goto(BASE + "dials.html"); p.wait_for_timeout(1500)
        check("intern: no Import menu item", not p.is_visible("#menuImportBtn") and p.eval_on_selector("#menuImportBtn", "e=>e.classList.contains('hidden')") if p.query_selector("#menuImportBtn") else True)
        ctx.close()

        ctx = b.new_context(viewport={"width": 1100, "height": 900}); errs = []; p = new_page(ctx, errs); login(p, "admin")
        p.goto(BASE + "dials.html"); p.wait_for_timeout(2000)
        def open_modal():
            p.click("#pageMenuToggle"); p.click("#menuImportBtn"); p.wait_for_selector("#importDialsModal:not(.hidden)")
        def pick(*paths): p.set_input_files("#importDialsFileInput", list(paths)); 
        # ---- errors: empty file, header-only, not csv
        open_modal(); pick(w("TEST-IMPORT-empty.csv", "")); p.wait_for_selector(".iw-err", timeout=5000)
        check("empty file: clear error, Import disabled", "no data rows" in p.inner_text(".iw-err") and p.is_disabled("#importDialsImportBtn"), p.inner_text(".iw"))
        pick(w("TEST-IMPORT-hdr.csv", STD + "\n")); p.wait_for_selector(".iw-err")
        check("header-only file: error", "no data rows" in p.inner_text(".iw-err"))
        pick(w("notes.pdf", "x")); p.wait_for_timeout(400)
        check("non-CSV: message and nothing to import", "not CSVs" in p.inner_text("#importDialsFileName") and p.is_disabled("#importDialsImportBtn"))
        # ---- big realistic file
        big = w("TEST-IMPORT-big.csv", big_csv()); t0 = time.time(); pick(big); p.wait_for_selector(".iw-chips", timeout=20000)
        txt = p.inner_text(".iw")
        check("2,100-row file previews in <5s", time.time() - t0 < 5, time.time() - t0)
        check("preview counts rows (2,102 incl. repeats; blank dropped)", "2,102 rows" in txt, txt[:300])
        check("in-file repeats flagged", "2 rows repeat" in txt, txt[:600])
        check("import button shows lead count", p.inner_text("#importDialsImportBtn").strip() == "Import 2,100 leads", p.inner_text("#importDialsImportBtn"))
        p.wait_for_function("!document.querySelector('.iw-dup-line .iw-muted')?.textContent.includes('Checking')", timeout=15000)
        if SHOT: p.screenshot(path=f"{SHOT}/desk_preview.png")
        # mobile view of same modal
        p.set_viewport_size({"width": 375, "height": 800}); p.wait_for_timeout(300)
        sw = p.evaluate("document.documentElement.scrollWidth"); check("375px: no sideways scroll with preview open", sw <= 376, sw)
        if SHOT: p.screenshot(path=f"{SHOT}/mob_preview.png")
        p.click(".iw-link[data-act=togglemap]"); p.wait_for_timeout(200)
        sw = p.evaluate("document.querySelector('#importDialsModal .modal').scrollWidth - document.querySelector('#importDialsModal .modal').clientWidth"); check("375px: mapping grid fits", sw <= 1, sw)
        if SHOT: p.screenshot(path=f"{SHOT}/mob_mapping.png", full_page=False)
        p.set_viewport_size({"width": 1100, "height": 900}); p.wait_for_timeout(200)
        # assign to Caleb Hong (intern)
        p.wait_for_function("document.querySelectorAll('#iwAssign option').length>2")
        p.select_option("#iwAssign", label=re.compile("") if False else p.eval_on_selector_all("#iwAssign option", "o=>o.find(x=>x.textContent.startsWith('Caleb Hong')).textContent"))
        # mandate required
        p.click("#importDialsImportBtn"); p.wait_for_timeout(300)
        check("mandate required before import", "Pick what this list is for" in p.inner_text("#importDialsError"))
        p.click(".cr-mandate-btn[data-m=ma]")
        t1 = time.time(); p.click("#importDialsImportBtn"); p.wait_for_selector("#importDialsResult", timeout=180000); took = time.time() - t1
        res = p.inner_text("#importDialsResult"); print("  result:", res.replace("\n", " | ")[:400]); print(f"  import->done {took:.1f}s", p.evaluate("window.__lastImportTimings"))
        check("result says 2,100 leads added, sent to Caleb", "2,100 leads added" in res and "sent to Caleb Hong" in res, res)
        check("import of 2,100 rows done in <60s", took < 60, took)
        if SHOT: p.screenshot(path=f"{SHOT}/desk_result.png")
        rows = sb.test_sql("select l.id, l.name, l.mandate, p.full_name owner, (select count(*) from dials d where d.list_id=l.id) n, (select count(*) from dials d where d.list_id=l.id and d.created_by=l.created_by) own, (select count(*) from dials d where d.list_id=l.id and d.sequence='email5') em, (select count(*) from dials d where d.list_id=l.id and d.sequence='backup') bk from dial_lists l join profiles p on p.id=l.created_by where l.name like 'TEST-IMPORT-big%'")
        r = rows[0] if rows else {}
        check("one list, 2,100 dials, owned by Caleb Hong, dials follow", len(rows) == 1 and r["n"] == 2100 and r["owner"] == "Caleb Hong" and r["own"] == 2100, rows)
        check("sequences classified (email5 + backup = all)", r and r["em"] + r["bk"] == 2100 and r["em"] > 1000, rows)
        notif = sb.test_sql(f"select count(*) c from notifications where type='dial_transfer' and message like '%sent you a list%' and created_at > now() - interval '5 minutes' and user_id=(select id from profiles where full_name='Caleb Hong' limit 1)")
        check("assignee notified (dial_transfer)", notif and notif[0]["c"] >= 1, notif)
        p.click("#importDialsCancelBtn"); p.wait_for_timeout(500)
        check("modal closes on Done", not p.is_visible("#importDialsModal"))
        # ---- second import: overlaps first -> detected against existing leads; transfer still works
        ov = ["Full name,Company name,City,State,Email,Mobile number"]
        for i in range(0, 40): ov.append(f"Owner {i},TEST-IMPORT Co {i} LLC,Provo,UT,owner{i}@testimport{i}.com,(999) 555-{i:04d}")
        for i in range(5000, 5010): ov.append(f"New {i},TEST-IMPORT New {i},Orem,UT,new{i}@testimportnew{i}.com,(999) 556-{i:04d}")
        open_modal(); pick(w("TEST-IMPORT-overlap.csv", "\r\n".join(ov)))
        p.wait_for_function("document.querySelector('.iw-dup-line') && !document.querySelector('.iw-dup-line').textContent.includes('Checking')", timeout=15000)
        txt = p.inner_text(".iw"); print("  overlap:", txt[:350].replace("\n", " | "))
        m = re.search(r"([\d,]+) leads? (?:are|is) already in the system", txt)
        check("overlap: existing leads detected, names the other list + owner", m and int(m.group(1).replace(",", "")) >= 32 and "TEST-IMPORT-big" in txt and "Caleb Hong" in txt, txt[:400])
        n_skip = int(m.group(1).replace(",", "")) if m else 0
        check("overlap: names the EXISTING lead, not just the incoming row", re.search(r"matches TEST-IMPORT Co \d+,? LLC, already in", txt) is not None, txt[:500])
        check("overlap: preview marks skipped duplicate rows", "already in system (skipped)" in p.inner_text(".iw-table"), p.inner_text(".iw-table")[:200])
        check("overlap: result chips read as one story (no 'after you pressed Import' timing)", "Of 50 rows" in txt, txt[:300])
        check("overlap: default skips them (to import = new rows only)", p.inner_text("#importDialsImportBtn").strip() == f"Import {50 - n_skip} leads", p.inner_text("#importDialsImportBtn"))
        p.check("input[value=keep]"); p.wait_for_timeout(200)
        check("overlap: 'Import everything' keeps all 50", p.inner_text("#importDialsImportBtn").strip() == "Import 50 leads")
        p.check("input[value=skip_all]")
        p.click(".cr-mandate-btn[data-m=ma]"); p.click("#importDialsImportBtn"); p.wait_for_selector("#importDialsResult", timeout=60000)
        res = p.inner_text("#importDialsResult"); check("overlap import result mentions skipped existing", "already in the system" in res, res)
        p.click("#importDialsCancelBtn")
        # ---- transfer of the admin-owned list still works (upload-then-transfer)
        lid = sb.test_sql("select id from dial_lists where name like 'TEST-IMPORT-overlap%'")[0]["id"]
        p.goto(BASE + "dials.html"); p.wait_for_timeout(1500)
        out = p.evaluate("""async (lid) => { const m = await import('/js/supabaseClient.js'); const u = (await m.supabase.from('profiles').select('id').eq('full_name','Casey Intern').single()).data;
            const r = await m.supabase.rpc('transfer_dial_list', {p_list_id: lid, p_new_owner: u.id}); return {err: r.error && r.error.message}; }""", lid)
        owner = sb.test_sql(f"select p.full_name o, (select count(*) from dials d where d.list_id=l.id and d.created_by=l.created_by) own from dial_lists l join profiles p on p.id=l.created_by where l.id='{lid}'")[0]
        check("transfer after import still works", not out["err"] and owner["o"] == "Casey Intern" and owner["own"] > 0, (out, owner))
        # ---- odd formats: semicolons, tabs, Windows-1252, no header names
        odd = w("TEST-IMPORT-semi.csv", "Compny Name;E-mail;Mobie number;Stat\nTEST-IMPORT Semi A;a@semi-a.com;801-555-7001;UT\nTEST-IMPORT Semi B;;801-555-7002;texas\n")
        open_modal(); pick(odd); p.wait_for_selector(".iw-chips"); txt = p.inner_text(".iw")
        check("semicolon file + typo headers: parsed and previewed", "2 rows" in txt and "matched despite spelling" in (p.inner_html(".iw") if p.query_selector(".iw-cols") else "matched despite spelling"), txt[:200])
        p.click(".iw-link[data-act=togglemap]"); html = p.inner_html(".iw-cols")
        check("typo header 'Compny Name' mapped to Company name", re.search(r'Compny Name.*?selected[^>]*>Company name', html, re.S) is not None)
        p.click("#importDialsCancelBtn")
        # ---- mapping fix in the UI changes the result
        nm = w("TEST-IMPORT-nohdr.csv", "Col A,Col B,Col C\nTEST-IMPORT Zed,z1@zed.com,801-555-7100\nTEST-IMPORT Yan,y1@yan.com,801-555-7101\nTEST-IMPORT Xi,x1@xi.com,801-555-7102\n")
        open_modal(); pick(nm); p.wait_for_selector(".iw-chips"); txt = p.inner_text(".iw")
        check("unnamed columns: email + phone guessed from values; company unmapped warns", "No name or company" in txt, txt[:300])
        p.click(".iw-link[data-act=togglemap]"); p.select_option("select[data-c='0']", "company_name"); p.wait_for_timeout(300)
        check("manual fix clears the warning", "No name or company" not in p.inner_text(".iw"))
        p.click(".cr-mandate-btn[data-m=ma]"); p.click("#importDialsImportBtn"); p.wait_for_selector("#importDialsResult", timeout=60000)
        d = sb.test_sql("select company_name, email, mobile_phone from dials where company_name like 'TEST-IMPORT Zed'")
        check("fixed mapping lands in the right fields", d and d[0]["email"] == "z1@zed.com" and d[0]["mobile_phone"] == "801-555-7100", d)
        p.click("#importDialsCancelBtn")
        # ---- an invalid email is saved blank, never verbatim
        be = w("TEST-IMPORT-bademail.csv", "Company name,Email,Mobile number\nTEST-IMPORT Bad,n/a,801-555-7103\nTEST-IMPORT Good,good@testimportgood.com,801-555-7104\n")
        open_modal(); pick(be); p.wait_for_selector(".iw-chips"); txt = p.inner_text(".iw")
        check("invalid email chip says it is left blank", "1 invalid emails (left blank)" in txt, txt[:300])
        p.click(".cr-mandate-btn[data-m=ma]"); p.click("#importDialsImportBtn"); p.wait_for_selector("#importDialsResult", timeout=60000)
        bd = sb.test_sql("select company_name, email from dials where company_name like 'TEST-IMPORT Bad' or company_name like 'TEST-IMPORT Good'")
        check("invalid email ('n/a') is saved blank, the good one kept", {d["company_name"]: d["email"] for d in bd} == {"TEST-IMPORT Bad": None, "TEST-IMPORT Good": "good@testimportgood.com"}, bd)
        res2 = p.inner_text("#importDialsResult"); check("import result has no odd timing phrase", "after you pressed" not in res2 and "Ready to call now" in res2, res2)
        p.click("#importDialsCancelBtn")
        bad = [e for e in errs if not any(n in e for n in NOISE)]
        check("no console/page errors", not bad, bad[:3])
        ctx.close(); b.close()

def cleanup():
    sb.test_sql("delete from dial_lists where name like 'TEST-IMPORT%'")

if __name__ == "__main__":
    try: run()
    finally: cleanup()
    print(f"{sum(results)}/{len(results)} passed"); sys.exit(0 if all(results) else 1)
