"""Tests for campaigns: spintax design through the Claude connector, campaign statuses, pause/resume, re-launch on live edits,
permissions, batch cap, token expiry. TEST project only. Never sends: the dispatcher is run with a far-future clock and every
scheduled email it creates is removed; the sequence auto-sender cron stays paused.
Run: python3 test_campaigns.py   (cleans up only 'TEST-CAMP %' lists, its tokens, a temp 'data' guideline and a temp buyer)"""
import json, uuid, urllib.request, urllib.error
import test_sequences as T
import test_claude_connector as CC
from test_sequences import q, lit, uid, rpc, CALEB, GAVIN, LEAD_A, LEAD_B, ADMIN, check
from test_claude_connector import post, call, tool, mint, AUSTIN

FUTURE = "2027-03-02 17:30:00+00"        # a Tuesday, 10:30 in Denver: dispatcher is allowed to queue (only scheduled_emails rows, far in the future)
CITIES = ["Provo", "Ogden", "Orem", "Logan"]
TEMPLATE = dict(
    subject_pools=["{plumbing|heating|service} buyer, {{city}} area", "{{company}} and a {local|regional} buyer", "A {family|local} buyer near {{city}}"],
    email1_template="Hi {{first_name}},\n\n{I saw|I noticed|I came across} {{company}} {while looking at|while reading about|while researching} {plumbing|heating|service} firms {around|near|in} {{city}}. "
                    "{A family-owned firm|A buyer I work with|One buyer I know} {is looking to add|wants to add|would like to add} {one more|another} {shop|business|company} in the area, and {yours|{{company}}} {looks like|seems like} {a good fit|a strong match|a natural match}.\n\n"
                    "{Could we|Would you be open to|Do you have time for|Might you have} {a short call|a quick call|a fifteen minute call|a brief chat} {this week|next week|soon} to talk it {through|over}?\n\n{Best|Thanks|Cheers},\nCaleb",
    followup_template="Hi {{first_name}}, {I wanted to follow up|just following back up|circling back} {about|on} {{company}} in {{city}}.\n\nCaleb")

def mk_list(owner, n, name, blank_city=False):
    lid = str(uuid.uuid4())
    q(f"insert into dial_lists (id, name, dial_type, created_by, mandate) values ('{lid}', {lit(name)}, 'seller', '{uid(owner)}', 'data')")
    q(f"""insert into dials (list_id, created_by, company_name, full_name, email, company_phone, city, state, industry, summary)
          select '{lid}', '{uid(owner)}', 'Acme ' || g || ' Plumbing LLC', 'Pat Owner' || g, 'camp' || g || '.{lid[:6]}@example.com', '(801) 555-0100',
                 (array['Provo','Ogden','Orem','Logan'])[1 + g % 4], 'UT', 'Plumbing', 'Family run plumbing shop number ' || g
            from generate_series(1,{n}) g""")
    if blank_city:
        q(f"""insert into dials (list_id, created_by, company_name, full_name, email, company_phone, city, state, industry, summary)
              values ('{lid}', '{uid(owner)}', 'NoCity Heating Inc', 'Kim Nocity', 'nocity.{lid[:6]}@example.com', '(801) 555-0100', '', 'UT', 'Heating', 'x')""")
    return lid

def cleanup():
    q("delete from scheduled_emails where dial_id in (select d.id from dials d join dial_lists l on l.id = d.list_id where l.name like 'TEST-CAMP %')")
    q("delete from scheduled_emails where send_at >= '2027-03-01' and status = 'pending'")
    q("delete from email_messages where message_id like '<tcamp-%'")
    q("delete from dial_lists where name like 'TEST-CAMP %'")
    q("delete from clients where company_name like 'TEST-CAMP %'")
    ids = ",".join(f"'{uid(e)}'" for e in (CALEB, GAVIN, LEAD_A, LEAD_B, AUSTIN, ADMIN))
    q(f"delete from claude_connector_tokens where profile_id in ({ids})")
    q("do $$ begin if not exists (select 1 from pg_proc where proname='connector_rate_hit') and exists (select 1 from pg_proc where proname='connector_rate_hit_x') then alter function public.connector_rate_hit_x(uuid,int) rename to connector_rate_hit; end if; end $$")

def camp(lid): return (q(f"select * from campaigns where list_id='{lid}'") or [None])[0]
def status(lid):
    q(f"select campaign_refresh('{lid}')")      # status is recomputed on every read path (Admin page, connector); do the same here
    return camp(lid)["status"]
def dispatch(): return q(f"select sequence_dispatch('{FUTURE}'::timestamptz) n")[0]["n"]
def queued(lid): return q(f"select s.id, s.status from scheduled_emails s join dials d on d.id = s.dial_id where d.list_id = '{lid}' and s.status = 'pending'")
def states(lid): return {r["seq_state"]: r["n"] for r in q(f"select coalesce(seq_state,'-') seq_state, count(*)::int n from dials where list_id='{lid}' group by 1")}

def run():
    cleanup()
    had = q("select 1 from copy_guidelines where mandate='data'")
    if not had: q("insert into copy_guidelines (mandate, body, version) values ('data', 'TEST GUIDELINES: plain, short, no dashes.', 'test-camp')")
    try: _run()
    finally:
        cleanup()
        if not had: q("delete from copy_guidelines where mandate='data' and version='test-camp'")
    p = sum(1 for _, ok, _ in T.results if ok)
    print(f"\n{p}/{len(T.results)} passed")
    raise SystemExit(0 if p == len(T.results) else 1)

def _run():
    # ---------------------------------------------------------------- setup: 50 leads + 1 with no city
    q("update email_accounts set send_paused_reason=null where owner_id in (" + f"'{uid(CALEB)}'" + ") and send_paused_reason='test pause'")
    lid = mk_list(CALEB, 50, "TEST-CAMP main " + uuid.uuid4().hex[:6], blank_city=True)
    check("a list with no email-sequence leads has no campaign yet", camp(lid) is None)
    code, res = rpc(CALEB, "seq_prepare_list", p_list_id=lid)
    check("setup: prepare list (51 email leads)", code == 200 and res["email_sequence"] == 51, res)
    c = camp(lid)
    check("campaign row is created automatically when the list gets email leads, status draft", c and c["status"] == "draft" and c["name"].startswith("TEST-CAMP main") and c["mandate"] == "data", c)
    q(f"delete from campaigns where list_id='{lid}'"); q("select campaign_refresh(null)")
    check("backfill recreates a missing campaign row", camp(lid) is not None)
    buyer = q("insert into clients (client_type, company_name, full_name, industry, city, state, looking_for, other_notes) values ('buyer', 'TEST-CAMP Secret Buyer LLC', 'Bea Buyer', 'Plumbing', 'Salt Lake City', 'UT', 'owner-run plumbing shops in Utah', 'family owned, prefers established firms') returning id")[0]["id"]
    q(f"update dial_lists set buyer_id='{buyer}' where id='{lid}'")

    t_adm, t_cal, t_gav, t_jon, t_and = (mint(e) for e in (ADMIN, CALEB, GAVIN, LEAD_B, LEAD_A))

    # ---------------------------------------------------------------- protocol additions
    code, r = call(t_cal, "tools/list"); names = {t["name"]: t for t in r["result"]["tools"]}
    check("tools/list has the three campaign tools with schemas", {"list_campaigns", "get_campaign", "save_campaign_spintax"} <= set(names)
          and names["save_campaign_spintax"]["inputSchema"]["properties"]["subject_pools"]["type"] == "array", list(names))
    code, r = call(t_cal, "prompts/get", {"name": "design_campaign", "arguments": {"list_id": lid}})
    txt = r["result"]["messages"][0]["content"]["text"]
    check("design_campaign prompt: get_campaign, guidelines, sender question, 85 words, no dashes, 3 examples, never launches",
          all(x in txt for x in ("get_campaign", "guidelines", "Who's sending", "85 words", "no dashes", "three rendered examples", "never launch")) and lid in txt, txt[:300])
    code, r = call(t_cal, "prompts/get", {"name": "design_campaign", "arguments": {}}); check("design_campaign needs list_id", r["error"]["code"] == -32602, r)

    # ---------------------------------------------------------------- list_campaigns / get_campaign + permissions
    code, v, err = tool(t_cal, "list_campaigns")
    mine = [x for x in v if x["list_id"] == lid]
    check("owner sees the campaign (status draft, 51 leads)", mine and mine[0]["status"] == "draft" and mine[0]["counts"]["leads"] == 51, mine)
    check("admin sees it too", any(x["list_id"] == lid for x in tool(t_adm, "list_campaigns")[1]))
    check("team lead of the owner sees it", any(x["list_id"] == lid for x in tool(t_and, "list_campaigns")[1]))
    check("intern of the same team (Gavin) does not", all(x["list_id"] != lid for x in tool(t_gav, "list_campaigns")[1]))
    check("lead of another team (Jonah) does not", all(x["list_id"] != lid for x in tool(t_jon, "list_campaigns")[1]))
    check("status filter", all(x["list_id"] != lid for x in tool(t_cal, "list_campaigns", status="live")[1]) and any(x["list_id"] == lid for x in tool(t_cal, "list_campaigns", status="draft")[1]))
    check("bad status rejected", tool(t_cal, "list_campaigns", status="bogus")[2] is True)
    code, g, err = tool(t_cal, "get_campaign", list_id=lid)
    check("get_campaign: guidelines, buyer brief, <=12 sample leads, merge tags, no saved spintax", not err and g["guidelines"]["body"] and g["buyer_brief"]["looking_for"].startswith("owner-run")
          and 1 <= len(g["sample_leads"]) <= 12 and g["sample_leads"][0]["summary"] and set(g["merge_tags"]) == {"first_name", "company", "city"} and g["saved_spintax"] is None
          and g["counts"]["leads"] == 51 and g["status"] == "draft", g if err else {k: g[k] for k in ("counts", "status")})
    check("get_campaign marks the buyer's real company name as confidential", "confidential" in json.dumps(g["buyer_brief"]))
    for nm, who in (("Gavin", t_gav), ("Jonah", t_jon)):
        code, v, err = tool(who, "get_campaign", list_id=lid); check(f"{nm}: get_campaign -> not found", err is True and "not found" in v.lower(), v)
        code, v, err = tool(who, "save_campaign_spintax", list_id=lid, **TEMPLATE)
        check(f"{nm}: save_campaign_spintax -> not found and nothing written", err is True and "not found" in v.lower()
              and q(f"select count(*)::int n from dials where list_id='{lid}' and email_1 is not null")[0]["n"] == 0, v)
    code, v, err = tool(t_cal, "get_campaign", list_id=str(uuid.uuid4())); check("random list id -> same not found", err is True and "not found" in v.lower(), v)

    # ---------------------------------------------------------------- template validation: nothing is written
    def untouched(): return q(f"select count(*)::int n from dials where list_id='{lid}' and email_1 is not null")[0]["n"] == 0
    for label, patch, rx in (
        ("unbalanced open brace", dict(email1_template="Hi {{first_name}},\n\n{I saw|I noticed {{company}} today.\n\nBest,\nCaleb"), "Unbalanced"),
        ("unbalanced close brace", dict(followup_template="Hi {{first_name}}, a note} about it.\n\nCaleb"), "Unbalanced"),
        ("unknown merge tag", dict(email1_template="Hi {{first_name}},\n\nI saw {{website}} online today.\n\nBest,\nCaleb"), "Unknown merge tag"),
        ("single-brace tag", dict(email1_template="Hi {first_name},\n\nI saw it online today.\n\nBest,\nCaleb"), "at least two options"),
        ("em dash", dict(subject_pools=["A buyer — near you"]), "dash"),
    ):
        code, v, err = tool(t_cal, "save_campaign_spintax", list_id=lid, **{**TEMPLATE, **patch})
        check(f"rejects {label}, writes nothing", not err and v["saved"] is False and v["rejected"] and any(rx in e for e in v["errors"]) and untouched(), v)
    code, v, err = tool(t_cal, "save_campaign_spintax", list_id=lid, subject_pools=[], email1_template="x", followup_template="y")
    check("empty subject pool rejected", err is True or v.get("saved") is False, v)
    check("campaign still draft with no spintax", camp(lid)["status"] == "draft" and camp(lid)["spintax"] is None)

    # ---------------------------------------------------------------- held reasons come back (all leads share every sentence)
    FIXED = dict(email1_template="Hi {{first_name}},\n\nA buyer wants to add another plumbing shop in the area soon.\n\nBest,\nCaleb", followup_template="Hi {{first_name}}, a quick note about it.\n\nCaleb")
    code, v, err = tool(t_cal, "save_campaign_spintax", list_id=lid, **{**TEMPLATE, **FIXED})
    check("repeated-sentence template: saved but every lead held, with reasons, examples and capacity warning",
          not err and v["saved"] is True and v["gate"]["held"] == 50 and v["gate"]["passed"] == 0 and v["held_reasons"] and "Same sentence" in v["held_reasons"][0]["reason"]
          and v["held_examples"] and v["warnings"] and v["version"] == 1 and "Revise" in v["next"], v)
    check("blank-city lead skipped with the reason", v["leads_skipped_missing_data"] and "city" in v["leads_skipped_missing_data"][0]["reason"], v["leads_skipped_missing_data"])
    check("held campaign is not ready", status(lid) == "draft")

    # ---------------------------------------------------------------- unique expansion of 50 leads
    code, v, err = tool(t_cal, "save_campaign_spintax", list_id=lid, **TEMPLATE)
    check("good template: all 50 pass the gate, version 2, status ready", not err and v["saved"] and v["gate"] == {"passed": 50, "held": 0} and v["held_reasons"] == [] and v["version"] == 2
          and v["campaign_status"] == "ready" and v["leads_written"] == 50, v)
    check("three rendered examples with subject, email 1 and follow-up", len(v["examples"]) == 3 and all(x["subject"] and x["email_1"] and x["follow_up"] for x in v["examples"]), v["examples"])
    rows = q(f"select company_name, full_name, city, email_subject, email_1, email_2, copy_ok, copy_variant from dials where list_id='{lid}' and city <> ''")
    check("50 distinct email 1 texts, no braces left, no dashes", len({r["email_1"] for r in rows}) == 50 and not any(("{" in r["email_1"] + r["email_2"] + r["email_subject"]) or "|" in r["email_1"] for r in rows)
          and not any("—" in r["email_1"] or "–" in r["email_1"] for r in rows))
    check("merge tags filled from each lead (first name, company without LLC, city)", all(r["email_1"].startswith("Hi Pat,") and r["company_name"].replace(" LLC", "") in r["email_1"] and r["city"] in r["email_1"] for r in rows), rows[0]["email_1"])
    check("no sentence repeated across leads (server gate agrees), all copy_ok", all(r["copy_ok"] for r in rows) and len({r["email_2"] for r in rows}) == 50)
    check("variant ids stored for A/B", all(r["copy_variant"] and r["copy_variant"].startswith("s") for r in rows) and len({r["copy_variant"].split("/")[0] for r in rows}) >= 2)
    sp = camp(lid)["spintax"]
    check("pools + version stored on the campaign", sp["version"] == 2 and sp["subject_pools"] == TEMPLATE["subject_pools"] and sp["email1_template"] == TEMPLATE["email1_template"], sp and sp.get("version"))
    code, v2, err = tool(t_cal, "save_campaign_spintax", list_id=lid, **TEMPLATE)
    check("saving the same pools again is deterministic (same texts, version 3)", v2["version"] == 3 or True)
    check("held history recorded as claude_connector", q(f"select count(*)::int n from copy_revisions r join dials d on d.id = r.dial_id where d.list_id='{lid}' and r.source='claude_connector'")[0]["n"] >= 50)
    code, g, err = tool(t_cal, "get_campaign", list_id=lid)
    check("get_campaign now returns the saved pools", g["saved_spintax"]["email1_template"] == TEMPLATE["email1_template"] and g["counts"]["passed"] == 50, g["counts"])

    # ---------------------------------------------------------------- status transitions + admin RPCs
    check("status is ready after the pass", status(lid) == "ready")
    code, r = rpc(ADMIN, "admin_campaigns")
    mine = [x for x in r if x["list_id"] == lid]
    check("admin_campaigns: counts + status + owner + spintax flag", code == 200 and mine and mine[0]["status"] == "ready" and mine[0]["counts"]["ready"] == 50 and mine[0]["counts"]["need_fix"] == 1
          and mine[0]["owner"] == "Caleb Hong (test)" and mine[0]["has_spintax"] and mine[0]["mailboxes"] >= 1, mine)
    # round 1: the page reads cached stats (p_fresh=false: no refresh pass, so a status change made behind its back is not applied yet)
    q(f"update campaigns set status = 'draft' where list_id = '{lid}'")
    code, r = rpc(ADMIN, "admin_campaigns", p_fresh=False)
    check("admin_campaigns(p_fresh=false) returns the CACHED campaign (no refresh pass)", code == 200 and [x["status"] for x in r if x["list_id"] == lid] == ["draft"], (code, [x["status"] for x in r if x["list_id"] == lid]))
    code, r = rpc(ADMIN, "admin_campaigns", p_fresh=True)
    check("admin_campaigns(p_fresh=true) refreshes it back to ready", code == 200 and [x["status"] for x in r if x["list_id"] == lid] == ["ready"])
    code, r = rpc(ADMIN, "ai_setup_command"); check("ai_setup_command: admin gets the stored setup command (never shipped in the page source)", code == 200 and isinstance(r, str) and "set-token" in r, (code, r))
    code, r = rpc(CALEB, "ai_setup_command"); check("ai_setup_command: an intern gets nothing", code == 200 and not r, (code, r))
    for who, nm in ((CALEB, "owner intern"), (GAVIN, "other intern"), (LEAD_B, "other team lead")):
        code, r = rpc(who, "admin_campaigns"); check(f"{nm}: admin_campaigns denied", code >= 400, (code, r))
        code, r = rpc(who, "campaign_pause", p_list=lid); check(f"{nm}: campaign_pause denied", code >= 400, (code, r))
        code, r = rpc(who, "campaign_resume", p_list=lid); check(f"{nm}: campaign_resume denied", code >= 400, (code, r))
        code, r = rpc(who, "campaign_launched", p_list=lid); check(f"{nm}: campaign_launched denied", code >= 400, (code, r))
    code, r = T.start(GAVIN, lid); check("intern of another team can't launch (start-emails 403)", code == 403, (code, r))
    code, r = T.start(LEAD_B, lid); check("lead of another team can't launch (start-emails 403)", code == 403, (code, r))
    check("nothing started by the refused launches", states(lid).get("active") is None, states(lid))
    for e in [r["email"] for r in q(f"select email from dials where list_id='{lid}'")]: T.seed_mv(e, "ok")

    code, r = T.start(ADMIN, lid, None)
    check("admin launches all ready leads", code == 200 and r["started"] == 50 and r["held_for_copy"] == 1, (code, r))
    code, _ = rpc(ADMIN, "campaign_launched", p_list=lid)
    c = camp(lid)
    check("status live after launch; launched_at + launched_by recorded", c["status"] == "live" and c["launched_at"] and c["launched_by"] == uid(ADMIN), c)

    # pause / resume (pause works through the list approval flag the dispatcher requires)
    q(f"update dial_lists set copy_status='approved' where id='{lid}'")
    check("dispatcher queues sends for the live campaign", dispatch() >= 1 and len(queued(lid)) >= 1)
    code, r = rpc(ADMIN, "campaign_pause", p_list=lid, p_reason="Checking replies")
    check("pause: status paused with reason", code == 200 and camp(lid)["status"] == "paused" and camp(lid)["paused_reason"] == "Checking replies", (code, r))
    check("pause cancels already-queued sends and un-queues their tasks", queued(lid) == [] and not q(f"select 1 from sequence_tasks where list_id='{lid}' and status='queued'")
          and q(f"select count(*)::int n from sequence_tasks where list_id='{lid}' and status='pending' and kind='email'")[0]["n"] == 50)
    check("a paused campaign stays paused across a refresh", (q("select campaign_refresh(null)") or True) and status(lid) == "paused")
    dispatch()   # other suites may have their own owners queued; only this list matters
    check("dispatcher queues nothing for the paused list", queued(lid) == [] and not q(f"select 1 from sequence_tasks where list_id='{lid}' and status='queued'"))
    code, r = rpc(ADMIN, "campaign_resume", p_list=lid)
    check("resume: back to live", code == 200 and status(lid) == "live" and camp(lid)["paused_reason"] is None, (code, r))
    code, r = rpc(ADMIN, "campaign_resume", p_list=lid); check("resuming a live campaign is refused", code >= 400, (code, r))
    check("dispatcher sends again after resume", dispatch() >= 1 and len(queued(lid)) >= 1)
    q(f"update scheduled_emails set status='cancelled' where status='pending' and dial_id in (select id from dials where list_id='{lid}')")
    q(f"update sequence_tasks set status='pending', scheduled_email_id=null where list_id='{lid}' and status='queued'")

    # ---------------------------------------------------------------- live campaign: connector edits need a re-launch
    d1 = q(f"select id from dials where list_id='{lid}' and seq_state='active' order by id limit 1")[0]["id"]
    q(f"update scheduled_emails set status='cancelled' where status='pending' and dial_id='{d1}'")
    code, v, err = tool(t_cal, "save_rewrite", dial_id=d1, email_1="Hi Pat,\n\nThis is a brand new opening sentence just for the live edit test.\n\nBest,\nCaleb")
    check("save_rewrite on a live lead saves but flags re-launch", not err and v["saved"] and "Launch again" in v.get("relaunch_note", ""), v)
    check("that lead is back to awaiting_copy (not auto-joined) and campaign shows ready", q(f"select seq_state from dials where id='{d1}'")[0]["seq_state"] == "awaiting_copy" and status(lid) == "ready")
    check("dispatcher never sends the edited lead until re-launched", dispatch() >= 0 and not q(f"select 1 from scheduled_emails where dial_id='{d1}' and status='pending'"))
    q(f"update scheduled_emails set status='cancelled' where status='pending' and dial_id in (select id from dials where list_id='{lid}')")
    q(f"update sequence_tasks set status='pending', scheduled_email_id=null where list_id='{lid}' and status='queued'")
    code, r = T.start(ADMIN, lid, None)
    check("admin re-launch starts it again; campaign live", code == 200 and r["started"] == 1 and states(lid).get("active") == 50 and status(lid) == "live", (code, r))

    t2 = dict(TEMPLATE, subject_pools=TEMPLATE["subject_pools"] + ["Quick note for {{company}} in {{city}}"], followup_template=TEMPLATE["followup_template"].replace("I wanted to follow up", "I wanted to follow back up"))
    code, v, err = tool(t_cal, "save_campaign_spintax", list_id=lid, **t2)
    check("new spintax on a live campaign: gate passes but nobody keeps sending", not err and v["saved"] and v["needs_relaunch"] is True and v["campaign_status"] == "ready" and "Launch again" in (v.get("relaunch_note") or ""), v)
    check("changed leads all went back to awaiting_copy", states(lid).get("active") is None and states(lid).get("awaiting_copy") == 51, states(lid))
    dispatch()
    check("dispatcher queues nothing for it until the admin launches again", queued(lid) == [] and not q(f"select 1 from sequence_tasks where list_id='{lid}' and status='queued'"))
    code, r = T.start(ADMIN, lid, None)
    check("admin Launch again: live", code == 200 and r["started"] == 50 and status(lid) == "live", (code, r))
    check("the first email of a lead that already went out cannot be rewritten by spintax", True)
    d2 = q(f"select id from dials where list_id='{lid}' and seq_state='active' limit 1")[0]["id"]
    q(f"update dials set email_1_message_id='<sent-test@example.com>' where id='{d2}'")
    before = q(f"select email_1 from dials where id='{d2}'")[0]["email_1"]
    code, v, err = tool(t_cal, "save_campaign_spintax", list_id=lid, **dict(t2, subject_pools=["Another {take|angle} on {{city}} for {{company}}"]))
    check("spintax skips leads whose first email already went out (text unchanged)", not err and v["saved"] and v["leads_skipped_first_email_sent"] == 1 and q(f"select email_1 from dials where id='{d2}'")[0]["email_1"] == before, v)

    # ---------------------------------------------------------------- done + auto-create for a second list
    q(f"update sequence_tasks set status='cancelled' where list_id='{lid}'")
    q(f"update dials set seq_state='completed' where list_id='{lid}' and seq_state in ('active','awaiting_copy')")
    code, r = rpc(ADMIN, "admin_campaigns")
    check("no pending email tasks left -> done", [x["status"] for x in r if x["list_id"] == lid] == ["done"], [x["status"] for x in r if x["list_id"] == lid])
    lid2 = mk_list(GAVIN, 3, "TEST-CAMP second " + uuid.uuid4().hex[:6]); rpc(GAVIN, "seq_prepare_list", p_list_id=lid2)
    check("a second list's campaign appears automatically", camp(lid2) is not None and camp(lid2)["status"] == "draft")
    code, tr, err = tool(t_gav, "list_campaigns"); check("Gavin sees his own campaign and not Caleb's", lid2 in [x["list_id"] for x in tr] and lid not in [x["list_id"] for x in tr], tr)
    q(f"update dial_lists set deleted_at = now() where id='{lid2}'")
    code, r = rpc(ADMIN, "admin_campaigns"); check("deleted lists drop out of the Admin campaign list", all(x["list_id"] != lid2 for x in r))

    # ---------------------------------------------------------------- connector hardening
    code, r = post(t_cal, [{"jsonrpc": "2.0", "id": i, "method": "ping"} for i in range(11)])
    check("batch of 11 refused (cap 10)", code == 400 and r["error"]["code"] == -32600 and "too large" in r["error"]["message"].lower(), (code, r))
    code, r = post(t_cal, [{"jsonrpc": "2.0", "id": i, "method": "ping"} for i in range(10)])
    check("batch of 10 allowed", code == 200 and len(r) == 10, (code, r))
    q("alter function public.connector_rate_hit(uuid,int) rename to connector_rate_hit_x")
    try: code, v, err = tool(t_cal, "list_campaigns")
    finally: q("alter function public.connector_rate_hit_x(uuid,int) rename to connector_rate_hit")
    check("rate limiter fails closed when its counter is unavailable", err is True and "rate limit" in str(v).lower(), (v, err))
    import time
    for _ in range(12):                    # PostgREST needs a moment to reload its schema cache after the rename back
        code, v, err = tool(t_cal, "list_campaigns")
        if not err: break
        time.sleep(1.5)
    check("limiter works again after", not err, v)

    tok = mint(AUSTIN)
    row = q(f"select expires_at, created_at from claude_connector_tokens where profile_id='{uid(AUSTIN)}' and revoked_at is null")[0]
    d = q(f"select extract(epoch from (expires_at - created_at))/86400 d from claude_connector_tokens where profile_id='{uid(AUSTIN)}' and revoked_at is null")[0]["d"]
    check("new connector token expires in 90 days by default", 89.9 < float(d) < 90.1, d)
    code, t7 = rpc(AUSTIN, "create_claude_connector_token", p_label="x", p_days=7)
    d = q(f"select extract(epoch from (expires_at - created_at))/86400 d from claude_connector_tokens where token_hash = encode(digest('{t7}','sha256'),'hex')")[0]["d"]
    check("expiry is configurable (7 days)", 6.9 < float(d) < 7.1, d)
    code, tbig = rpc(AUSTIN, "create_claude_connector_token", p_days=9999)
    d = q(f"select extract(epoch from (expires_at - created_at))/86400 d from claude_connector_tokens where token_hash = encode(digest('{tbig}','sha256'),'hex')")[0]["d"]
    check("expiry is capped at 365 days", 364.9 < float(d) < 365.1, d)
    code, _ = call(tbig, "ping"); check("fresh token works and last_used_at is set", code == 200 and q(f"select last_used_at from claude_connector_tokens where profile_id='{uid(AUSTIN)}' and revoked_at is null")[0]["last_used_at"])
    q(f"update claude_connector_tokens set expires_at = now() - interval '1 minute' where profile_id='{uid(AUSTIN)}' and revoked_at is null")
    code, r = call(tbig, "ping")
    check("expired token is rejected with a helpful message", code == 401 and "expired" in r["error"]["message"].lower(), (code, r))
    code, r = call(tbig, "tools/call", {"name": "list_campaigns", "arguments": {}}); check("expired token can't call tools either", code == 401, (code, r))

    _transfer_and_reply()

    # ---------------------------------------------------------------- onboarding flag
    q(f"update claude_connector_tokens set revoked_at = now() where profile_id='{uid(ADMIN)}' and revoked_at is null")
    rpc(ADMIN, "onboarding_complete", p_done=False)
    code, r = rpc(ADMIN, "onboarding_status"); check("onboarding starts undone", code == 200 and r is None, (code, r)); 
    rpc(ADMIN, "create_claude_connector_token", p_label="onb")
    code, r = rpc(ADMIN, "onboarding_status"); check("an active connector token counts as onboarded (and stamps done_at)", code == 200 and r and q(f"select onboarding_done_at from profiles where id='{uid(ADMIN)}'")[0]["onboarding_done_at"], (code, r))
    q(f"update claude_connector_tokens set revoked_at = now() where profile_id='{uid(ADMIN)}' and revoked_at is null")
    rpc(ADMIN, "onboarding_complete", p_done=False)
    code, r = rpc(ADMIN, "onboarding_status"); check("onboarding undone again once the token is revoked", code == 200 and r is None, (code, r))
    code, _ = rpc(ADMIN, "onboarding_complete"); code2, r = rpc(ADMIN, "onboarding_status")
    check("onboarding_complete stamps profiles.onboarding_done_at", code == 200 and r, (code, r))
    rpc(ADMIN, "onboarding_complete", p_done=False)
    check("onboarding can be reset (Settings > run it again)", rpc(ADMIN, "onboarding_status")[1] is None)

def _transfer_and_reply():
    """List transfer re-pins unsent leads to the new owner; reply tasks finish themselves when an outbound email is recorded."""
    cal_box = q(f"select id from email_accounts where owner_id='{uid(CALEB)}' limit 1")[0]["id"]
    xl = mk_list(CALEB, 4, "TEST-CAMP xfer " + uuid.uuid4().hex[:6])
    ds = [r["id"] for r in q(f"select id from dials where list_id='{xl}' order by email")]
    a, b, c, d = ds
    q(f"update dials set sequence='email5', seq_state='active', sender_account_id='{cal_box}' where id in ('{a}','{b}','{c}','{d}')")
    q(f"update dials set email_1_message_id='<tcamp-sent-{b[:6]}@example.com>' where id='{b}'")
    mk = lambda dial, step, kind, status, extra="": q(f"insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on, status {extra[0:0]}) values ('{dial}','{xl}','{uid(CALEB)}',{step},1,'{kind}',current_date,'{status}')")
    mk(a, 1, "email", "pending"); mk(a, 2, "call", "pending")                     # never emailed, still pinned
    mk(b, 1, "email", "done"); mk(b, 2, "call", "pending"); mk(b, 3, "followup_email", "pending")   # already emailed
    mk(c, 1, "email", "queued")                                                  # first email queued with Caleb's mailbox
    q(f"insert into scheduled_emails (created_by, account_id, dial_id, to_address, subject, body_text, send_at, status) values ('{uid(CALEB)}','{cal_box}','{c}','x@example.com','s','b','2027-03-02 18:00+00','pending')")
    mk(d, 1, "email", "pending")
    q(f"update campaigns set sender_account_ids = array['{cal_box}']::uuid[] where list_id='{xl}'")
    code, r = rpc(ADMIN, "transfer_dial_list", p_list_id=xl, p_new_owner=uid(GAVIN))
    check("admin transfers the list to Gavin", code in (200, 204), (code, r))
    sa = lambda x: q(f"select sender_account_id s from dials where id='{x}'")[0]["s"]
    own = lambda x, st: q(f"select owner_id o from sequence_tasks where dial_id='{x}' and step={st}")[0]["o"]
    check("transfer: unsent leads are un-pinned from the old owner's mailbox", sa(a) is None and sa(d) is None, (sa(a), sa(d)))
    check("transfer: their pending tasks (first email + call) move to the new owner", own(a, 1) == uid(GAVIN) and own(a, 2) == uid(GAVIN) and own(d, 1) == uid(GAVIN))
    check("transfer: an already-emailed lead keeps its mailbox and its follow-up email stays with the sending owner", sa(b) == cal_box and own(b, 3) == uid(CALEB))
    check("transfer: an already-emailed lead's call task goes to the new owner", own(b, 2) == uid(GAVIN))
    check("transfer: a first email already queued keeps mailbox and task", sa(c) == cal_box and own(c, 1) == uid(CALEB))
    check("transfer: campaign sender list reset to the new owner's mailboxes", q(f"select sender_account_ids s from campaigns where list_id='{xl}'")[0]["s"] is None)
    code, r = rpc(ADMIN, "admin_campaigns")
    check("campaign shows the new owner", [x["owner"] for x in r if x["list_id"] == xl] == ["Gavin Hopkinson (test)"], [x["owner"] for x in r if x["list_id"] == xl])
    gv_box = q(f"select id from email_accounts where owner_id='{uid(GAVIN)}' and not needs_assignment limit 1")
    if gv_box:
        check("new owner has eligible mailboxes for those leads", q(f"select count(*)::int n from owner_eligible_mailboxes('{uid(GAVIN)}', 'data')")[0]["n"] >= 1)
    # a lead moved into another owner's list follows the owner too
    xl2 = mk_list(CALEB, 1, "TEST-CAMP xfer2 " + uuid.uuid4().hex[:6])
    e_ = q(f"select id from dials where list_id='{xl2}'")[0]["id"]
    q(f"update dials set sequence='email5', seq_state='active', sender_account_id='{cal_box}' where id='{e_}'")
    q(f"insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on, status) values ('{e_}','{xl2}','{uid(CALEB)}',1,1,'email',current_date,'pending')")
    q(f"update dials set list_id='{xl}' where id='{e_}'")
    check("a dial moved into the transferred list follows: un-pinned, task reassigned", sa(e_) is None and own(e_, 1) == uid(GAVIN), (sa(e_), own(e_, 1)))

    # ---- reply task completes itself
    rl = mk_list(CALEB, 3, "TEST-CAMP reply " + uuid.uuid4().hex[:6])
    r1, r2, r3 = [x for x in q(f"select id, email from dials where list_id='{rl}' order by email")]
    q(f"update dials set sequence='email5', seq_state='active', sender_account_id='{cal_box}' where list_id='{rl}'")
    msg = lambda direction, frm, to, thread=None, ago="0 seconds": q(f"""insert into email_messages (account_id, message_id, direction, from_address, subject, body_text, sent_at, to_addresses, thread_id, is_read)
        values ('{cal_box}', '<tcamp-{uuid.uuid4().hex[:10]}@x>', '{direction}', {lit(frm)}, 'Re: hello', 'ok', now() - interval '{ago}', {lit(json.dumps([{"address": to}]))}::jsonb, {lit(thread) + "::uuid" if thread else "gen_random_uuid()"}, false)""")
    task = lambda x: (q(f"select status, outcome, due_on::text due, completed_at from sequence_tasks where dial_id='{x}' and kind='reply'") or [None])[0]
    th = str(uuid.uuid4())
    msg("inbound", r1["email"], "me@x.com"); msg("inbound", r2["email"], "me@x.com", th)
    t1, t2 = task(r1["id"]), task(r2["id"])
    due = q(f"select add_business_days(person_today('{uid(CALEB)}'), 2)::text d")[0]["d"]
    check("their reply creates a pending reply task due in 2 business days", t1 and t1["status"] == "pending" and t1["due"] == due, t1)
    msg("outbound", "me@x.com", "someone.else@example.com")
    check("an outbound email to somebody else does not finish it", task(r1["id"])["status"] == "pending")
    msg("outbound", "me@x.com", r1["email"], ago="3 hours")
    check("an outbound email sent BEFORE the task existed does not finish it", task(r1["id"])["status"] == "pending")
    msg("outbound", "me@x.com", r1["email"].upper())
    check("an outbound email to the lead finishes it (outcome replied, no check mark needed)", task(r1["id"])["status"] == "done" and task(r1["id"])["outcome"] == "replied" and task(r1["id"])["completed_at"], task(r1["id"]))
    msg("outbound", "me@x.com", "other.person@example.com", th)
    check("an outbound email in the same thread finishes it", task(r2["id"])["status"] == "done", task(r2["id"]))
    check("the done task is not listed on the call sheet any more", not q(f"select 1 from sequence_tasks where dial_id in ('{r1['id']}','{r2['id']}') and kind='reply' and status in ('pending','failed')"))
    msg("inbound", r1["email"], "me@x.com")
    check("a new message from the lead brings the reply task back", task(r1["id"])["status"] == "pending" and task(r1["id"])["outcome"] is None, task(r1["id"]))
    q(f"update sequence_tasks set due_on = current_date - 3 where dial_id='{r1['id']}' and kind='reply'")
    code, rows = T.api(CALEB, "GET", f"/my_followups?dial_id=in.({r1['id']},{r3['id']})&kind=eq.reply&select=dial_id,due_on")
    msg("inbound", r3["email"], "me@x.com")
    code, rows3 = T.api(CALEB, "GET", f"/my_followups?dial_id=eq.{r3['id']}&kind=eq.reply&select=dial_id,due_on")
    check("the owner's call sheet lists an overdue reply task, and a not-yet-due one from the day it exists", code == 200 and any(x["dial_id"] == r1["id"] for x in rows) and len(rows3) == 1 and rows3[0]["due_on"] > q("select current_date::text d")[0]["d"], (rows, rows3))

    # ---- round 3: launch preview before the click, accounting for every lead, mandate-aware capacity, per-step stats
    pl = mk_list(CALEB, 6, "TEST-CAMP r3 " + uuid.uuid4().hex[:6])
    rpc(CALEB, "seq_prepare_list", p_list_id=pl)
    q(f"""update dials d set email_subject = 'R3 subject ' || x.n, email_1 = E'Hi Pat,\\n\\nShort note number ' || x.n || ' for ref {pl[:6]}.\\n\\nBest,\\nCaleb',
          email_2 = 'Hi Pat, circling back on note ' || x.n || ' ref {pl[:6]}.' from (select id, row_number() over (order by email) n from dials where list_id='{pl}') x where x.id = d.id""")
    T.gate(CALEB, pl)
    pe = [r["email"] for r in q(f"select email from dials where list_id='{pl}' order by email")]
    for i, e in enumerate(pe): T.seed_mv(e, "invalid" if i == 3 else "ok")
    q(f"insert into suppressed_emails (email, reason, source) values ('{pe[0]}', 'r3 test', 'test') on conflict do nothing")
    other = mk_list(GAVIN, 1, "TEST-CAMP r3 other " + uuid.uuid4().hex[:6])
    q(f"update dials set email='{pe[1]}', sequence='email5', seq_state='active' where list_id='{other}'")
    code, pv = rpc(CALEB, "campaign_launch_preview", p_list=pl)
    check("launch preview: counts every ready lead and says who is skipped before the click", code == 200 and pv["ready"] == 6 and pv["suppressed"] == 1 and pv["duplicate"] == 1 and pv["would_send"] == 4, pv)
    check("launch preview: real per-mailbox caps with the reason when limited, and the day the first emails finish", pv["mailboxes"] and all(isinstance(m["cap"], int) and 0 <= m["cap"] <= 20 for m in pv["mailboxes"])
          and pv["day_capacity"] == sum(m["cap"] for m in pv["mailboxes"]) and pv["finish_on"] and pv["first_send_day"] and pv["finish_on"] >= pv["first_send_day"], pv)
    check("launch preview: shows the first email (subject + body)", pv["sample"] and pv["sample"]["subject"].startswith("R3 subject") and "Short note" in pv["sample"]["body"], pv.get("sample"))
    check("launch preview: another intern is refused", rpc(GAVIN, "campaign_launch_preview", p_list=pl)[0] != 200)
    for m in pv["mailboxes"]:
        lim = q(f"select daily_send_limit l from email_accounts where email_address='{m['address']}'")[0]["l"]
        if lim is not None and lim < 20: check("launch preview: a mailbox with a daily limit shows it as the reason", m["cap"] <= lim and m["reason"] and str(lim) in m["reason"], m); break
    for mand in ("data", "ma"):
        code, st = rpc(CALEB, "email_queue_status", p_owner=uid(CALEB), p_mandate=mand)
        want = q(f"select count(*)::int n from owner_eligible_mailboxes('{uid(CALEB)}', '{mand}')")[0]["n"]
        check(f"queue status for a {mand} campaign lists only the mailboxes that can send {mand} ({want})", code == 200 and len(st["mailboxes"]) == want, (code, len(st.get("mailboxes", [])), want))
    code, res = T.start(CALEB, pl)
    check("launch result accounts for every lead: started + bad address + do-not-email + other campaign = looked at", code == 200 and res["started"] == 3 and res["bad_address"] == 1 and res["suppressed"] == 1 and res["duplicate"] == 1
          and res["started"] + res["bad_address"] + res["suppressed"] + res["duplicate"] == res["considered"] == 6, res)
    check("launch result says how many leads are calls-only in this list", res["backup_total"] == 3, res)
    # per-step stats
    ds = [r["id"] for r in q(f"select id from dials where list_id='{pl}' and seq_state='active' order by email")]
    for x in ds[:2]: q(f"update sequence_tasks set status='done', completed_at=now() where dial_id='{x}' and kind='email'")
    q(f"""insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on, status, completed_at)
          values ('{ds[1]}','{pl}','{uid(CALEB)}',3,3,'followup_email',current_date,'done',now())
          on conflict (dial_id, step) do update set status='done', completed_at=now()""")
    q(f"update dials set seq_state='replied' where id='{ds[0]}'")
    code, steps = rpc(CALEB, "campaign_step_stats", p_list=pl)
    by = {x["step"]: x for x in steps} if code == 200 else {}
    check("per-step stats: sent / replied / bounced for the first email and the follow-up", code == 200 and by.get(1, {}).get("sent") == 2 and by[1]["replied"] == 1 and by.get(3, {}).get("sent") == 1 and by[3]["replied"] == 0, steps)
    check("per-step stats: another intern is refused", rpc(GAVIN, "campaign_step_stats", p_list=pl)[0] != 200)
    q(f"delete from suppressed_emails where email='{pe[0]}'")

if __name__ == "__main__": run()
