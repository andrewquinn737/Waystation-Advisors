import json, urllib.request, urllib.error, test_sequences as T
q=T.q
sent=q("""select m.subject, lower(m.to_addresses->0->>'address') rcpt, a.email_address sender from email_messages m join email_accounts a on a.id=m.account_id where direction='outbound' and subject like 'Inbox check %'""")
arr={r['rcpt'] for r in q("""select lower(a.email_address) rcpt from email_messages m join email_accounts a on a.id=m.account_id where direction='inbound' and subject like 'Inbox check %' and m.created_at>now()-interval '6 hours'""")}
acc={r['email']:r['id'] for r in q("select lower(email_address) email,id from email_accounts")}
miss=[s for s in sent if s['rcpt'] not in arr]
print("sent",len(sent),"arrived-in-db",len(sent)-len(miss),"missing",len(miss))
def live(aid,kind):
    r=urllib.request.Request(T.URL+"/functions/v1/email-live",method="POST",data=json.dumps({"action":"list","account_id":aid,"kind":kind,"limit":40}).encode(),
      headers={"apikey":T.ANON,"Authorization":"Bearer "+T.login("test.admin@example.com"),"Content-Type":"application/json"})
    try: return json.load(urllib.request.urlopen(r,timeout=60))
    except urllib.error.HTTPError as e: return {"err":e.read().decode()[:150]}
res={"inbox":0,"spam":0,"none":0,"err":0}
for s in miss:
    out="none"
    for k in ("inbox","spam"):
        d=live(acc[s['rcpt']],k)
        if "err" in d: res["err"]+=1; print(s['rcpt'],k,d['err']); break
        if any(s['subject'] in (i.get('subject') or '') for i in d.get('items',[])): out=k; break
    res[out]+=1
    print(s['rcpt'],out)
print(res)
