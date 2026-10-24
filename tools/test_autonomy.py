"""Earned autonomy and the close, on the dev history: answer every spot check the
way the truth says, watch inspection levels move, then audit and close January."""
import json

from stdb import Client, admin_token, identity_arg, new_identity
import dev_history

dev_history.main(10)
ids = json.load(open("../data/dev/identities.json"))
admin = Client(admin_token(), "admin")
lee, dana = Client(ids["Lee"]["token"], "Lee"), Client(ids["Dana"]["token"], "Dana")
key = {e["subject"]: e for e in json.load(open("../data/dev/answer_key.json"))["entries"]}

answered = 0
for a in admin.sql("SELECT id, kind, subject, status, evidence FROM ask"):
    if a["status"] != "open" or not a["kind"].startswith("spot_check:"):
        continue
    truth = key.get(a["subject"])
    decided = json.loads(a["evidence"])["decided"]
    right = truth is None or (truth["expected"] == "flag_audit") == (decided in ("flag_audit", "ask_consultant"))
    who = lee if a["kind"] == "spot_check:underreport" else dana
    who.call("answer_ask", a["id"], "correct" if right else "flag_audit", "checked against the store's supply orders")
    answered += 1
print(f"spot checks answered: {answered}")
for r in sorted(admin.sql("SELECT key, decisions, checked, errors, state, sample_rate FROM rule_stat"), key=lambda r: r["key"]):
    print(f"  {r['key']:<28} decisions {r['decisions']:>3}  checked {r['checked']:>2}  wrong {r['errors']:>2}  {r['state']:<10} sample {r['sample_rate']:.0%}")
for x in admin.sql("SELECT command, params, outcome FROM activity WHERE kind = 'reliability'"):
    p = json.loads(x["params"])
    print(f"  inspection {p['rule']}: {p['from']} -> {p['to']} (wrong {p['errors']}/{p['checked']}, 95% bounds {p['lower95']:.3f}..{p['upper95']:.3f}, tolerable {p['tolerable']})")

ident, tok = new_identity()
admin.call("bind_role", identity_arg(ident), "auditor", "auditor")
auditor = Client(tok, "auditor")
print(dana.call("close_period", "2026-01", check=False))
auditor.call("record_opinion", "2026-01", "clean", 0, 125000, 500000, 12, json.dumps({"note": "test opinion"}))
print(dana.call("close_period", "2026-01", check=False))
for c in admin.sql("SELECT period, closed_by, certificate_hash, certificate FROM period_close"):
    cert = json.loads(c["certificate"])
    print(f"closed {c['period']} by {c['closed_by']}: {c['certificate_hash'][:16]}…, trial balance lines {len(cert['trialBalance'])}, opinion {cert['auditorOpinion']['opinion']}, chain head {cert['chain']['head'][:12]}…")
