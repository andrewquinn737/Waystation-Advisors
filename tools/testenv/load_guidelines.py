"""Load docs/copy_guidelines/*.md into the TEST project's copy_guidelines table (the single source
every in-app AI path reads). Usage: python3 load_guidelines.py"""
import sb, hashlib, pathlib
root = pathlib.Path(__file__).resolve().parents[2] / "docs" / "copy_guidelines"
for mandate, fn in (("ma", "ma_seller.md"), ("data", "data_sales.md")):
    body = (root / fn).read_text()
    ver = hashlib.sha256(body.encode()).hexdigest()[:12]
    lit = "'" + body.replace("'", "''") + "'"
    sb.test_sql(f"insert into copy_guidelines (mandate, body, version) values ('{mandate}', {lit}, '{ver}') "
                f"on conflict (mandate) do update set body = excluded.body, version = excluded.version, updated_at = now()")
    print(mandate, fn, len(body), "chars, version", ver)
