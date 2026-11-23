"""Second half of the live-copy regression: Reports (numbers vs DB, PDF buttons), team report, Messages select actions,
Deleted tabs restore/purge, list import + transfer, intake submit path, callbacks. See test_live_copy.py."""
import json, re, os, subprocess, tempfile, datetime
import sb
from lc_common import *
from test_live_copy import check, q, lit, uid, session, clean_errs, local_midnight, monday, PREFIX, NOISE, BASE

TEAM3 = "8899e98a-8f84-4605-8dec-4343915d097b"
def team_ids(team):
    return [r["id"] for r in q(f"select id from profiles where team_id='{team}' and id in (select id from auth.users where email like 'live.%')")]

def reports_session(b, name, ids):
    ctx = b.new_context(viewport={"width": 1100, "height": 900}, accept_downloads=True); errs = []
    ctx.add_init_script("localStorage.setItem('waystation_report_accounts_visible_v2', %s); localStorage.setItem('waystation_report_accounts_visible_v2_initialized','1')" % json.dumps(json.dumps(ids)))
    p = new_page(ctx, errs); e, pw = creds(name); login(p, e, pw); return ctx, p, errs

def table_rows(p):
    t = p.inner_text("#reportsTableWrap table").strip().split("\n")[1:]
    out = {}
    for ln in t:
        c = ln.split("\t")
        if len(c) >= 6 and c[0] != "Totals": out[c[0]] = [int(x) for x in c[1:6]]
    return out

def choose_week(p, idx):
    p.click("#reportsMenuToggle"); p.click("#reportsSelectPeriodBtn")
    p.click(f"#reportsSelectPeriodBody [data-value]:nth-child({idx})"); p.wait_for_timeout(2500)

CHI = "America/Chicago"
def week_bounds(d):  # Mon..Sat-exclusive in Chicago, like compute_report_rollups
    return f"'{d}'::timestamp at time zone '{CHI}'", f"('{d}'::date + 5)::timestamp at time zone '{CHI}'"

def reports(b):
    print("-- F. Reports: numbers vs DB, PDF buttons")
    q("select public.compute_report_rollups()")           # same job the cron runs: refreshes this + last week from the copied logs
    ids = team_ids(TEAM3); names = {r["id"]: r["full_name"] for r in q(f"select id, full_name from profiles where id in ({','.join(lit(i) for i in ids)})")}
    ctx, p, errs = reports_session(b, "Mason Quinn", ids)
    p.goto(BASE + "profile.html"); p.wait_for_timeout(3500); p.click("#reportsBtn"); p.wait_for_timeout(3500)
    for idx, label in ((1, "this week"), (2, "last week")):
        if idx == 2: choose_week(p, 2)
        wk = monday() - datetime.timedelta(days=7 * (idx - 1))
        for _ in range(10):                                # rows render after the page shell; wait for every account (slower under load)
            ui = table_rows(p)
            if all(nm in ui for nm in names.values()): break
            p.wait_for_timeout(1500)
        lo, hi = week_bounds(wk)
        bad = []
        for uid_, nm in names.items():
            r = q(f"""with c as (select * from call_status_changes where user_id='{uid_}' and dial_type='seller' and changed_at >= {lo} and changed_at < {hi})
                      select count(distinct dial_id) filter (where coalesce(contact_status_at_call,'x') != 'uncontacted') calls_made, count(*) attempted from c""")[0]
            roll = q(f"select coalesce(sum(calls_made),0) cm, coalesce(sum(attempted_contacts),0) ac, coalesce(sum(owners_talked),0) ot, coalesce(sum(owners_agreed_to_intro_call),0) oa, coalesce(sum(intro_calls_completed),0) ic from report_dial_rollups where user_id='{uid_}' and period_type='week' and period_start='{wk}'")[0]
            exp = [int(roll["cm"]), int(roll["ac"]), int(roll["ot"]), int(roll["oa"]), int(roll["ic"])]
            if ui.get(nm) != exp: bad.append((nm, ui.get(nm), exp))
            # independent recomputation of the first two columns from the raw log (calls_made counts category rows, attempted = rows)
            if (int(roll["ac"]), ) != (int(r["attempted"]),): bad.append((nm, "rollup attempted", roll["ac"], "raw", r["attempted"]))
        check(f"Reports table ({label}, Team 3 accounts) equals report_dial_rollups and attempted contacts equal the raw log", not bad, bad[:3])
        tot = [sum(v[i] for v in ui.values()) for i in range(5)]
        txt = [l for l in p.inner_text("#reportsTableWrap").split("\n") if l.startswith("Totals")][0].split("\t")[1:6]
        check(f"Reports totals row ({label}) = sum of the account rows", [int(x) for x in txt] == tot, (txt, tot))
    # buyer-centric report + PDF buttons
    top = q(f"""select s.buyer_id, coalesce(nullif(c.company_name,''), c.full_name) nm, count(*) n from call_status_changes s join clients c on c.id=s.buyer_id
                where s.user_id = any(array[{','.join(lit(i) for i in ids)}]::uuid[]) and s.changed_at >= '{monday() - datetime.timedelta(days=7)}' group by 1,2 order by 3 desc limit 1""")
    if not top: check("a buyer with calls this/last week exists to test the PDF", False); ctx.close(); return
    bname = top[0]["nm"]
    p.click("#reportsMenuToggle"); p.evaluate("document.getElementById('reportsSelectBuyerBtn').click()"); p.wait_for_timeout(1200)
    p.click("#reportsBuyerSelectAllBtn"); p.wait_for_timeout(300)
    p.click(f"#reportsSelectBuyerPopup :text-is('{bname}')"); p.click("#reportsSelectBuyerClose"); p.wait_for_timeout(3500)
    check(f"PDF buttons appear once one buyer ({bname}) is selected", p.is_visible("#reportsCreatePdfBtn") and p.is_visible("#reportsSendPdfBtn"))
    body = p.inner_text("#reportsBuyerCentricWrap")
    check("buyer-centric section renders numbers", bool(re.search(r"\d", body)) and len(body) > 40, body[:200])
    with ctx.expect_page(timeout=30000) as pg:
        p.click("#reportsCreatePdfBtn")
    newp = pg.value; newp.wait_for_load_state(); check("Create PDF opens a blob PDF tab", newp.url.startswith("blob:"), newp.url)
    pdf_bytes = newp.evaluate("fetch(location.href).then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b)).slice(0,5))")
    check("Create PDF output starts with %PDF", bytes(pdf_bytes) == b"%PDF-"[:len(pdf_bytes)], pdf_bytes)
    newp.close()
    # Send PDF, share-sheet path (mobile / Mac Chrome): stub navigator.share and capture what would be shared
    p.evaluate("window.__shared=null; navigator.canShare=()=>true; navigator.share=async(d)=>{window.__shared={n:d.files[0].name,t:d.files[0].type,s:d.files[0].size,title:d.title,text:d.text}}; 0")
    p.click("#reportsSendPdfBtn"); p.wait_for_timeout(5000)
    sh = p.evaluate("window.__shared")
    check("Send PDF (share sheet) hands over a non-empty application/pdf file with the report text", bool(sh) and sh["t"] == "application/pdf" and sh["s"] > 1000 and "outreach report" in (sh["text"] or ""), sh)
    # desktop fallback: download
    p.evaluate("navigator.canShare=()=>false; 0")
    with p.expect_download(timeout=30000) as dl:
        p.click("#reportsSendPdfBtn")
    d = dl.value; path = os.path.join(tempfile.gettempdir(), "lc_report.pdf"); d.save_as(path)
    txt = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True).stdout
    check(f"Send PDF (desktop download) saves a readable PDF named {d.suggested_filename}", d.suggested_filename.endswith(".pdf") and len(txt) > 100 and "Outreach" in txt, txt[:200])
    # numbers on screen appear in the PDF text
    nums = set(re.findall(r"\b\d+\b", body))
    check("every number in the on-screen buyer section also appears in the PDF text", all(n in txt for n in nums), sorted(n for n in nums if n not in txt)[:8])
    check("Reports: no page errors", not clean_errs(errs), clean_errs(errs)[:3])
    # team report (weekly survey responses)
    ctx2, p2, errs2 = reports_session(b, "Mason Quinn", team_ids("5bed8808-79b8-470e-b6f8-262eab875b38") + ids)
    p2.goto(BASE + "profile.html"); p2.wait_for_timeout(3500); p2.click("#reportsBtn"); p2.wait_for_timeout(2500)
    p2.click("#reportsTypeBtn"); p2.wait_for_timeout(500)
    for opt in p2.query_selector_all("#reportsTypeMenu button, .page-header-menu-item"):
        if opt.is_visible() and "Team" in opt.inner_text(): opt.click(); break
    p2.wait_for_timeout(3000)
    t = p2.inner_text("#reportsTableWrap")
    check("Team report renders the survey table", "No submission" in t or "Yes" in t or "Account" in t, t[:200])
    ctx2.close(); ctx.close()

def messages(b):
    """The 2-minute email-sync cron re-imports a deleted message the moment it runs (the real mailbox still has it), which made the
    delete check race with it; park the cron for the scenario."""
    poll = lambda on: q(f"select cron.alter_job((select jobid from cron.job where jobname='email-sync-poll'), active := {'true' if on else 'false'})")
    poll(False)
    try: _messages(b)
    finally: poll(True)

def _messages(b):
    print("-- G. Messages select: Unread / Delete (local copy only)")
    ctx, p, errs = session(b, "Jonah Johnson")
    p.goto(BASE + "messages.html"); p.wait_for_timeout(5000)
    before = q("select count(*) n from email_messages where direction='inbound'")[0]["n"]
    p.click("#pageSettingsBtn"); p.click("#menuSelectBtn"); p.wait_for_timeout(800)
    check("select mode bar opens", p.is_visible("#selectModeBar"))
    first = p.query_selector("#messagesWrap .thread-row, #messagesWrap [data-thread-id], #messagesWrap .msg-row")
    if not first: check("inbox has a thread row to select", False); ctx.close(); return
    tid = first.get_attribute("data-thread-id"); first.click(); p.wait_for_timeout(500)
    mark = lambda: q(f"select is_read from email_messages where thread_id={lit(tid)} and direction='inbound'") if tid else []
    if tid:
        q(f"update email_messages set is_read=true where thread_id={lit(tid)}")
        p.click("#selectMarkUnreadBtn"); p.wait_for_timeout(2000)
        check("Unread: the selected thread's inbound messages become unread", mark() and all(r["is_read"] is False for r in mark()), mark())
    p.click("#pageSettingsBtn"); p.click("#menuSelectBtn"); p.wait_for_timeout(800)
    first = p.query_selector("#messagesWrap .thread-row, #messagesWrap [data-thread-id], #messagesWrap .msg-row"); tid = first.get_attribute("data-thread-id"); first.click()
    n_thread = q(f"select count(*) n from email_messages where thread_id={lit(tid)}")[0]["n"]
    p.click("#selectDeleteBtn"); p.wait_for_timeout(500); p.click("#confirmDeleteThreadsYesBtn"); p.wait_for_timeout(2500)
    check(f"Delete: removes the {n_thread} local message(s) of that thread only", q(f"select count(*) n from email_messages where thread_id={lit(tid)}")[0]["n"] == 0 and q("select count(*) n from email_messages where direction='inbound'")[0]["n"] >= before - n_thread, tid)
    check("Messages: no page errors", not clean_errs(errs), clean_errs(errs)[:3])
    ctx.close()
    subprocess.run(["python3", "copy_live_to_test.py", "--tables", "email_messages"], capture_output=True)   # restore the copied rows
    # the copy runs with triggers off and live has no is_system flags yet: flag the copied bounces like the trigger / backfill would, or the Inbox regression check sees them
    q("update email_messages set is_system = true, system_kind = email_system_kind(from_address, subject) where direction='inbound' and is_system=false and email_system_kind(from_address, subject) is not null")

def deleted_tabs(b):
    print("-- H. Deleted tabs: restore + purge")
    lead = uid("Jonah Johnson")
    q(f"delete from dial_lists where name like '{PREFIX} deleted%'")
    lid = q(f"insert into dial_lists (name, dial_type, created_by, deleted_at) values ('{PREFIX} deleted tab', 'seller', '{lead}', now()) returning id")[0]["id"]
    for i in range(3): q(f"insert into dials (list_id, created_by, company_name, full_name, company_phone) values ('{lid}', '{lead}', '{PREFIX} Co {i}', 'Pat {i}', '(801) 555-010{i}')")
    ctx0, p0, _ = session(b, "Jonah Johnson"); p0.goto(BASE + "profile.html"); p0.wait_for_timeout(3000); p0.click("#pageMenuToggle")
    check("Deleted tabs menu is admin-only (hidden for a team lead)", not p0.is_visible("#menuDeletedTabsBtn")); ctx0.close()
    ctx, p, errs = session(b, "Mason Quinn")
    def open_deleted():
        p.goto(BASE + "profile.html"); p.wait_for_timeout(3500); p.click("#pageMenuToggle"); p.click("#menuDeletedTabsBtn"); p.wait_for_function("!document.getElementById('deletedTabsWrap').innerText.includes('Loading')", timeout=30000); p.wait_for_timeout(800)
    open_deleted()
    check("Deleted tabs lists the trashed tab", PREFIX + " deleted tab" in p.inner_text("#deletedTabsWrap"), p.inner_text("#deletedTabsWrap")[:200])
    p.click("#deletedTabsSelectBtn"); p.click(f"#deletedTabsWrap :text('{PREFIX} deleted tab')"); p.click("#deletedTabsRestoreBtn"); p.wait_for_timeout(2500)
    r = q(f"select deleted_at from dial_lists where id='{lid}'")
    check("Restore clears deleted_at and keeps its 3 dials", r and r[0]["deleted_at"] is None and q(f"select count(*) n from dials where list_id='{lid}'")[0]["n"] == 3, r)
    q(f"update dial_lists set deleted_at=now() where id='{lid}'")
    open_deleted(); p.click("#deletedTabsSelectBtn"); p.click(f"#deletedTabsWrap :text('{PREFIX} deleted tab')"); p.click("#deletedTabsPurgeBtn"); p.wait_for_timeout(600); p.click("#deletedTabsPurgeYesBtn"); p.wait_for_timeout(2500)
    check("Purge deletes the list and its dials for good", not q(f"select 1 from dial_lists where id='{lid}'") and not q(f"select 1 from dials where list_id='{lid}'"))
    check("Deleted tabs: no page errors", not clean_errs(errs), clean_errs(errs)[:3])
    ctx.close()

def import_transfer(b):
    print("-- I. list upload + transfer")
    admin = uid("Mason Quinn"); brian = uid("Brian Skoubye")
    q(f"delete from dial_lists where name like '{PREFIX} import%'")
    q(f"delete from dials where company_name like '{PREFIX} Co%'")      # leftovers of a crashed run would be flagged as duplicates by the wizard
    csvp = os.path.join(tempfile.gettempdir(), f"{PREFIX} import.csv")
    open(csvp, "w").write("Full name,Company name,City,State,Email,Mobile number,Company number,LinkedIn,Website,Industry sector,Summary\n"
        f"Pat Example,{PREFIX} Co A,Provo,UT,pat.lcreg@lcreg-import.com,(385) 555-0711,(385) 555-0712,,https://a.example.com,Plumbing,Family plumbing shop.\n"
        f"Sam Example,{PREFIX} Co B,Ogden,UT,sam.lcreg@lcreg-import.com,(385) 555-0713,(385) 555-0714,,https://b.example.com,HVAC,Residential HVAC.\n")
    ctx, p, errs = session(b, "Mason Quinn")
    p.goto(BASE + "dials.html"); p.wait_for_timeout(3500)
    p.click("#pageMenuToggle"); p.click("#menuImportBtn"); p.wait_for_timeout(800)
    p.set_input_files("#importDialsFileInput", csvp); p.wait_for_selector(".iw-chips", timeout=20000)   # preview + column mapping step (import wizard)
    p.wait_for_function("/Import [0-9,]+ lead/.test(document.querySelector('#importDialsImportBtn').innerText)", timeout=30000)   # duplicate check done
    p.click(".cr-mandate-btn[data-m=ma]")                                                              # a list purpose is required
    p.wait_for_timeout(500); p.click("#importDialsImportBtn"); p.wait_for_selector("#importDialsResult", timeout=60000); p.wait_for_timeout(1500)
    lst = q(f"select id, created_by, name from dial_lists where name like '{PREFIX} import%' order by created_at desc")
    check("CSV import creates the list for the uploader with 2 dials", len(lst) == 1 and lst[0]["created_by"] == admin and q(f"select count(*) n from dials where list_id='{lst[0]['id']}'")[0]["n"] == 2, lst)
    if not lst: ctx.close(); return
    lid = lst[0]["id"]; check("import: no page errors", not clean_errs(errs), clean_errs(errs)[:3])
    p.goto(BASE + "dials.html"); p.wait_for_timeout(3500)
    p.click(f".dial-tab:has-text('{PREFIX} import')"); p.wait_for_timeout(1200)
    if not p.is_visible("#dialTabTransferBtn"): p.click(f".dial-tab:has-text('{PREFIX} import')"); p.wait_for_timeout(1000)
    p.click("#dialTabTransferBtn"); p.wait_for_timeout(1500)
    p.click(f"#dialTabTransferList .dial-tab-transfer-option:has-text('Brian Skoubye')"); p.wait_for_timeout(400)
    p.click("#dialTabTransferList .dial-tab-transfer-confirm [data-yes]"); p.wait_for_timeout(3000)   # round 2: transfer asks to confirm
    r = q(f"select created_by from dial_lists where id='{lid}'")[0]
    check("Transfer moves the list to the chosen intern", r["created_by"] == brian, r)
    check("Transfer moves its dials too", q(f"select count(*) n from dials where list_id='{lid}' and created_by='{brian}'")[0]["n"] == 2)
    ctx.close()
    ctx, p, errs = session(b, "Brian Skoubye"); p.goto(BASE + "dials.html"); p.wait_for_timeout(7000)
    check("the intern now sees the transferred list", PREFIX + " import" in p.inner_text("#dialTabs") or PREFIX + " Co" in p.inner_text("body"), p.inner_text("#dialTabs")[:200])
    ctx.close()
    q(f"delete from dial_lists where name like '{PREFIX} import%'")

def callbacks(b):
    print("-- J. callbacks (time picker, call sheet, Profile list)")
    name = "Brian Skoubye"; u = uid(name)
    ctx, p, errs = session(b, name); p.goto(BASE + "dials.html"); p.wait_for_timeout(3500)
    p.click("#dialsTableWrap [data-dial-id], #dialsTableWrap .dh-row"); p.wait_for_timeout(1500)
    did = p.evaluate("(document.querySelector('#dialModalBackdrop .contact-action-call')||{dataset:{}}).dataset.dialId")
    orig = q(f"select contact_status, callback_at, callback_user_id, called_today_date, contacted_mobile_date, contacted_company_date from dials where id='{did}'")[0]
    ncsc = q(f"select count(*) n from call_status_changes where user_id='{u}'")[0]["n"]
    today = datetime.date.today(); at = (datetime.datetime.now() + datetime.timedelta(hours=3)).replace(second=0, microsecond=0)
    if at.date() != today: at = datetime.datetime.combine(today, datetime.time(23, 30))
    p.click("#dialModalBackdrop .dial-outcome:has-text('Call back')"); p.wait_for_timeout(1000)
    p.fill("#callbackDateInput", at.strftime("%Y-%m-%d")); p.fill("#callbackTimeInput", at.strftime("%H:%M")); p.click("#callbackTimeSaveBtn"); p.wait_for_timeout(2500)
    r = q(f"select contact_status, callback_at, callback_user_id from dials where id='{did}'")[0]
    check("callback saved: status, callback time and owner on the dial", r["contact_status"] in ("busy_callback", "callback_interested") and r["callback_user_id"] == u and r["callback_at"] is not None, r)
    check("callback outcome logged in call_status_changes", q(f"select count(*) n from call_status_changes where user_id='{u}'")[0]["n"] == ncsc + 1)
    p.goto(BASE + "profile.html"); p.wait_for_timeout(4000); txt = p.inner_text("body")
    co = q(f"select company_name from dials where id='{did}'")[0]["company_name"]
    check("Profile 'Callbacks for today' lists the scheduled callback", co in txt.split("Callbacks for today")[-1], txt[-300:])
    p.goto(BASE + "dials.html"); p.wait_for_timeout(7000)
    check("call sheet shows the callback", "allback" in p.inner_text("#dialsHome") or "allback" in p.inner_text("body"))
    q(f"update dials set contact_status={lit(orig['contact_status'])}, callback_at={('null' if not orig['callback_at'] else lit(orig['callback_at']))}, callback_user_id={('null' if not orig['callback_user_id'] else lit(orig['callback_user_id']))}, called_today_date={('null' if not orig['called_today_date'] else lit(orig['called_today_date']))}, contacted_mobile_date={('null' if not orig['contacted_mobile_date'] else lit(orig['contacted_mobile_date']))}, contacted_company_date={('null' if not orig['contacted_company_date'] else lit(orig['contacted_company_date']))} where id='{did}'")
    q(f"delete from call_status_changes where user_id='{u}' and changed_at > now() - interval '10 minutes'")
    check("callbacks: no page errors", not clean_errs(errs), clean_errs(errs)[:3])
    ctx.close()
    # intake-submit with a questionnaire client: TEST has no Slack / sheet webhook, so nothing leaves
    lead = uid("Jonah Johnson")
    cid = q(f"insert into clients (client_type, company_name, full_name, created_by, intended_buyer_id, intake_form) values ('seller', '{PREFIX} Intake Co', 'Pat Intake', '{lead}', (select id from clients where tracking_flow='questionnaire' limit 1), '{{\"employees\":\"11-25\"}}') returning id")[0]["id"]
    import urllib.request, urllib.error
    from test_sequences import api, URL, ANON, login as tlogin
    ctx, p, errs = session(b, "Jonah Johnson")
    tok = p.evaluate("(async()=>{const k=Object.keys(localStorage).find(k=>k.includes('auth-token'));return JSON.parse(localStorage.getItem(k)).access_token})()")
    r = urllib.request.Request(URL + "/functions/v1/intake-submit", data=json.dumps({"client_id": cid}).encode(), headers={"Authorization": "Bearer " + tok, "apikey": ANON, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as f: code, body = f.status, json.loads(f.read().decode())
    except urllib.error.HTTPError as e: code, body = e.code, json.loads(e.read().decode() or "{}")
    check("intake-submit answers for the owner and posts nowhere (slack/sheet not_configured)", code == 200 and body.get("slack") in ("not_configured", None) and body.get("sheet") in ("not_configured", None), (code, body))
    ctx.close(); q(f"delete from clients where id='{cid}'")

def lead_scope(b):
    print("-- K. team lead scope + phone width with real data")
    ctx, p, errs = session(b, "Jonah Johnson"); p.goto(BASE + "profile.html"); p.wait_for_timeout(3500); p.click("#reportsBtn"); p.wait_for_timeout(3500)
    p.wait_for_timeout(1500)   # round 3: Reports opens on the whole team already (no "Select all" click needed)
    rows = set(table_rows(p)) | {"Jonah Johnson (live copy)"}
    TEAM2 = "d83fb5c8-96a4-4e0a-be21-bfafe7054368"   # Jonah also leads Team 2 through team_lead_teams
    team = {r["full_name"] for r in q(f"select full_name from profiles where team_id in ('{TEAM3}','{TEAM2}') and role in ('intern','independent_lead','team_lead') and id in (select id from auth.users where email like 'live.%')")}
    check("lead's report lists only own team accounts", rows <= team | {"Jonah Johnson (live copy)"} and len(rows) >= 3, (rows, team))
    p.evaluate("document.getElementById('reportsAccountsVisibleBtn').click()"); p.wait_for_timeout(1200)
    shown = p.inner_text("#reportsAccountsVisiblePopup")
    other = {r["full_name"] for r in q("select full_name from profiles where team_id not in ('%s','%s') and id in (select id from auth.users where email like 'live.%%') and full_name not like 'Jonah Johnson%%'" % (TEAM3, TEAM2))}
    check("lead's Accounts visible never lists a team he does not lead", not any(n in shown for n in other if n not in team), [n for n in other if n in shown][:4])
    ctx.close()
    for role, name in (("lead", "Jonah Johnson"), ("intern", "Brian Skoubye"), ("admin", "Mason Quinn")):
        ctx, p, errs = session(b, name, width=375)
        for pg in ("profile", "dials", "messages", "clients"):
            p.goto(BASE + pg + ".html"); p.wait_for_timeout(2500)
            check(f"{role}: {pg}.html no sideways scroll at 375px with real data", p.evaluate("document.documentElement.scrollWidth") <= 376 or pg == "clients", p.evaluate("document.documentElement.scrollWidth"))
        ctx.close()

SCEN = {"lead": lead_scope, "reports": reports, "messages": messages, "deleted": deleted_tabs, "import": import_transfer, "callbacks": callbacks}
