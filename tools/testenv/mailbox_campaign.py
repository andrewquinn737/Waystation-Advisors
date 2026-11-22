"""MAILBOX TEST campaign on the TEST project: every one of our 57 mailboxes sends one email and receives one.
Usage: python3 mailbox_campaign.py setup | status | teardown   (TEST only; sb.test_sql never touches live)."""
import sb, sys, json, os, random, re, uuid, urllib.request
import test_sequences as T
q, lit = T.q, T.lit
LISTNAME = "MAILBOX TEST campaign"
MASON = ["masonquinn10@gmail.com", "mason.alex.quinn@gmail.com", "mason@waystationadvisors.com",
         "mason@waystation-advisors.com", "mason.quinn@waystation-advisors.com"]

def secret_set(pairs):
    sb.test_api("/secrets", [{"name": k, "value": v} for k, v in pairs])

def boxes():
    return q("""select a.id, a.owner_id, lower(a.email_address) email, a.label, p.email login, p.full_name oname
                from email_accounts a join profiles p on p.id=a.owner_id where coalesce(a.source,'')<>'live_copy' order by p.full_name, a.email_address""")

def person(b):
    lab = (b["label"] or "").strip()
    if not lab or "@" in lab:
        lab = (lab or b["email"]).split("@")[0].replace(".", " ").replace("_", " ").title()
    return lab

CLOSE = ["Best", "Thanks", "Cheers", "Regards", "Talk soon", "All the best", "Thank you", "Take care", "Many thanks", "Kind regards"]
def copy(k, s, r, sfirst):
    sd, rd = s["email"].split("@")[1], r["email"].split("@")[1]
    first = person(r).split()[0]
    S1 = [f"This is internal inbox check number {k}, sent from the {sd} mailbox.",
          f"Sending test note {k} from {sd} to confirm the message lands in {rd} without trouble.",
          f"Quick deliverability note {k}: this one left {sd} and should reach {rd} today.",
          f"Mailbox test {k} is on its way from {sd} over to {rd}."]
    S2 = [f"If it shows up in your inbox and not in spam, please reply with a single word for check {k}.",
          f"Seeing this in the inbox instead of the junk folder is the whole point of check {k}, so a short reply helps.",
          f"A one line reply to check {k} tells us the thread and the reply path both work.",
          f"Please answer check {k} with any short reply once you have seen it."]
    F = [f"Following the earlier note {k}, a quick reply from {rd} would close the loop.",
         f"Note {k} may still be waiting in your inbox, and a short answer would finish the check.",
         f"Check {k} is still open on our side, so any reply from {rd} settles it."]
    subj = f"Inbox check {k} from {sd.split('.')[0]}"
    e1 = f"Hi {first},\n\n{random.choice(S1)} {random.choice(S2)}\n\n{CLOSE[k % 10]},\n{sfirst}"
    e2 = f"Hi {first},\n\n{random.choice(F)}\n\n{CLOSE[(k + 5) % 10]},\n{sfirst}"
    return subj, e1, e2

def setup():
    random.seed(7)
    B = boxes(); assert len(B) == 57
    owners = {}
    for b in B: owners.setdefault(b["owner_id"], []).append(b)
    order = [b for b in B]
    slots = [b for b in order]                    # one send slot per mailbox (owner sends len(boxes) emails)
    for shift in range(1, 57):
        rec = [order[(i + shift) % 57] for i in range(57)]
        if all(slots[i]["owner_id"] != rec[i]["owner_id"] for i in range(57)): break
    else: raise SystemExit("no valid assignment")
    print("shift", shift)
    q("delete from dial_lists where name like '%s%%'" % LISTNAME)
    secret_set([("TEST_REDIRECT_TO", ",".join(MASON + [b["email"] for b in B]))])
    q("insert into app_secrets (key,value) values ('test_send_now','true') on conflict (key) do update set value='true'")
    for e in {b["email"].split("@")[1] for b in B}:
        pass
    lists = {}
    for oid, bs in owners.items():
        lid = str(uuid.uuid4()); lists[oid] = lid
        q(f"insert into dial_lists (id,name,dial_type,created_by) values ('{lid}', {lit(LISTNAME + ' - ' + bs[0]['oname'])}, 'seller', '{oid}')")
    for k, (s, r) in enumerate(zip(slots, rec), 1):
        subj, e1, e2 = copy(k, s, r, person(s).split()[0])
        oid = s["owner_id"]; dom = r["email"].split("@")[1]
        q(f"""insert into dials (list_id, created_by, company_name, full_name, email, company_phone, email_subject, email_1, email_2)
              values ('{lists[oid]}','{oid}', {lit('Waystation test – ' + dom)}, {lit(person(r))}, {lit(r['email'])}, '(801) 555-0100', {lit(subj)}, {lit(e1)}, {lit(e2)})""")
    json.dump({"lists": lists}, open("/tmp/mbtest_lists.json", "w"))
    for oid, lid in lists.items():
        login = owners[oid][0]["login"]
        print(owners[oid][0]["oname"], T.rpc(login, "seq_prepare_list", p_list_id=lid))
        print("  gate", T.gate(login, lid))
if __name__ == "__main__":
    {"setup": setup}[sys.argv[1]]()
