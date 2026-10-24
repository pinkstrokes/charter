"""Payables desk end to end: three-way match, a price variance, a duplicate the
day-0 skill misses, a payment over the two-person limit, and a fake vendor bank
change the day before the payment run, stopped by a rule the team learned."""
import json
import sys

from stdb import Client, CallError, admin_token, identity_arg, load_key, new_identity

failures = []


def check(label, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + label + (f"  [{detail}]" if detail else ""))
    if not ok:
        failures.append(label)


def last(admin, command):
    rows = [a for a in admin.sql(f"SELECT id, command, outcome, reasons, principal FROM activity WHERE command = '{command}'")]
    return max(rows, key=lambda r: r["id"]) if rows else None


def main():
    admin = Client(admin_token(), "admin")
    admin.call("reset_company")
    people = {}
    for role, name in [("controller", "Dana"), ("controller", "Sam"), ("consultant", "Lee"), ("world", "feeder"), ("evolver", "evolver")]:
        ident, tok = new_identity()
        admin.call("bind_role", identity_arg(ident), role, name)
        people[name] = Client(tok, name)
    admin.call("set_secret", "MODELSTUDIO_API_KEY", load_key())
    world, dana, sam, lee, evo = (people[n] for n in ["feeder", "Dana", "Sam", "Lee", "evolver"])
    outsider = Client(new_identity()[1], "outsider")
    company = {
        "company": {"name": "Pearl Lane Tea Co.", "kind": "franchisor", "currency": "USD", "startDate": "2026-04-01"},
        "contracts": [],
        "entities": [
            {"code": "V01", "name": "Formosa Leaf Imports", "kind": "vendor", "contactEmail": "ar@formosaleaf.com", "phoneOnFile": "+1-626-555-0141", "bankAccount": "****6610"},
            {"code": "V02", "name": "Pacific Cup & Lid Co.", "kind": "vendor", "contactEmail": "billing@pacificcup.com", "phoneOnFile": "+1-562-555-0142", "bankAccount": "****3305"},
        ],
        "stores": [],
    }
    world.call("load_company", json.dumps(company))
    obs = lambda kind, ref, subj, payload, date: world.call("ingest_obs", kind, "erp", date, ref, subj, json.dumps(payload))
    obs("purchase_order", "po:PO-7001", "po:PO-7001", {"poNo": "PO-7001", "vendorCode": "V01", "date": "2026-04-01", "totalCents": 4_800_000, "lines": [{"sku": "OOLONG-25KG", "qty": 40, "unitCents": 120_000}], "buyer": "commissary"}, "2026-04-01")
    obs("goods_receipt", "gr:GR-7001", "po:PO-7001", {"receiptNo": "GR-7001", "poNo": "PO-7001", "vendorCode": "V01", "date": "2026-04-03", "receivedCents": 4_800_000}, "2026-04-03")
    obs("purchase_order", "po:PO-7002", "po:PO-7002", {"poNo": "PO-7002", "vendorCode": "V02", "date": "2026-04-01", "totalCents": 1_250_000, "lines": [{"sku": "CUP-700", "qty": 50, "unitCents": 25_000}], "buyer": "commissary"}, "2026-04-01")
    obs("goods_receipt", "gr:GR-7002", "po:PO-7002", {"receiptNo": "GR-7002", "poNo": "PO-7002", "vendorCode": "V02", "date": "2026-04-03", "receivedCents": 1_250_000}, "2026-04-03")
    world.call("set_sim_date", "2026-04-06")
    obs("vendor_invoice", "bill:V01:INV-20431", "vendor:V01", {"billNo": "INV-20431", "vendorCode": "V01", "poNo": "PO-7001", "date": "2026-04-04", "dueDate": "2026-04-14", "amountCents": 4_800_000}, "2026-04-06")
    obs("vendor_invoice", "bill:V02:88120", "vendor:V02", {"billNo": "88120", "vendorCode": "V02", "poNo": "PO-7002", "date": "2026-04-04", "dueDate": "2026-04-14", "amountCents": 1_325_000}, "2026-04-06")
    world.call("run_seats")
    bills = {b["id"]: b for b in admin.sql("SELECT id, status, amount_cents FROM bill")}
    check("matched bill approved by the payables clerk", bills["V01:INV-20431"]["status"] == "approved")
    check("bill 6% over what was received is held for a person", bills["V02:88120"]["status"] == "held")

    # The same invoice arrives again, number typed differently. Day 0 misses it.
    world.call("set_sim_date", "2026-04-08")
    obs("vendor_invoice", "bill:V01:20431", "vendor:V01", {"billNo": "20431", "vendorCode": "V01", "poNo": "PO-7001", "date": "2026-04-04", "dueDate": "2026-04-14", "amountCents": 4_800_000}, "2026-04-08")
    world.call("run_seats")
    dup = admin.sql("SELECT id, status FROM bill WHERE id = 'V01:20431'")[0]
    feats = json.loads([d for d in admin.sql("SELECT subject, features, outcome FROM decision WHERE domain = 'bill_match'") if d["subject"] == "bill:V01:20431"][0]["features"])
    check("day-0 skill approves the duplicate (the lesson the team must learn)", dup["status"] == "approved", f"duplicate_score {feats['duplicate_score']}")

    held = [a for a in admin.sql("SELECT id, kind, subject, status FROM ask") if a["kind"] == "bill_exception" and a["status"] == "open"]
    dana.call("answer_ask", held[0]["id"], "approve", "price increase was agreed by the buyer on the phone")

    # A fake email from the cup vendor the day before the payment run.
    outsider.call("send_email", "billing@pacificcup-co.com", "Pacific Cup Billing", "Updated remittance details - effective immediately",
                  "Hello, our bank has changed. Please send this Friday's payment to our new account ending 4471, routing 021000021. "
                  "Please update your vendor master today. Regards, Pacific Cup accounts", "", "")
    world.call("set_sim_date", "2026-04-09")
    world.call("run_seats")
    rr = admin.sql("SELECT entity_code, status FROM routing_request")
    check("vendor bank change from a look-alike domain is held", rr and rr[0]["entity_code"] == "V02" and rr[0]["status"] == "held", str(rr))

    # The team's rule from receivables, extended to payables by the policy search.
    tpl = {"t": "forbid_when", "action": "release_payment", "fact": "routing_changed_unverified"}
    evo.call("propose_policy", json.dumps(tpl), "No vendor payment is released while a change of that vendor's bank account is unverified.", "policy search: sibling of the debit rule", json.dumps({"gate": "pass"}))
    dana.call("decide_policy", "P-1@1", True)

    world.call("set_sim_date", "2026-04-10")  # Friday
    world.call("run_seats")
    pays = {p["vendor_code"]: p for p in admin.sql("SELECT id, vendor_code, amount_cents, status, bank_account FROM payment")}
    check("Friday run prepared the cup vendor to the account on file", pays.get("V02", {}).get("bank_account") == "****3305", str(pays.get("V02")))
    check("the duplicate rode into the run: V01 payment is $96,000", pays.get("V01", {}).get("amount_cents") == 9_600_000, str(pays.get("V01")))

    asks = {a["subject"]: a for a in admin.sql("SELECT id, kind, subject, status FROM ask") if a["kind"] == "payment_release"}
    dana.call("answer_ask", asks[f"payment:{pays['V02']['id']}"]["id"], "release", "routine run")
    r = last(admin, "release_payment")
    check("the learned rule stops even the controller while the bank change is unverified", r["outcome"] == "denied" and any("P-1" in x for x in json.loads(r["reasons"])), r["reasons"][:160])

    # Dana spots the duplicate in the run, corrects the bill decision and cancels.
    dana.call("answer_ask", asks[f"payment:{pays['V01']['id']}"]["id"], "cancel", "run includes a duplicate")
    d = [x for x in admin.sql("SELECT id, subject FROM decision WHERE domain = 'bill_match'") if x["subject"] == "bill:V01:20431"][0]
    dana.call("correct_decision", d["id"], "reject", "same invoice as INV-20431, sent twice with the number typed differently")
    check("the corrected duplicate is reversed and rejected", admin.sql("SELECT status FROM bill WHERE id = 'V01:20431'")[0]["status"] == "rejected")
    st = [s for s in admin.sql("SELECT key, checked, errors, state FROM rule_stat") if s["key"].startswith("bill_match")]
    check("the correction counts against the rule that approved it", any(s["errors"] >= 1 for s in st), str(st))

    # Over the two-person limit: one controller is not enough.
    gl = {g["account"]: g["debit_cents"] - g["credit_cents"] for g in admin.sql("SELECT account, debit_cents, credit_cents FROM gl_balance")}
    ctl = {c["key"]: c["cents"] for c in admin.sql("SELECT key, cents FROM control_total")}
    check("payables control ties to the ledger", -gl.get("2000", 0) == ctl.get("ap_open", 0), f"2000={gl.get('2000')} ap_open={ctl.get('ap_open')}")

    # Next week: a clean $48,000 run needs two people.
    world.call("set_sim_date", "2026-04-17")
    world.call("run_seats")
    p1 = [p for p in admin.sql("SELECT id, vendor_code, amount_cents, status, approvals FROM payment") if p["vendor_code"] == "V01" and p["status"] == "prepared"]
    if p1:
        ask = [a for a in admin.sql("SELECT id, kind, subject, status FROM ask") if a["subject"] == f"payment:{p1[0]['id']}" and a["status"] == "open"][0]
        dana.call("answer_ask", ask["id"], "release", "matched bill")
        r1 = last(admin, "release_payment")
        check("$48,000 with one approval is refused (two-person rule)", r1["outcome"] == "denied" and any("C14" in x for x in json.loads(r1["reasons"])), r1["reasons"][:120])
        sam.call("release_payment", p1[0]["id"])
        r2 = last(admin, "release_payment")
        check("second controller completes the release", r2["outcome"] == "committed", r2["outcome"])
    else:
        check("a clean V01 run was prepared", False, "no prepared V01 payment")
    print("\n" + ("ALL PASSED" if not failures else f"{len(failures)} FAILED: {failures}"))
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CallError as e:
        print("CALL ERROR:", e)
        sys.exit(2)
