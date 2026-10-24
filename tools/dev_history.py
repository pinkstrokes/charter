"""A small, fast history for developing the evolution engine (the real world is
built in tools/world/). Eight stores, ten weeks: S03 under-reports cash in
January, S14 from March, S06 is an office-district store that legitimately
takes almost no cash. On 2026-03-12 the consultant raises a concern on S14."""
import json
import random
import sys
from datetime import date, timedelta

from stdb import Client, admin_token, identity_arg, new_identity

DB_NOTE = "uses STDB_DB (default charter-iqwfr)"
rng = random.Random(7)

TERMS = {"version": "FA-2022", "royaltyBp": 600, "graceDays": 10, "lateFeeCents": 7500, "interestBpPerMonth": 150, "nsfFeeCents": 3500,
         "auditThresholdBp": 200, "paymentTermsDays": 2, "applicationOrder": ["interest", "fee", "royalty", "supply", "trade", "audit"]}
STORES = [  # code, entity, weekly gross $, card share
    ("S01", "F01", 11000, 0.70), ("S03", "F02", 9000, 0.68), ("S06", "F03", 12000, 0.93), ("S09", "F04", 8000, 0.72),
    ("S14", "F05", 15000, 0.70), ("S17", "F06", 10000, 0.75), ("S22", "F07", 7000, 0.66), ("S31", "F08", 10500, 0.71),
]
UNDER = {"S03": ("2026-01-12", "2026-02-09"), "S14": ("2026-03-02", "2026-12-31")}  # [from, to) weeks with cash cut


def monday(i):
    return date(2026, 1, 5) + timedelta(weeks=i)


def main(weeks=10):
    admin = Client(admin_token(), "admin")
    admin.call("reset_company")
    clients, ids = {}, {}
    for role, name in [("controller", "Dana"), ("consultant", "Lee"), ("world", "feeder")]:
        ident, tok = new_identity()
        admin.call("bind_role", identity_arg(ident), role, name)
        clients[name] = Client(tok, name)
        ids[name] = {"identity": ident, "token": tok, "role": role}
    import os
    os.makedirs("../data/dev", exist_ok=True)
    json.dump(ids, open("../data/dev/identities.json", "w"), indent=1)
    world, lee = clients["feeder"], clients["Lee"]
    company = {
        "company": {"name": "Pearl Lane Tea Co. (dev)", "kind": "franchisor", "currency": "USD", "startDate": "2026-01-05"},
        "contracts": [{"version": "FA-2022", "terms": TERMS}],
        "entities": [{"code": e, "name": f"Owner {e}", "kind": "franchisee", "contactEmail": f"owner@{e.lower()}.example", "phoneOnFile": f"+1-415-555-01{i:02d}", "bankAccount": f"****{4400 + i}"} for i, (_, e, _, _) in enumerate(STORES)],
        "stores": [{"code": s, "entityCode": e, "name": f"Pearl Lane #{s[1:]}", "city": "San Francisco", "contractVersion": "FA-2022", "consultant": "Lee"} for s, e, _, _ in STORES],
    }
    world.call("load_company", json.dumps(company))
    for w in range(weeks):
        wk = monday(w)
        truth = {}
        for code, ent, base, card_share in STORES:
            gross = base * rng.uniform(0.9, 1.1) * 100
            card = round(gross * card_share)
            cash = round(gross - card)
            lo, hi = UNDER.get(code, ("9999", "9999"))
            reported_cash = round(cash * rng.uniform(0.3, 0.45)) if lo <= wk.isoformat() < hi else cash
            truth[code] = (card, reported_cash)
            delivery = wk - timedelta(days=3)
            drinks = round(gross / 650 * rng.uniform(1.0, 1.06))
            world.call("ingest_obs", "supply_invoice", "erp", delivery.isoformat(), f"sup:{code}:{wk}", f"store:{code}",
                       json.dumps({"invoiceNo": f"SUP-{code}-{wk}", "storeCode": code, "entityCode": ent, "date": delivery.isoformat(), "dueDate": (delivery + timedelta(days=10)).isoformat(),
                                   "lines": [{"sku": "TEA-BASE", "qty": drinks // 50, "unitCents": 1500}], "totalCents": drinks * 120, "impliedDrinks": drinks}))
            for d in range(7):
                day = wk + timedelta(days=d)
                world.call("ingest_obs", "processor_settlement", "processor", day.isoformat(), f"stl:{code}:{day}", f"store:{code}",
                           json.dumps({"storeCode": code, "businessDate": day.isoformat(), "cardGrossCents": card // 7 + (card % 7 if d == 6 else 0), "feesCents": 0, "netCents": 0}))
        report_day = wk + timedelta(days=7)
        world.call("set_sim_date", report_day.isoformat())
        for code, ent, _, _ in STORES:
            card, cash = truth[code]
            world.call("ingest_obs", "email", "email", report_day.isoformat(), f"email:rep:{code}:{wk}", f"sender:owner@{ent.lower()}.example",
                       json.dumps({"messageId": f"<rep-{code}-{wk}@dev>", "from": f"owner@{ent.lower()}.example", "fromName": f"Owner {ent}", "to": "ar@pearllane.example",
                                   "subject": f"Weekly report {code}", "body": "Report attached.",
                                   "attachments": [{"name": f"{code}.csv", "text": f"store,week,card_sales,cash_sales\n{code},{wk},{card / 100:.2f},{cash / 100:.2f}\n"}]}))
        out = world.call("run_seats")[1]
        print(wk, out[:110])
    lee.call("raise_concern", "S14", "2026-03-02", "Supplies they bought imply about $15k of drinks but they reported under $11k, and their cash share fell to about 12% while every other store held near 30%.")
    print("concern raised on S14 week of 2026-03-02")
    write_answer_key(weeks)


def write_answer_key(weeks):
    import hashlib, os
    entries = []
    for w in range(weeks):
        wk = monday(w).isoformat()
        for code, _, _, _ in STORES:
            lo, hi = UNDER.get(code, ("9999", "9999"))
            bad = lo <= wk < hi
            subject = f"store:{code}:{wk}"
            h = int(hashlib.sha256(subject.encode()).hexdigest(), 16) % 100
            split = "train" if h < 50 else "val" if h < 75 else "test"
            if code == "S14" and wk == "2026-03-02":
                split = "train"  # the lesson
            elif code == "S14" and bad:
                split = "live"  # what the demo catches
            elif code == "S03":
                split = "val" if w % 2 else "test"
            entries.append({"caseId": f"ur-{code}-{wk}", "family": "underreported_cash" if bad else ("clean_low_cash" if code == "S06" else "clean"),
                            "split": split, "subject": subject, "truth": {"underreported": bad}, "expected": "flag_audit" if bad else "accept"})
    os.makedirs("../data/dev", exist_ok=True)
    json.dump({"note": "dev history answer key; S14 2026-03-02 is the lesson (train), later S14 weeks are live, S03 weeks alternate val/test", "entries": entries},
              open("../data/dev/answer_key.json", "w"), indent=1)
    print(f"answer key: {len(entries)} entries")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 10)
