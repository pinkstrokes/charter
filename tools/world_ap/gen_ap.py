"""Company A's payables desk for 2026-01-05 .. 2026-06-28: six vendors, weekly
purchase orders, receipts and bills, plus planted duplicates, price variances,
short shipments, standing no-PO service bills and vendor bank-change attacks.
Writes data/companyA/ap_world.json: {vendors, observations: [...], emails: [...],
answer_key: [...], truth: {...}}. Deterministic for a given --seed."""
import argparse
import hashlib
import json
import os
import random
from datetime import date, timedelta

START, END = date(2026, 1, 5), date(2026, 6, 28)
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")

VENDORS = [
    # code, name, contact, phone, account, sku, unit cents, weekly units (lo, hi)
    ("V01", "Formosa Leaf Imports", "ar@formosaleaf.com", "+1-626-555-0141", "****6610", "OOLONG-25KG", 120_000, (28, 46)),
    ("V02", "Pacific Cup & Lid Co.", "billing@pacificcup.com", "+1-562-555-0142", "****3305", "CUP-700-CASE", 25_000, (34, 58)),
    ("V03", "Golden Tapioca Supply", "orders@goldentapioca.com", "+1-408-555-0143", "****9184", "PEARL-20KG", 18_500, (36, 60)),
    ("V04", "Bay Area Dairy Co-op", "accounts@bayareadairy.coop", "+1-510-555-0144", "****2077", "MILK-CASE", 4_200, (110, 180)),
    ("V05", "CleanPro Facilities", "invoices@cleanprofacilities.com", "+1-415-555-0145", "****5521", "", 0, (0, 0)),
    ("V06", "Signal Marketing Group", "finance@signalmktg.com", "+1-213-555-0146", "****8840", "CAMPAIGN", 1_450_000, (1, 1)),
]


def split_of(subject):
    h = int(hashlib.sha256(subject.encode()).hexdigest(), 16) % 100
    return "train" if h < 50 else "val" if h < 75 else "test"


def main(seed):
    rng = random.Random(seed)
    obs, emails, key = [], [], []
    truth = {"duplicates": [], "price_variance": [], "short_shipment": [], "no_po": [], "bank_change_fraud": [], "bank_change_legit": []}
    bill_seq = {v[0]: rng.randint(20000, 40000) for v in VENDORS}

    def bill_no(v, style):
        n = bill_seq[v]
        bill_seq[v] += rng.randint(1, 4)
        return {"INV": f"INV-{n}", "PC": f"PC-{n}", "plain": f"{n}", "GT": f"GT{n}", "BAD": f"BAD/{n}", "SMG": f"SMG-2026-{n}"}[style]

    style = {"V01": "INV", "V02": "PC", "V03": "GT", "V04": "BAD", "V05": "INV", "V06": "SMG"}
    week = 0
    d = START
    duplicates_left = {4: "V01", 9: "V02", 14: "V04", 19: "V01"}  # week -> vendor that resubmits a bill
    variance_weeks = {6, 12, 20}
    short_weeks = {8, 15, 22}
    while d <= END:
        monday = d
        for code, name, _, _, _, sku, unit, (lo, hi) in VENDORS:
            if code == "V05":
                continue
            if code == "V06" and week % 13 != 2:
                continue
            qty = rng.randint(lo, hi) if hi else 0
            po = f"PO-{monday:%y%m%d}-{code}"
            total = qty * unit
            obs.append({"date": monday.isoformat(), "kind": "purchase_order", "source": "erp", "refKey": f"po:{po}", "subject": f"po:{po}",
                        "payload": {"poNo": po, "vendorCode": code, "date": monday.isoformat(), "totalCents": total, "lines": [{"sku": sku, "qty": qty, "unitCents": unit}], "buyer": "commissary"}})
            received_qty = qty
            if code == "V02" and week in short_weeks:
                received_qty = int(qty * rng.uniform(0.85, 0.94))
            rdate = monday + timedelta(days=3)
            obs.append({"date": rdate.isoformat(), "kind": "goods_receipt", "source": "erp", "refKey": f"gr:{po}", "subject": f"po:{po}",
                        "payload": {"receiptNo": f"GR-{po[3:]}", "poNo": po, "vendorCode": code, "date": rdate.isoformat(), "receivedCents": received_qty * unit}})
            bdate = rdate + timedelta(days=rng.randint(1, 4))
            amount = total
            family = "clean"
            if code == "V03" and week in variance_weeks:
                amount = int(total * rng.uniform(1.04, 1.08) / 100) * 100
                family = "price_variance"
            if code == "V02" and week in short_weeks:
                family = "short_shipment"
            bn = bill_no(code, style[code])
            bid = f"{code}:{bn}"
            obs.append({"date": bdate.isoformat(), "kind": "vendor_invoice", "source": "erp", "refKey": f"bill:{bid}", "subject": f"vendor:{code}",
                        "payload": {"billNo": bn, "vendorCode": code, "poNo": po, "date": bdate.isoformat(), "dueDate": (bdate + timedelta(days=30)).isoformat(), "amountCents": amount}})
            expected = "approve" if family == "clean" else "hold_exception"
            if family == "price_variance":
                truth["price_variance"].append(bid)
            if family == "short_shipment":
                truth["short_shipment"].append(bid)
            key.append({"caseId": f"ap-{bid}", "family": f"bill_{family}", "split": split_of(f"bill:{bid}"), "subject": f"bill:{bid}", "truth": {"amountCents": amount, "po": po}, "expected": expected})
            if duplicates_left.get(week) == code:
                again = bn.replace("INV-", "").replace("PC-", "PC") if code != "V04" else bn.replace("BAD/", "BAD-")
                if again == bn:
                    again = bn + " "
                ddate = bdate + timedelta(days=rng.randint(2, 6))
                did = f"{code}:{again.strip()}"
                obs.append({"date": ddate.isoformat(), "kind": "vendor_invoice", "source": "erp", "refKey": f"bill:{did}", "subject": f"vendor:{code}",
                            "payload": {"billNo": again.strip(), "vendorCode": code, "poNo": po, "date": bdate.isoformat(), "dueDate": (bdate + timedelta(days=30)).isoformat(), "amountCents": amount}})
                truth["duplicates"].append({"duplicate": did, "original": bid})
                key.append({"caseId": f"ap-{did}", "family": "bill_duplicate", "split": split_of(f"bill:{did}"), "subject": f"bill:{did}", "truth": {"duplicateOf": bid}, "expected": "reject"})
        # Standing monthly service bill with no PO, same amount every month.
        if monday.day <= 7:
            bn = bill_no("V05", "INV")
            bid = f"V05:{bn}"
            obs.append({"date": (monday + timedelta(days=1)).isoformat(), "kind": "vendor_invoice", "source": "erp", "refKey": f"bill:{bid}", "subject": "vendor:V05",
                        "payload": {"billNo": bn, "vendorCode": "V05", "poNo": "", "date": monday.isoformat(), "dueDate": (monday + timedelta(days=30)).isoformat(), "amountCents": 685_000}})
            truth["no_po"].append(bid)
            key.append({"caseId": f"ap-{bid}", "family": "bill_no_po_service", "split": split_of(f"bill:{bid}"), "subject": f"bill:{bid}", "truth": {"standing": True}, "expected": "hold_exception"})
        week += 1
        d += timedelta(weeks=1)

    # Bank-change emails. Thursdays, the day before a Friday run.
    def thursday(iso):
        x = date.fromisoformat(iso)
        return (x + timedelta(days=(3 - x.weekday()) % 7)).isoformat()

    emails.append({"id": "ap-fraud-1", "date": thursday("2026-05-07"), "from": "ar@formosa-leaf.com", "fromName": "Formosa Leaf Accounts",
                   "subject": "Change of bank details for Friday's payment",
                   "body": "Dear Pearl Lane AP team,\n\nPlease note our banking details have changed following an audit by our bank. Kindly send this Friday's payment for the oolong orders to our new account: Bank of the West, routing 121100782, account ending 7316. Please confirm once updated. If you need to verify, call our finance office on +1 (626) 555-0199.\n\nBest regards,\nWendy Lin\nFormosa Leaf Imports",
                   "truth": {"vendor": "V01", "fraud": True}})
    emails.append({"id": "ap-fraud-2", "date": thursday("2026-06-04"), "from": "orders@goldentapioca.com", "fromName": "Golden Tapioca Supply",
                   "subject": "RE: remittance - new account",
                   "body": "Hi, quick one before your payment run: we moved our operating account to Chase. Please use account ending 5582, routing 322271627 from now on. Our old account will be closed this week so please do not send there. Thanks! — Kevin, Golden Tapioca",
                   "truth": {"vendor": "V03", "fraud": True, "note": "the vendor's real mailbox was compromised"}})
    emails.append({"id": "ap-legit-1", "date": thursday("2026-03-19"), "from": "accounts@bayareadairy.coop", "fromName": "Bay Area Dairy Co-op",
                   "subject": "New bank account for the co-op",
                   "body": "Hello,\nThe co-op has moved its accounts to Mechanics Bank. From April please pay us at account ending 6620 (routing 121102036). Our treasurer Maria Santos will confirm by phone.\nThank you,\nBay Area Dairy Co-op accounts",
                   "truth": {"vendor": "V04", "fraud": False}})
    truth["bank_change_fraud"] = ["ap-fraud-1", "ap-fraud-2"]
    truth["bank_change_legit"] = ["ap-legit-1"]

    out = {
        "seed": seed,
        "vendors": [{"code": c, "name": n, "kind": "vendor", "contactEmail": e, "phoneOnFile": p, "bankAccount": a} for c, n, e, p, a, *_ in VENDORS],
        "observations": sorted(obs, key=lambda o: (o["date"], o["kind"] != "purchase_order", o["refKey"])),
        "emails": emails,
        "answer_key": key,
        "truth": truth,
        "how_people_answer": {
            "bill_exception": "approve the standing CleanPro service bill (no PO) and agreed price increases (first V03 variance); reject short-shipment bills billed at full PO and the other price variances",
            "payment_release": "Dana releases a run unless it contains a known duplicate (then: cancel, then correct_decision on the duplicate's bill_match decision to 'reject' with a reason) or a pending bank change; runs over $25,000 also need Sam: call release_payment(paymentId) as Sam after Dana",
            "callback for vendors": "the controller calls the number on file: 'denied' for fraud emails, 'confirmed' for ap-legit-1; after a confirmed callback Dana calls endorse_routing(requestId)",
            "spot_check:bill_match": "answer per the answer key: duplicates should have been 'reject'",
        },
    }
    path = os.path.join(ROOT, "data/companyA/ap_world.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(out, open(path, "w"), indent=1)
    print(f"ap_world: {len(out['observations'])} observations, {len(emails)} emails, {len(key)} answer-key entries; "
          f"duplicates {len(truth['duplicates'])}, variances {len(truth['price_variance'])}, short {len(truth['short_shipment'])}, no-PO {len(truth['no_po'])}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=11)
    main(ap.parse_args().seed)
