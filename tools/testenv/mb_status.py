import test_sequences as T
q=T.q
D="dial_id in (select id from dials where list_id in (select id from dial_lists where name like 'MAILBOX TEST%'))"
print(q(f"select status,count(*) from scheduled_emails where {D} group by 1"))
print("errors:", q(f"select split_part(a.email_address,'@',2) dom, left(s.error,140) err, count(*) from scheduled_emails s join email_accounts a on a.id=s.account_id where {D} and s.error is not null group by 1,2 order by 3 desc limit 12"))
print("sent boxes:", q(f"select count(distinct account_id) n from scheduled_emails where {D} and status='sent'"))
print("arrived (inbound synced):", q("select count(*) n, count(distinct account_id) boxes from email_messages where direction='inbound' and subject like 'Inbox check %'"))
print("seq states:", q("select seq_state,count(*) from dials where list_id in (select id from dial_lists where name like 'MAILBOX TEST%') group by 1"))
print("bounces:", q("select count(*) from email_messages where direction='inbound' and (from_address ilike '%mailer-daemon%' or from_address ilike 'postmaster%' or subject ilike 'undeliverable%' or subject ilike 'delivery status%') and created_at > now() - interval '3 hours'"))
