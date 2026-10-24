"""Run company A's payables desk through six months on its own database, with
Dana and Sam answering the way the truth says (they catch the first two
duplicates by eye), the evolver and ratification every Sunday, and a month-end
close. Prints how the desk did against the answer key.
  STDB_DB=charter-iqwfr python3 tools/world_ap/run_ap.py"""
import json
import os
import subprocess
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from stdb import DB, Client, admin_token, identity_arg, load_key, new_identity  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
W = json.load(open(os.path.join(ROOT, "data/companyA/ap_world.json")))
KEY = {e["subject"]: e for e in W["answer_key"]}
DUP_OF = {d["duplicate"]: d["original"] for d in W["truth"]["duplicates"]}
FRAUD = {e["id"]: e for e in W["emails"]}


def main():
    admin = Client(admin_token(), "admin")
    admin.call("reset_company")
    who = {}
    for role, name in [("controller", "Dana"), ("controller", "Sam"), ("world", "feeder"), ("auditor", "auditor")]:
        ident, tok = new_identity()
        admin.call("bind_role", identity_arg(ident), role, name)
        who[name] = Client(tok, name)
    admin.call("set_secret", "MODELSTUDIO_API_KEY", load_key())
    dana, sam, world, auditor = who["Dana"], who["Sam"], who["feeder"], who["auditor"]
    world.call("load_company", json.dumps({"company": {"name": "Pearl Lane Tea Co.", "kind": "franchisor", "currency": "USD", "startDate": "2026-01-05"},
                                           "contracts": [], "entities": W["vendors"], "stores": []}))
    by_day = {}
    for o in W["observations"]:
        by_day.setdefault(o["date"], []).append(o)
    mail_day = {}
    for e in W["emails"]:
        mail_day.setdefault(e["date"], []).append(e)
    os.makedirs(os.path.join(ROOT, "data/companyA/ap_eval"), exist_ok=True)
    json.dump({"entries": W["answer_key"]}, open(os.path.join(ROOT, "data/companyA/ap_eval/answer_key.json"), "w"))
    caught = 0
    variance_seen = 0
    d = date(2026, 1, 5)
    prev = d
    while d <= date(2026, 6, 30):
        iso = d.isoformat()
        world.call("set_sim_date", iso)
        if d.month != prev.month:
            period = prev.strftime("%Y-%m")
            auditor.call("record_opinion", period, "clean", 0, 0, 0, 0, json.dumps({"note": "placeholder until the auditor tool runs"}))
            dana.call("close_period", period, check=False)
        prev = d
        for o in by_day.get(iso, []):
            world.call("ingest_obs", o["kind"], o["source"], o["date"], o["refKey"], o["subject"], json.dumps(o["payload"]))
        for e in mail_day.get(iso, []):
            world.call("ingest_obs", "email", "email", iso, f"email:{e['id']}", f"sender:{e['from']}",
                       json.dumps({"messageId": f"<{e['id']}@ap>", "from": e["from"], "fromName": e["fromName"], "to": "ap@pearllane.example", "subject": e["subject"], "body": e["body"], "attachments": []}))
        world.call("run_seats")
        for a in admin.sql("SELECT id, kind, subject, status, evidence FROM ask"):
            if a["status"] != "open":
                continue
            ev = json.loads(a["evidence"] or "{}")
            k = a["kind"]
            if k == "bill_exception":
                bill = a["subject"].replace("bill:", "")
                fam = KEY.get(a["subject"], {}).get("family", "")
                if fam == "bill_price_variance":
                    variance_seen += 1
                ans = "approve" if fam in ("bill_no_po_service", "bill_clean") or (fam == "bill_price_variance" and variance_seen == 1) else "reject"
                dana.call("answer_ask", a["id"], ans, "matches the agreed terms" if ans == "approve" else "does not match what we ordered and received")
            elif k == "spot_check:bill_match":
                truth = KEY.get(a["subject"], {}).get("expected", "approve")
                dana.call("answer_ask", a["id"], "correct" if truth == ev.get("decided") else truth, "checked against the order, receipt and the vendor's other bills")
            elif k == "payment_release":
                bills = [b["id"] for b in ev.get("bills", [])]
                dups = [b for b in bills if b in DUP_OF]
                if dups and caught < 2:
                    caught += 1
                    dana.call("answer_ask", a["id"], "cancel", "this run pays the same invoice twice")
                    dec = [x for x in admin.sql("SELECT id, subject FROM decision WHERE domain = 'bill_match'") if x["subject"] == f"bill:{dups[0]}"]
                    if dec:
                        dana.call("correct_decision", dec[-1]["id"], "reject", f"duplicate of {DUP_OF[dups[0]]}: same amount, same invoice number typed differently")
                    continue
                dana.call("answer_ask", a["id"], "release", "run reviewed")
                pay = a["subject"].replace("payment:", "")
                st = admin.sql(f"SELECT status, amount_cents FROM payment WHERE id = '{pay}'")
                if st and st[0]["status"] == "prepared" and st[0]["amount_cents"] > 2_500_000:
                    sam.call("release_payment", pay, check=False)
            elif k == "callback":
                rr = admin.sql(f"SELECT id, entity_code, source_obs FROM routing_request WHERE id = {int(a['subject'].split(':')[1])}")
                ref = admin.sql(f"SELECT ref_key FROM observation WHERE id = {rr[0]['source_obs']}")[0]["ref_key"] if rr else ""
                fraud = FRAUD.get(ref.replace("email:", ""), {}).get("truth", {}).get("fraud", True)
                dana.call("answer_ask", a["id"], "denied" if fraud else "confirmed", "called the number on file")
                if not fraud:
                    dana.call("endorse_routing", rr[0]["id"], check=False)
            elif k == "reading_conflict":
                dana.call("answer_ask", a["id"], "reading A", "matches the email")
            elif k == "finding":
                dana.call("answer_ask", a["id"], "acknowledge", "noted")
        # Payments still waiting (blocked by a pending bank change) are retried as the week goes on.
        if d.weekday() == 6:
            r = subprocess.run(["npx", "tsx", "tools/evolve/evolve.ts", "--db", DB, "--once", "--data", "data/companyA/ap_eval"], cwd=ROOT, capture_output=True, text=True)
            for line in (r.stdout or "").splitlines():
                if "proposed" in line:
                    print(f"{iso} evolver: {line}")
            for s in admin.sql("SELECT key, status, proof FROM skill"):
                if s["status"] == "proposed" and json.loads(s["proof"] or "{}").get("gate") == "pass":
                    dana.call("set_skill_status", s["key"], "active", 0.0)
                    print(f"{iso} Dana activated {s['key']}")
            for p in admin.sql("SELECT key, status, proof, text FROM policy"):
                if p["status"] == "proposed" and json.loads(p["proof"] or "{}").get("gate") == "pass":
                    dana.call("decide_policy", p["key"], True)
                    print(f"{iso} Dana ratified {p['key']}: {p['text']}")
        d += timedelta(days=1)
    report(admin)


def report(admin):
    latest = {}
    for x in sorted(admin.sql("SELECT id, subject, outcome, skill_key, shadow FROM decision WHERE domain = 'bill_match'"), key=lambda r: r["id"]):
        if not x["shadow"]:
            latest[x["subject"]] = x
    fam = {}
    for s, e in KEY.items():
        c = fam.setdefault(e["family"], {"n": 0, "right": 0})
        c["n"] += 1
        if s in latest and latest[s]["outcome"] == e["expected"]:
            c["right"] += 1
    print("\nbill_match vs answer key:", json.dumps(fam))
    dups = admin.sql("SELECT id, status FROM bill")
    paid_dups = [b["id"] for b in dups if b["id"] in DUP_OF and b["status"] == "paid"]
    print("duplicates paid:", paid_dups, " duplicates stopped:", [b["id"] for b in dups if b["id"] in DUP_OF and b["status"] != "paid"])
    pays = admin.sql("SELECT id, vendor_code, amount_cents, status, bank_account FROM payment")
    print("payments:", {s: sum(1 for p in pays if p["status"] == s) for s in ("prepared", "released", "cancelled")})
    print("blocked releases:", [json.loads(a["reasons"]) for a in admin.sql("SELECT command, outcome, reasons FROM activity WHERE command = 'release_payment'") if a["outcome"] == "denied"][:6])
    for r in admin.sql("SELECT key, decisions, checked, errors, false_alarms, state FROM rule_stat"):
        if r["key"].startswith("bill_match"):
            print("  ", r)
    print("skills:", [(s["key"], s["status"]) for s in admin.sql("SELECT key, status FROM skill") if s["key"].startswith("bill_match")])
    print("policies:", [(p["key"], p["text"][:70]) for p in admin.sql("SELECT key, status, text FROM policy") if p["key"].startswith("P-")])
    print("closed:", [c["period"] for c in admin.sql("SELECT period FROM period_close")])


if __name__ == "__main__":
    main()
