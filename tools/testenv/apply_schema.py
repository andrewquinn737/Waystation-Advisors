import sb, sys
stmts = open("schema_live.sql").read().split("\n--@@STMT@@\n")
errs = []
for pass_ in range(3):
    retry = []
    for s in (stmts if pass_ == 0 else errs_stmts):
        try: sb.test_sql("set check_function_bodies = off;\n" + s)
        except RuntimeError as e:
            m = str(e)
            if "already exists" in m: continue
            retry.append((s, m))
    errs_stmts = [s for s, _ in retry]
    print("pass", pass_, "failures", len(retry))
    if not retry: break
for s, m in retry: print("---", s[:150].replace("\n"," "), "\n   ", m[:250])
