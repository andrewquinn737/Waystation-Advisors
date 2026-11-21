"""SQL copy_sentences()/copy_body_norm() must match js/copyLint.js bodySentences()/normBody() exactly.
Run: python3 test_sentence_parity.py"""
import sb, json, subprocess, os
CASES = [
 "Hi Pat,\n\nI run the buyer side for a pump distributor. We keep hearing owners in Utah want a quiet conversation.\n\nBest,\nCaleb",
 "Hello,\r\nThis is a CRLF email with several short bits. Worth a chat? Let me know when works for you today.\r\nThanks,\r\nCaleb Hong\r\nWaystation",
 "Hi Zoë,\n\nCafé owners in Montréal rarely sell through brokers anymore. Naïve outreach tends to get ignored by everyone.\n\nCheers,\nCaleb",
 "Dear Mr. O'Brien,\nYour company's growth caught our eye this year. We'd like to talk about what's next for you.\nRegards,\nCal",
 "Quick one: we represent a buyer with 40% more capital than usual – and it is looking in your space right now.",
 "Good morning Pat\n\nSee https://example.com/a-b?x=1 for details about our client. It is a family-owned firm with 12 locations.\n\nTalk soon,\nC",
 "Hi Pat, we saw the 2024 expansion... it looked impressive to everyone here! Does that seem right to you? Reply if so.",
 "Short.\nAlso short.\nThis line has exactly five words.\nThanks",
 "Hey Pat,\n\nUnder_score_words and 3.5x multiples are common in this industry sector today.\n\nBest regards,\nCaleb\nVP\nWaystation\nSLC\nUT\nextra",
 "Hi Pat,\n\nWe don't spam. We won't call twice. We aren't a broker, just a buyer's representative here.\n\nThank you,\nC",
 "Hi Pat,\n\n   Leading spaces here but a long enough sentence to count. \n\n\nAnother paragraph starts after blank lines here.\n\nKind regards,\nC",
 "Ça va? Très bien, merci pour votre temps aujourd'hui et demain. Über-cool Straße rules everywhere in Köln.\nBest,\nC",
 "Hi Pat,\n\nI'm reaching out with a ‘curly’ quote and “double curly” text that spans five words minimum.\n\nBest,\nCaleb",
 "No greeting here, just a body with a sentence that is long enough. Sign-off is absent too",
 "Hi Pat,\n\nBest,\nCaleb",
 "",
 "Hi Pat!\nTabs\tand\tspaces\tin\tthis\tsentence\tare\tcollapsed.\nThanks again,\nC",
 "Hi Pat,\n\nA 100% remote team, 24/7 support, and $5M revenue? That's what we look for in partners here.\n\nSincerely,\nCaleb",
 "Hi there,\n\nIs this still your email address? We tried calling your office last week and nobody picked up.\n\nBest,\nCaleb Hong, Partner",
 "Hi Pat,\n\nOne sentence per line but no punctuation at the end of any\nThis is the second such line of the email\nThanks,\nC",
 "Hi Pat,\n\nEnd.With.Dots.Inside words.like.this are kept together as tokens here. Trailing ellipsis follows right here…\n\nBest,\nC",
]
js = r"""
import {bodySentences, normBody} from '../../dealflow-app/supabase/functions/_shared/copyLint.js';
const cases = JSON.parse(process.argv[2]);
console.log(JSON.stringify(cases.map(c => ({s: bodySentences(c), b: normBody(c)}))));
"""
open("/tmp/_parity.mjs", "w").write(js) if False else None
here = os.path.dirname(os.path.abspath(__file__))
tmp = os.path.join(here, "_parity_tmp.mjs"); open(tmp, "w").write(js)
try:
    out = json.loads(subprocess.check_output(["node", tmp, json.dumps(CASES)], text=True))
finally:
    os.remove(tmp)
def lit(v): return "'" + v.replace("'", "''") + "'"
sql = "select i, copy_sentences(t) s, copy_body_norm(t) b from (values " + ",".join(f"({i},{lit(c)})" for i, c in enumerate(CASES)) + ") v(i,t) order by i"
rows = sb.test_sql(sql)
bad = 0
for r, j in zip(rows, out):
    sq = r["s"] if isinstance(r["s"], list) else json.loads(r["s"].replace("{", "[").replace("}", "]")) if r["s"] else []
    ok = sq == j["s"] and r["b"] == j["b"]
    if not ok:
        bad += 1; print("FAIL case", r["i"], "\n sql:", sq, repr(r["b"]), "\n js :", j["s"], repr(j["b"]))
print(f"{len(CASES) - bad}/{len(CASES)} parity cases passed" + ("" if not bad else " FAIL"))
