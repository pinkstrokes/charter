"""Set company A up for the live demo after the six-month run: a $48,000
Formosa Leaf bill matched and due next week, the business date on the Thursday
before a Friday payment run, seats on autopilot so a judge's email is handled
without anyone pressing a button.  STDB_DB=charter-a python3 tools/demo_prep.py
Then, in another terminal:  npx tsx tools/evolve/evolve.ts --db charter-a --watch"""
import json
import os
import sys

from stdb import DB, Client, admin_token

ROOT = os.path.join(os.path.dirname(__file__), "..")
THURSDAY, FRIDAY = "2026-07-02", "2026-07-03"


def main():
    ids_path = os.path.join(ROOT, "data/companyA/identities.json") if DB == "charter-a" else os.path.join(ROOT, "data/dev/identities.json")
    ids = json.load(open(ids_path))
    feeder = Client(ids.get("feeder", {}).get("token") or next(v["token"] for v in ids.values() if v["role"] == "world"), "feeder")
    admin = Client(admin_token(), "admin")
    today = admin.sql("SELECT sim_date FROM config")[0]["sim_date"]
    if today > THURSDAY:
        sys.exit(f"business date is already {today}; reset or pick later dates")
    po = "PO-DEMO-V01"
    feeder.call("ingest_obs", "purchase_order", "erp", "2026-06-29", f"po:{po}", f"po:{po}",
                json.dumps({"poNo": po, "vendorCode": "V01", "date": "2026-06-29", "totalCents": 4_800_000, "lines": [{"sku": "OOLONG-25KG", "qty": 40, "unitCents": 120_000}], "buyer": "commissary"}))
    feeder.call("ingest_obs", "goods_receipt", "erp", "2026-07-01", f"gr:{po}", f"po:{po}",
                json.dumps({"receiptNo": "GR-DEMO-V01", "poNo": po, "vendorCode": "V01", "date": "2026-07-01", "receivedCents": 4_800_000}))
    feeder.call("set_sim_date", "2026-07-01")
    feeder.call("ingest_obs", "vendor_invoice", "erp", "2026-07-01", "bill:V01:INV-77001", "vendor:V01",
                json.dumps({"billNo": "INV-77001", "vendorCode": "V01", "poNo": po, "date": "2026-07-01", "dueDate": "2026-07-08", "amountCents": 4_800_000}))
    feeder.call("run_seats")
    feeder.call("set_sim_date", THURSDAY)
    feeder.call("run_seats")
    cfg = admin.sql("SELECT llm_model FROM config")[0]
    admin.call("set_config", cfg["llm_model"], True)
    bill = admin.sql("SELECT id, status FROM bill WHERE id = 'V01:INV-77001'")
    pol = [p for p in admin.sql("SELECT key, status, text, template FROM policy") if p["status"] == "active" and json.loads(p["template"]).get("action") == "release_payment"]
    print(f"ready on {THURSDAY}: bill {bill}, autopilot on")
    print("policy that will hold the Friday payment if a bank change is pending:", [p["key"] + " " + p["text"] for p in pol] or "NONE (only C12 protects the money; the release itself will not be blocked)")
    print(f"after the judge's email is held, move to Friday:  feeder set_sim_date {FRIDAY} (the payment run prepares at the next seat tick)")


def friday():
    ids_path = os.path.join(ROOT, "data/companyA/identities.json") if DB == "charter-a" else os.path.join(ROOT, "data/dev/identities.json")
    ids = json.load(open(ids_path))
    feeder = Client(ids.get("feeder", {}).get("token") or next(v["token"] for v in ids.values() if v["role"] == "world"), "feeder")
    feeder.call("set_sim_date", FRIDAY)
    print(feeder.call("run_seats")[1][:200])


if __name__ == "__main__":
    friday() if "--friday" in sys.argv else main()
