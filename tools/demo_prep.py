"""Set company A up for the live demo after the six-month run: matched bills due
over the next two weeks (Formosa Leaf's $48,000 among them), the business date on
the Thursday before a Friday payment run, and the seats on autopilot so an email
sent from the Security page is handled without anyone pressing a button.
  STDB_DB=charter-a python3 tools/demo_prep.py            # once, after the run
  STDB_DB=charter-a python3 tools/demo_prep.py --friday   # the next Friday's payment run
Then, in another terminal:  npx tsx tools/evolve/evolve.ts --db charter-a --watch"""
import json
import os
import sys
from datetime import date, timedelta

from stdb import DB, Client, admin_token

ROOT = os.path.join(os.path.dirname(__file__), "..")
THURSDAY = "2026-07-02"
# Vendor, bill number, amount, received on, due: one per vendor a judge might attack.
BILLS = [("V01", "INV-77001", 4_800_000, "2026-07-01", "2026-07-08"),
         ("V03", "GT77002", 1_260_000, "2026-07-01", "2026-07-15"),
         ("V02", "PC-77003", 860_000, "2026-07-02", "2026-07-15")]


def people():
    ids = json.load(open(os.path.join(ROOT, "data/companyA/identities.json") if DB == "charter-a" else os.path.join(ROOT, "data/dev/identities.json")))
    feeder = Client(ids.get("feeder", {}).get("token") or next(v["token"] for v in ids.values() if v["role"] == "world"), "feeder")
    return feeder, Client(admin_token(), "admin")


def main():
    feeder, admin = people()
    today = admin.sql("SELECT sim_date FROM config")[0]["sim_date"]
    if today > THURSDAY:
        sys.exit(f"business date is already {today}; run with --friday for the next payment run")
    for vendor, bill_no, cents, received, due in BILLS:
        po = f"PO-DEMO-{vendor}"
        feeder.call("ingest_obs", "purchase_order", "erp", "2026-06-29", f"po:{po}", f"po:{po}",
                    json.dumps({"poNo": po, "vendorCode": vendor, "date": "2026-06-29", "totalCents": cents, "lines": [{"sku": "DEMO", "qty": 1, "unitCents": cents}], "buyer": "commissary"}))
        feeder.call("ingest_obs", "goods_receipt", "erp", received, f"gr:{po}", f"po:{po}",
                    json.dumps({"receiptNo": f"GR-DEMO-{vendor}", "poNo": po, "vendorCode": vendor, "date": received, "receivedCents": cents}))
        feeder.call("ingest_obs", "vendor_invoice", "erp", received, f"bill:{vendor}:{bill_no}", f"vendor:{vendor}",
                    json.dumps({"billNo": bill_no, "vendorCode": vendor, "poNo": po, "date": received, "dueDate": due, "amountCents": cents}))
    feeder.call("set_sim_date", THURSDAY)
    feeder.call("run_seats")
    cfg = admin.sql("SELECT llm_model FROM config")[0]
    admin.call("set_config", cfg["llm_model"], True)
    bills = [(b["id"], b["status"]) for b in admin.sql("SELECT id, status FROM bill") if b["id"].split(":")[1] in [x[1] for x in BILLS]]
    pol = [p["key"] for p in admin.sql("SELECT key, status, template FROM policy") if p["status"] == "active" and json.loads(p["template"]).get("action") == "release_payment"]
    print(f"ready on {THURSDAY}: bills {bills}, autopilot on; rules on releasing a payment: {pol}")


def friday():
    feeder, admin = people()
    today = date.fromisoformat(admin.sql("SELECT sim_date FROM config")[0]["sim_date"])
    nxt = today + timedelta(days=(4 - today.weekday()) % 7 or 7)
    feeder.call("set_sim_date", nxt.isoformat())
    print(f"{nxt.isoformat()}:", feeder.call("run_seats")[1][:200])


if __name__ == "__main__":
    friday() if "--friday" in sys.argv else main()
