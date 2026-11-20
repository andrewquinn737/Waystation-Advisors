"""Rebuild LIVE public-schema DDL from the catalog (read-only) -> schema_live.sql"""
import sb, json
Q = sb.live_sql
out = ["set check_function_bodies = off;", "create schema if not exists extensions;"]
for r in Q("select extname from pg_extension where extname not in ('plpgsql') order by 1"):
    out.append(f'create extension if not exists "{r["extname"]}"' + (" with schema extensions" if r["extname"] in ("uuid-ossp","pgcrypto","pg_stat_statements") else "") + ";")
# enums
for r in Q("""select t.typname, string_agg(quote_literal(e.enumlabel), ',' order by e.enumsortorder) labels
  from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace
  where n.nspname='public' group by 1"""):
    out.append(f'create type public."{r["typname"]}" as enum ({r["labels"]});')
# sequences not owned by identity/serial
for r in Q("""select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='S'"""):
    out.append(f'create sequence if not exists public."{r["relname"]}";')
# tables
tables = [r["relname"] for r in Q("select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('r','p') order by 1")]
cols = Q("""select c.relname t, a.attname col, format_type(a.atttypid,a.atttypmod) typ, a.attnotnull nn,
  pg_get_expr(d.adbin,d.adrelid) def, a.attidentity ident, a.attgenerated gen
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped order by c.relname, a.attnum""")
for t in tables:
    lines = []
    for c in [c for c in cols if c["t"] == t]:
        s = f'  "{c["col"]}" {c["typ"]}'
        if c["gen"] == "s": s += f' generated always as ({c["def"]}) stored'
        elif c["ident"]: s += " generated " + ("always" if c["ident"] == "a" else "by default") + " as identity"
        elif c["def"]: s += f' default {c["def"]}'
        if c["nn"]: s += " not null"
        lines.append(s)
    out.append(f'create table public."{t}" (\n' + ",\n".join(lines) + "\n);")
cons = Q("""select c.relname t, con.conname, con.contype, pg_get_constraintdef(con.oid) def
  from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and con.contype in ('p','u','c','f','x') order by (con.contype='f'), 1, 2""")
for c in cons:
    out.append(f'alter table public."{c["t"]}" add constraint "{c["conname"]}" {c["def"]};')
for r in Q("""select pg_get_indexdef(i.indexrelid) d from pg_index i join pg_class c on c.oid=i.indrelid
  join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
  and not exists (select 1 from pg_constraint k where k.conindid=i.indexrelid)"""):
    out.append(r["d"] + ";")
for r in Q("select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by p.proname"):
    out.append(r["d"].rstrip() + ";")
for r in Q("select c.relname, pg_get_viewdef(c.oid) d, c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('v','m')"):
    out.append(f'create {"materialized " if r["relkind"]=="m" else ""}view public."{r["relname"]}" as {r["d"]}')
for r in Q("""select pg_get_triggerdef(t.oid) d from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal"""):
    out.append(r["d"] + ";")
for r in Q("""select pg_get_triggerdef(t.oid) d from pg_trigger t join pg_class c on c.oid=t.tgrelid
  join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and not t.tgisinternal"""):
    out.append(r["d"] + ";")
for r in Q("select relname, relrowsecurity, relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind in ('r','p') and relrowsecurity"):
    out.append(f'alter table public."{r["relname"]}" enable row level security;')
for p in Q("select * from pg_policies where schemaname='public'"):
    s = f'create policy "{p["policyname"]}" on public."{p["tablename"]}" as {p["permissive"]} for {p["cmd"]} to {",".join(p["roles"]) if isinstance(p["roles"],list) else p["roles"].strip("{}")}'
    if p["qual"]: s += f' using ({p["qual"]})'
    if p["with_check"]: s += f' with check ({p["with_check"]})'
    out.append(s + ";")
# table grants
for r in Q("""select table_name, grantee, string_agg(privilege_type, ', ') privs from information_schema.role_table_grants
  where table_schema='public' and grantee in ('anon','authenticated','service_role') group by 1,2"""):
    out.append(f'grant {r["privs"]} on public."{r["table_name"]}" to {r["grantee"]};')
open("schema_live.sql", "w").write("\n--@@STMT@@\n".join(out) + "\n")
# side info
json.dump({
  "buckets": Q("select id, name, public, file_size_limit, allowed_mime_types from storage.buckets"),
  "storage_policies": Q("select * from pg_policies where schemaname='storage'"),
  "cron": Q("select jobname, schedule, command from cron.job"),
  "realtime": Q("select tablename from pg_publication_tables where pubname='supabase_realtime'"),
  "rowcounts": Q("select relname, n_live_tup from pg_stat_user_tables where schemaname='public' order by 1"),
  "app_secret_names": Q("select * from public.app_secrets limit 0") ,
}, open("live_side.json", "w"), indent=1, default=str)
print(len(tables), "tables;", len(out), "statements")
