"""Apply a migration file to the TEST project, then keep the sequence auto-sender PAUSED
(the migration schedules it as active, which is right for live but would send real test email).
Usage: python3 apply_migration.py ../../dealflow-app/supabase/migrations/20261120_email_sequences.sql [--leave-active]"""
import sb, sys
sb.test_sql(open(sys.argv[1]).read())
if "--leave-active" not in sys.argv:
    for j in sb.test_sql("select jobid from cron.job where jobname='sequence-dispatch'"):
        sb.test_sql(f"select cron.alter_job(job_id := {j['jobid']}, active := false)")
print(sb.test_sql("select jobname, active from cron.job where jobname like '%dispatch%'"))
