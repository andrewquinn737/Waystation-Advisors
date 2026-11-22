"""Regression with REAL (copied) data on TEST, as real roles: admin (Mason's copy), team lead (Jonah Johnson), intern
(Brian Skoubye) and an independent lead (Kayden Hyde). Real Chrome via Playwright against http://localhost:5173 (TEST project).
Needs copy_live_to_test.py to have run and ~/Projects/First Project/TEST_LOGINS_LIVE_COPY.md.
Everything this suite creates is prefixed 'LC-REG' and removed afterwards; copied rows it touches are restored.
No call is placed (the call lock is exercised instead) and no email can reach a real person (TEST_REDIRECT_TO)."""
import sys, re, json, time, datetime, traceback, tempfile, os
import sb
from lc_common import *
q = sb.test_sql
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:400]}"), flush=True)
NOISE = ("Auto-sync failed", "Failed to send a request to the Edge Function", "net::ERR_ABORTED", "calls_test_lock", "limited to the test number")
PREFIX = "LC-REG"
def lit(s): return "'" + str(s).replace("'", "''") + "'"
def uid(name): return q(f"select id from profiles where full_name in ({lit(name)}, {lit(name + ' (live copy)')}) and id in (select id from auth.users where email like 'live.%') limit 1")[0]["id"]

def local_midnight(d):  # machine tz == Chrome tz
    return datetime.datetime(d.year, d.month, d.day).astimezone().isoformat()
def monday(d=None):
    d = d or datetime.date.today(); return d - datetime.timedelta(days=d.weekday())

def session(b, name, width=1100):
    kw = dict(is_mobile=True, has_touch=True, user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36") if width < 500 else {}
    ctx = b.new_context(viewport={"width": width, "height": 900}, accept_downloads=True, **kw); errs = []; p = new_page(ctx, errs)
    e, pw_ = creds(name); login(p, e, pw_); return ctx, p, errs

def clean_errs(errs): return [e for e in errs if not any(n in e for n in NOISE)]

# ---------------------------------------------------------------- A. every page loads clean for every role
def pages(b):
    print("-- A. pages load clean with real data")
    for role, name in WHO.items():
        ctx, p, errs = session(b, name)
        pgs = ["profile", "clients", "dials", "messages"] + (["admin"] if role == "admin" else [])
        for pg in pgs:
            errs.clear(); p.goto(BASE + pg + ".html"); p.wait_for_timeout(3500)
            check(f"{role} ({name}): {pg}.html loads with no errors", not clean_errs(errs), clean_errs(errs)[:3])
        nav = p.eval_on_selector_all(".topnav-bar .links a", "a=>a.map(x=>x.textContent)")
        check(f"{role}: nav is {nav}", {"Profile", "Clients", "Calls", "Inbox"} <= set(nav) and (("Admin" in nav) == (role == "admin")), nav)
        ctx.close()

# ---------------------------------------------------------------- B. profile numbers vs DB, quota, callbacks, upcoming events
def counts_for(user_id, side, start_local, end_local):
    return q(f"""select count(distinct coalesce(dial_id::text, lower(company_name))) n from call_status_changes
                 where user_id='{user_id}' and dial_type='{side}' and changed_at >= '{start_local}' and changed_at < '{end_local}'""")[0]["n"]

def profile_numbers(b):
    print("-- B. Profile numbers vs the database")
    today = datetime.date.today(); mon = monday(today)
    for role, name in WHO.items():
        ctx, p, errs = session(b, name); p.goto(BASE + "profile.html"); p.wait_for_timeout(4500)
        txt = p.inner_text("body"); u = uid(name)
        for _ in range(8):
            if re.search(r"(\d+) compan(?:y|ies) contacted this week", txt): break
            p.wait_for_timeout(1500); txt = p.inner_text("body")
        m = re.search(r"(\d+) compan(?:y|ies) contacted this week, (\d+) today", txt)
        check(f"{role}: 'companies contacted this week/today' line present", bool(m), txt[:300])
        if not m: ctx.close(); continue
        week, td = int(m.group(1)), int(m.group(2))
        # which side is on screen: sellers by default
        side = q(f"select 'seller' s")[0]["s"]
        nxt = mon + datetime.timedelta(days=7)
        exp_w = counts_for(u, side, local_midnight(mon), local_midnight(nxt))
        exp_t = counts_for(u, side, local_midnight(today), local_midnight(today + datetime.timedelta(days=1)))
        if role in ("admin", "lead"):   # may aggregate visible accounts; accept the self count as a lower bound
            check(f"{role}: week/today counts >= own DB counts ({exp_w}/{exp_t})", week >= exp_w and td >= exp_t, (week, td, exp_w, exp_t))
        else:
            check(f"{role}: week/today counts equal the DB ({exp_w}/{exp_t})", (week, td) == (exp_w, exp_t), (week, td, exp_w, exp_t))
        q_ = re.search(r"\((\d+) more compan", txt)
        if role in ("intern", "indlead"):
            quota = 50
            check(f"{role}: quota line = {quota} - week", (int(q_.group(1)) if q_ else 0) == max(0, quota - week), (q_ and q_.group(1), week))
        # bars: six weekly bars match DB, oldest first (labels M/D)
        labels = re.findall(r"^(\d{1,2}/\d{1,2})$", txt, re.M)
        if role in ("intern", "indlead") and len(labels) >= 6:
            bars = p.eval_on_selector_all("svg rect, .chart-bar, [class*=bar]", "els=>els.map(e=>e.getAttribute('data-value')||e.getAttribute('aria-label')||'')")
            nums = re.findall(r"^(\d+)$", txt, re.M)
            check(f"{role}: chart axis labels are the last 6 week starts", [l for l in labels[-6:]] == [(mon - datetime.timedelta(days=7 * k)).strftime("%-m/%-d") for k in range(5, -1, -1)], labels)
        ctx.close()

    # callbacks + upcoming events on Profile, vs DB
    ctx, p, errs = session(b, "Mason Quinn"); p.goto(BASE + "profile.html"); p.wait_for_timeout(4000); txt = p.inner_text("body")
    ev = q("select c.name nm, e.event_date, e.event_type from client_events e join clients c on c.id=e.client_id where e.event_date > now() and e.event_type ilike '%intro%' order by e.event_date limit 5") \
        if q("select 1 from information_schema.columns where table_name='clients' and column_name='name'") else []
    names = q("select name from clients where false") if False else []
    ups = re.findall(r"Intro call · ([A-Z][a-z]{2} \d{1,2}, 20\d\d)", txt)
    dbn = q("select count(*) n from client_events where event_type='intro_call' and event_date >= date_trunc('day', now() at time zone 'America/Denver') and client_id in (select id from clients where created_by is not null or true)")[0]["n"]
    check(f"admin: Upcoming events shows {len(ups)} intro calls (DB future intro events: {dbn})", len(ups) <= dbn and (len(ups) > 0 or dbn == 0), (ups, dbn))
    ctx.close()
    for name in ("Andrew Quinn",):
        ctx, p, errs = session(b, name); p.goto(BASE + "profile.html"); p.wait_for_timeout(4000); txt = p.inner_text("body")
        due = q(f"select count(*) n from callback_tasks where assigned_to='{uid(name)}' and status='open' and due_at::date = current_date")[0]["n"]
        check(f"{name}: callbacks-today list consistent with callback_tasks ({due} due today)", (("No callbacks scheduled for today" in txt) == (due == 0)), (due, txt[-300:]))
        ctx.close()

# ---------------------------------------------------------------- C. call logging + Profile counts + call lock UI
def call_logging(b):
    print("-- C. call logging + Profile counts + call lock")
    name = "Brian Skoubye"; u = uid(name)
    ctx, p, errs = session(b, name)
    p.goto(BASE + "profile.html"); p.wait_for_timeout(3500)
    before = int(re.search(r"(\d+) compan(?:y|ies) contacted this week", p.inner_text("body")).group(1))
    p.goto(BASE + "dials.html"); p.wait_for_timeout(3500)
    p.click("#dialsTableWrap [data-dial-id], #dialsTableWrap .dh-row"); p.wait_for_timeout(1200)
    did = p.evaluate("(document.querySelector('#dialModalBackdrop .contact-action-call')||{dataset:{}}).dataset.dialId")
    state0 = q(f"select contact_status, called_today_date, contacted_mobile_date, contacted_company_date from dials where id='{did}'")[0] if did else None
    n0 = q(f"select count(*) n from call_status_changes where user_id='{u}'")[0]["n"]
    already = q(f"select count(*) n from call_status_changes where user_id='{u}' and dial_id='{did}' and changed_at >= '{local_midnight(monday())}'")[0]["n"]
    # call lock in the UI: clicking Call on a real owner's number is refused with the test-app notice, no call row is created
    calls0 = q("select count(*) n from calls")[0]["n"]
    p.click("#dialModalBackdrop .dial-call-btn >> nth=0"); p.wait_for_timeout(2000)
    body = p.inner_text("body")
    check("call lock (UI): Call on a real owner shows 'Test app: calls limited to the test number'", "limited to the test number" in body, body[-300:])
    check("call lock (UI): no calls row created", q("select count(*) n from calls")[0]["n"] == calls0)
    p.click("#noticeCloseBtn"); p.wait_for_timeout(500)
    if not p.is_visible("#dialModalBackdrop .dial-outcome >> nth=0"):
        p.goto(BASE + "dials.html"); p.wait_for_timeout(3000); p.click("#dialsTableWrap [data-dial-id], #dialsTableWrap .dh-row"); p.wait_for_timeout(1200)
    p.click("#dialModalBackdrop .dial-outcome:has-text('No answer')"); p.wait_for_timeout(2500)
    n1 = q(f"select count(*) n from call_status_changes where user_id='{u}'")[0]["n"]
    check("outcome 'No answer' writes one call_status_changes row for the intern", n1 == n0 + 1, (n0, n1))
    row = q(f"select dial_id, contact_status_at_call, contact_method, company_name from call_status_changes where user_id='{u}' order by changed_at desc limit 1")[0]
    check("the logged row names the company and method", bool(row["company_name"]) and row["contact_method"], row)
    p.goto(BASE + "profile.html"); p.wait_for_timeout(4000)
    after = int(re.search(r"(\d+) compan(?:y|ies) contacted this week", p.inner_text("body")).group(1))
    expect = before + (0 if already or row["dial_id"] != did and False else 1)
    # one more distinct company this week unless the same company had already been contacted this week
    seen = q(f"select count(distinct dial_id) n from call_status_changes where user_id='{u}' and dial_id='{row['dial_id']}' and changed_at >= '{local_midnight(monday())}' and changed_at < now() - interval '1 minute'")[0]["n"]
    expect = before + (0 if seen else 1)
    check(f"Profile count after logging: {before} -> {after} (expected {expect})", after == expect, (before, after, expect))
    # restore the copied row state
    q(f"delete from call_status_changes where user_id='{u}' and changed_at > now() - interval '10 minutes'")
    if state0: q(f"update dials set contact_status={lit(state0['contact_status'])}, called_today_date={('null' if not state0['called_today_date'] else lit(state0['called_today_date']))}, contacted_mobile_date={('null' if not state0['contacted_mobile_date'] else lit(state0['contacted_mobile_date']))}, contacted_company_date={('null' if not state0['contacted_company_date'] else lit(state0['contacted_company_date']))} where id='{did}'")
    ctx.close()

# ---------------------------------------------------------------- D. weekly survey
def survey(b):
    print("-- D. weekly survey")
    name = "Jacob Farnsworth"; u = uid(name)
    today = datetime.date.today(); d = (today.weekday() - 4) % 7; fri = today - datetime.timedelta(days=d); mon = fri - datetime.timedelta(days=4)
    q(f"delete from survey_responses where user_id='{u}' and period_start='{mon}'")
    ctx, p, errs = session(b, name); p.goto(BASE + "profile.html"); p.wait_for_timeout(4000)
    check("survey button is visible for the intern", p.is_visible("#surveyBtn"))
    p.click("#surveyBtn"); p.wait_for_timeout(2500)
    calls = int(p.input_value("#surveyCallsInput")); talked = int(p.input_value("#surveyOwnersTalkedInput")); agreed = int(p.input_value("#surveyOwnersAgreedInput"))
    ecalls = counts_for(u, "seller", local_midnight(mon), local_midnight(fri + datetime.timedelta(days=1)))
    etalk = q(f"""select count(*) n from dials d join dial_lists l on l.id=d.list_id where l.deleted_at is null and d.created_by='{u}'
                  and d.contact_status in ('not_interested','callback_interested','busy_callback','intro_call_scheduled') and d.called_today_date between '{mon}' and '{fri}'""")[0]["n"]
    eag = q(f"select count(*) n from intro_call_log where user_id='{u}' and client_type='seller' and scheduled_at >= '{local_midnight(mon)}' and scheduled_at < '{local_midnight(fri + datetime.timedelta(days=1))}'")[0]["n"]
    check(f"survey auto-fill matches DB (calls {calls}/{ecalls}, owners talked {talked}/{etalk}, agreed {agreed}/{eag})", (calls, talked, agreed) == (ecalls, etalk, eag))
    p.click("#surveyAccurateToggle button[data-value=yes]"); p.click("#surveyModelingToggle button[data-value=no]")
    p.fill("#surveyQuestionsInput", f"{PREFIX} test submission"); p.click("#surveySubmitBtn"); p.wait_for_timeout(2500)
    r = q(f"select * from survey_responses where user_id='{u}' and period_start='{mon}'")
    check("survey submit writes one row with the shown numbers", len(r) == 1 and (r[0]["calls_made_final"], r[0]["owners_talked_final"], r[0]["owners_agreed_final"]) == (calls, talked, agreed) and r[0]["info_accurate"] is True, r)
    p.reload(); p.wait_for_timeout(3500)
    check("button locks (disabled) after submitting", p.is_disabled("#surveyBtn"))
    q(f"delete from survey_responses where user_id='{u}' and period_start='{mon}'")
    ctx.close()

# ---------------------------------------------------------------- E. clients
def clients(b):
    print("-- E. clients")
    for role, name in (("admin", "Mason Quinn"), ("intern", "Brian Skoubye")):
        ctx, p, errs = session(b, name); p.goto(BASE + "clients.html"); p.wait_for_timeout(4500)
        rows = p.eval_on_selector_all("tr, .client-row, .client-card, [data-client-id]", "els=>els.filter(x=>x.offsetParent).length")
        vis = q(f"select count(*) n from clients")[0]["n"]
        check(f"{role}: clients page renders rows with real data (rows on screen {rows}, DB {vis})", rows > 0 and not clean_errs(errs), (rows, clean_errs(errs)[:2]))
        ctx.close()

# ---------------------------------------------------------------- main
SCEN = {"pages": pages, "profile": profile_numbers, "calls": call_logging, "survey": survey, "clients": clients}
if __name__ == "__main__":
    import importlib; sys.modules['test_live_copy'] = sys.modules['__main__']
    try: extra = importlib.import_module("test_live_copy2"); SCEN.update(extra.SCEN)
    except ImportError: pass
    pick = sys.argv[1:] or list(SCEN)
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
        for k in pick:
            try: SCEN[k](b)
            except Exception as e:
                check(f"scenario {k} ran without crashing", False, traceback.format_exc()[-500:])
        b.close()
    print(f"\n{sum(results)}/{len(results)} passed")
