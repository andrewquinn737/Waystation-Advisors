"""Make TEST's privileges for anon/authenticated identical to LIVE's for every table, column and
function that exists on live. Uses has_*_privilege() (information_schema hides rows from the
read-only role). Objects that exist only in test (our migrations) are left as the migration set them."""
import sb
ROLES = ("anon", "authenticated")
TP = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")
CP = ("SELECT", "INSERT", "UPDATE", "REFERENCES")
rel = """select c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m')"""
tables = [r["t"] for r in sb.live_sql(rel)]
tsql = " union all ".join(f"select '{t}' t, '{g}' g, '{p}' p, has_table_privilege('{g}', 'public.\"{t}\"', '{p}') ok" for t in tables for g in ROLES for p in TP)
tgr = [r for r in sb.live_sql(tsql) if r["ok"]]
cols = sb.live_sql("""select c.relname t, a.attname col from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped""")
have = {(r["t"], r["g"], r["p"]) for r in tgr}
cgr = []
for i in range(0, len(cols), 60):
    part = cols[i:i+60]
    csql = " union all ".join(f"select '{c['t']}' t, '{c['col']}' col, '{g}' g, '{p}' p, has_column_privilege('{g}', 'public.\"{c['t']}\"', '{c['col']}', '{p}') ok"
                              for c in part for g in ROLES for p in CP if (c["t"], g, p) not in have)
    if csql: cgr += [r for r in sb.live_sql(csql) if r["ok"]]
fns = sb.live_sql("""select p.oid::regprocedure::text f,
  has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'""")
st = []
for t in tables: st.append(f'revoke all on public."{t}" from anon, authenticated;')
for r in tgr: st.append(f'grant {r["p"]} on public."{r["t"]}" to {r["g"]};')
grp = {}
for r in cgr: grp.setdefault((r["t"], r["g"], r["p"]), []).append(r["col"])
for (t, g, p), cs in grp.items(): st.append(f'grant {p} (' + ", ".join(f'"{c}"' for c in cs) + f') on public."{t}" to {g};')
for f in fns:
    st.append(f"revoke execute on function {f['f']} from public, anon, authenticated;")
    for g, ok in (("anon", f["a"]), ("authenticated", f["u"])):
        if ok: st.append(f"grant execute on function {f['f']} to {g};")
sb.test_sql("\n".join(st))
# verify: same answers on test as on live
mism = 0
chk = " union all ".join(f"select '{t}' t, '{g}' g, '{p}' p, has_table_privilege('{g}', 'public.\"{t}\"', '{p}') ok" for t in tables for g in ROLES for p in TP)
L = {(r["t"], r["g"], r["p"]): r["ok"] for r in sb.live_sql(chk)}; T = {(r["t"], r["g"], r["p"]): r["ok"] for r in sb.test_sql(chk)}
mism += sum(1 for k in L if L[k] != T.get(k))
print(f"tables {len(tables)}, table grants {len(tgr)}, column grants {len(cgr)}, functions {len(fns)}; table-privilege mismatches: {mism}")
print("password readable by authenticated on test:", sb.test_sql("select has_column_privilege('authenticated','public.email_accounts','password','SELECT') x")[0]["x"])
