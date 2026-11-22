"""Seed realistic demo data on the TEST project (never live): a 'DEMO Call sheet' for intern Caleb Hong that fills every
call-sheet group, and a small 'DEMO Lead sheet' for lead Andrew Quinn (he also sees Caleb's list through team rules).
NOT prefixed TEST-, so test cleanups leave it alone. Idempotent: re-running rebuilds only the DEMO lists' own rows.
Fake data only: @example.com emails, (801) 555-01xx numbers. Run: python3 seed_demo.py"""
import sb, json, os, uuid

SEC = json.load(open(os.path.expanduser("~/Projects/First Project/.waystation_test_secrets.json")))
CALEB, ANDREW = "test.caleb.hong@example.com", "test.andrew.quinn@example.com"
uid = lambda e: SEC["accounts"][e]["id"]
q = sb.test_sql
lit = lambda v: "null" if v is None else "'" + str(v).replace("'", "''") + "'"
assert sb.TEST_REF != sb.LIVE_REF

def reset_list(name, owner):
    old = q(f"select id from dial_lists where name = {lit(name)} and created_by = '{uid(owner)}'")
    for r in old:   # own rows only: tasks cascade with the dials
        q(f"delete from email_messages where from_address like 'demo.%@example.com' and account_id in (select id from email_accounts where owner_id = '{uid(owner)}')")
        q(f"delete from dials where list_id = '{r['id']}'")
        q(f"delete from dial_lists where id = '{r['id']}'")
    lid = str(uuid.uuid4())
    q(f"insert into dial_lists (id, name, dial_type, created_by, mandate, status) values ('{lid}', {lit(name)}, 'seller', '{uid(owner)}', 'ma', 'current')")
    return lid

n = [0]
def phone(): n[0] += 1; return f"(801) 555-01{n[0] % 100:02d}"

def dial(lid, owner, co, person, city, status="uncontacted", seq=None, state=None, day0=None, callback=None, tasks=(), reply=None, acct=None, ind="Home services", notes=None):
    """tasks: (step, seq_day, kind, due_offset_days, status). reply: subject+body of an inbound email from this lead."""
    slug = "".join(c for c in co.lower() if c.isalnum())[:18]
    email = f"demo.{slug}@example.com"
    d = q(f"""insert into dials (list_id, created_by, company_name, full_name, email, mobile_phone, company_phone, linkedin, city, state, website, industry,
                summary, contact_status, sequence, seq_state, seq_day0, callback_at, sender_account_id)
              values ('{lid}', '{uid(owner)}', {lit(co)}, {lit(person)}, {lit(email)}, {lit(phone())}, {lit(phone())},
                {lit('https://www.linkedin.com/in/' + person.lower().replace(' ', '-') + '-demo')}, {lit(city)}, 'UT', {lit('https://' + slug + '.example.com')}, {lit(ind)},
                {lit(f'Family-run {ind.lower()} business serving {city} since the 1990s. Owner is hands-on; about 20 employees. Demo record.')},
                {lit(status)}, {lit(seq)}, {lit(state)}, {f"person_today('{uid(owner)}') - {day0}" if day0 is not None else 'null'},
                {f"now() + interval '{callback}'" if callback else 'null'}, {lit(acct) if state else 'null'})
              returning id""")[0]["id"]
    for step, day, kind, off, st in tasks:
        q(f"""insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on, status, completed_at)
              values ('{d}', '{lid}', '{uid(owner)}', {step}, {day}, '{kind}', person_today('{uid(owner)}') + ({off}), '{st}', {"now()" if st == "done" else "null"})""")
    if reply and acct:
        q(f"""insert into email_messages (account_id, direction, from_address, from_name, to_addresses, subject, body_text, snippet, is_read, sent_at)
              values ('{acct}', 'inbound', {lit(email)}, {lit(person)}, '[]'::jsonb, {lit(reply[0])}, {lit(reply[1])}, {lit(reply[1][:90])}, false, now() - interval '3 hours')""")
    return d

def acct_of(owner):
    r = q(f"select id from email_accounts where owner_id = '{uid(owner)}' order by email_address limit 1")
    return r[0]["id"] if r else None

def build(owner, lid, rows):
    a = acct_of(owner)
    for r in rows: dial(lid, owner, acct=a, **r)

# an active email5 lead whose email step already went out; later steps pending
def run(step_off, calls): return [(1, 1, "email", -step_off, "done")] + calls

caleb_rows = [
  # 1 Past due (call, company line, LinkedIn, two replies)
  dict(co="Wasatch Gutter Pros", person="Dale Hutchins", city="Sandy", seq="email5", state="active", day0=5, tasks=run(5, [(2, 3, "call", -2, "pending")])),
  dict(co="Beehive Fence & Deck", person="Marcy Olsen", city="Draper", seq="email5", state="active", day0=7, tasks=run(7, [(2, 3, "call", -4, "done"), (5, 5, "call", -2, "done"), (6, 7, "call_company", -1, "pending")])),
  dict(co="Red Rock Landscaping", person="Tom Brinkerhoff", city="Murray", seq="email5", state="active", day0=6, tasks=run(6, [(2, 3, "call", -3, "done"), (4, 4, "linkedin", -1, "pending")])),
  dict(co="Summit Garage Doors", person="Kim Larsen", city="Lehi", seq="email5", state="active", day0=3, tasks=run(3, [(100, 0, "reply", -1, "pending")]), reply=("Re: quick question", "Thanks for reaching out. We might be open to talking, can you call me Thursday morning?")),
  dict(co="Canyon View Plumbing", person="Rob Eyre", city="Provo", seq="email5", state="active", day0=2, tasks=run(2, [(100, 0, "reply", 0, "pending")]), reply=("Re: Canyon View Plumbing", "Not a good time this month but curious what the buyer looks like. Send details please.")),
  # 2 Due today
  dict(co="Alpine Pest Control", person="Jenna Whitaker", city="Orem", seq="email5", state="active", day0=3, tasks=run(3, [(2, 3, "call", 0, "pending")])),
  dict(co="Jordan River Cleaning", person="Sam Peterson", city="West Jordan", seq="email5", state="active", day0=7, tasks=run(7, [(2, 3, "call", -4, "done"), (5, 5, "call", -2, "done"), (6, 7, "call_company", 0, "pending")])),
  dict(co="Timpanogos Roofing", person="Lyle Nielsen", city="American Fork", seq="email5", state="active", day0=4, tasks=run(4, [(2, 3, "call", -1, "done"), (4, 4, "linkedin", 0, "pending")])),
  # 3 Not called yet (backup: no personal email sequence)
  dict(co="Oquirrh HVAC", person="Greg Stansfield", city="South Jordan", seq="backup"),
  dict(co="Silver Fork Paving", person="Dena Cox", city="Holladay", seq="backup"),
  dict(co="Bluff Street Auto", person="Mitch Dunn", city="St. George", seq="backup", ind="Auto repair"),
  # 4 Intro call scheduled
  dict(co="Cottonwood Electric", person="Paul Ricks", city="Taylorsville", status="intro_call_scheduled", callback="1 day 2 hours"),
  # 5 Callback interested / 6 busy
  dict(co="Millcreek Mechanical", person="Ana Reyes", city="Millcreek", status="callback_interested", callback="2 days"),
  dict(co="Deer Valley Movers", person="Chad Burton", city="Park City", status="busy_callback", callback="5 hours", ind="Moving"),
  dict(co="Pioneer Window Cleaning", person="Heidi Sorensen", city="Layton", status="busy_callback", callback="-3 hours"),
  # 7 No response
  dict(co="Granite Peak Concrete", person="Rich Tolman", city="Midvale", status="no_response"),
  # 8 In sequence (future steps only)
  dict(co="Emigration Tree Care", person="Wendy Judd", city="Salt Lake City", seq="email5", state="active", day0=1, tasks=run(1, [(2, 3, "call", 2, "pending"), (4, 4, "linkedin", 3, "pending")])),
  dict(co="Hogle Heating & Air", person="Brent Call", city="Bountiful", seq="email5", state="active", day0=2, tasks=run(2, [(2, 3, "call", 1, "pending"), (5, 5, "call", 3, "pending")])),
  # 9 Finished sequence
  dict(co="Lone Peak Septic", person="Ron Gappmayer", city="Highland", seq="email5", state="completed", day0=12, tasks=run(12, [(2, 3, "call", -9, "done"), (5, 5, "call", -7, "done"), (6, 7, "call_company", -5, "done")])),
  # 10 Dead number
  dict(co="Sego Lily Catering", person="Nora Bateman", city="Ogden", status="unable_to_contact", ind="Catering"),
  # 11 Not interested
  dict(co="Uinta Sign Works", person="Kyle Mecham", city="Kaysville", status="not_interested", ind="Signs"),
  dict(co="Zion Tile & Stone", person="Carla Hess", city="Springville", status="not_interested", ind="Flooring"),
]
andrew_rows = [
  dict(co="Wasatch Lawn Doctors", person="Lance Pugmire", city="Sandy", seq="email5", state="active", day0=5, tasks=run(5, [(2, 3, "call", -2, "pending")])),
  dict(co="Big Cottonwood Plumbing", person="Erin Walker", city="Cottonwood Heights", seq="email5", state="active", day0=3, tasks=run(3, [(2, 3, "call", 0, "pending")])),
  dict(co="Oak Hollow Cabinets", person="Gary Fillmore", city="Draper", seq="backup", ind="Cabinetry"),
  dict(co="Mountain West Glass", person="Lori Haws", city="Sandy", status="callback_interested", callback="1 day", ind="Glass"),
  dict(co="Tooele Valley Septic", person="Dean Packer", city="Tooele", status="not_interested"),
]

if __name__ == "__main__":
    lc = reset_list("DEMO Call sheet", CALEB); build(CALEB, lc, caleb_rows)
    la = reset_list("DEMO Lead sheet", ANDREW); build(ANDREW, la, andrew_rows)
    print("Caleb list", lc, q(f"select count(*) from dials where list_id='{lc}'")[0]["count"], "dials;",
          "replies:", q("select count(*) from email_messages where from_address like 'demo.%@example.com'")[0]["count"])
    print("Andrew list", la, q(f"select count(*) from dials where list_id='{la}'")[0]["count"], "dials")
