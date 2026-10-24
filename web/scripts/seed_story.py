"""Seed a development database with the whole story the UI is built to show.

    python3 web/scripts/seed_story.py --db charter-ui

Ten weeks of dev history (tools/dev_history.py: S03 and S14 under-report cash,
Lee raises a concern on S14), the evolution engine proposes underreport@2,
Dana moves it through shadow and canary to active and hires the refunds seat,
two more weeks in which the new version catches store 31, the payables desk
(tools/smoke_ap.py --keep), an overpayment refunded above the two-person
limit, a payment whose bank reference and remittance advice disagree, and an
internal auditor's opinions on January to March. Afterwards the
UI personas are bound again. Takes a minute or two and a few model calls.

Only for development databases: it resets the company. It refuses charter-a,
charter-b and charter-iqwfr.
"""
import argparse
import datetime
import json
import os
import random
import subprocess
import sys
import tempfile

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(WEB)
TOOLS = os.path.join(REPO, "tools")
sys.path.insert(0, TOOLS)

from stdb import Client, admin_token, identity_arg, new_identity  # noqa: E402

PROTECTED = {"charter-a", "charter-b", "charter-iqwfr"}
STORES = [("S01", "F01", 11000, 0.70), ("S03", "F02", 9000, 0.68), ("S06", "F03", 12000, 0.93), ("S09", "F04", 8000, 0.72),
          ("S14", "F05", 15000, 0.70), ("S17", "F06", 10000, 0.75), ("S22", "F07", 7000, 0.66), ("S31", "F08", 10500, 0.71)]


def step(msg):
    print(f"== {msg}", flush=True)


def personas(db, rebind=True):
    args = ["npm", "run", "-s", "personas", "--", "--db", db] + (["--rebind"] if rebind else [])
    subprocess.run(args, cwd=WEB, check=True)
    return json.load(open(os.path.join(WEB, ".personas", f"{db}.json")))


def bind(db, role, name):
    ident, tok = new_identity()
    Client(admin_token(), "admin").call("bind_role", identity_arg(ident), role, name)
    return Client(tok, name)


def week(world, monday, under, cash_factor=(0.3, 0.45), seed=99):
    rng = random.Random(seed)
    wk = datetime.date.fromisoformat(monday)
    truth = {}
    for code, ent, base, card_share in STORES:
        gross = base * rng.uniform(0.9, 1.1) * 100
        card = round(gross * card_share)
        cash = round(gross - card)
        truth[code] = (card, round(cash * rng.uniform(*cash_factor)) if code in under else cash)
        delivery = wk - datetime.timedelta(days=3)
        drinks = round(gross / 650 * rng.uniform(1.0, 1.06))
        world.call("ingest_obs", "supply_invoice", "erp", delivery.isoformat(), f"sup:{code}:{wk}", f"store:{code}", json.dumps({
            "invoiceNo": f"SUP-{code}-{wk}", "storeCode": code, "entityCode": ent, "date": delivery.isoformat(),
            "dueDate": (delivery + datetime.timedelta(days=10)).isoformat(), "lines": [{"sku": "TEA-BASE", "qty": drinks // 50, "unitCents": 1500}],
            "totalCents": drinks * 120, "impliedDrinks": drinks}))
        for d in range(7):
            day = wk + datetime.timedelta(days=d)
            world.call("ingest_obs", "processor_settlement", "processor", day.isoformat(), f"stl:{code}:{day}", f"store:{code}", json.dumps({
                "storeCode": code, "businessDate": day.isoformat(), "cardGrossCents": card // 7 + (card % 7 if d == 6 else 0), "feesCents": 0, "netCents": 0}))
    report_day = wk + datetime.timedelta(days=7)
    world.call("set_sim_date", report_day.isoformat())
    for code, ent, _, _ in STORES:
        card, cash = truth[code]
        world.call("ingest_obs", "email", "email", report_day.isoformat(), f"email:rep:{code}:{wk}", f"sender:owner@{ent.lower()}.example", json.dumps({
            "messageId": f"<rep-{code}-{wk}@dev>", "from": f"owner@{ent.lower()}.example", "fromName": f"Owner {ent}", "to": "ar@pearllane.example",
            "subject": f"Weekly report {code}", "body": "Report attached.",
            "attachments": [{"name": f"{code}.csv", "text": f"store,week,card_sales,cash_sales\n{code},{wk},{card / 100:.2f},{cash / 100:.2f}\n"}]}))
    return world.call("run_seats")[1]


def ambiguous_payment(world, outsider):
    """Owner F01 pays its first January week plus the two late fees on it in one
    ACH. The bank reference names only the royalty invoice; the remittance advice
    from the contact on file lists all four. Ten $75 fees sit in the search pool,
    so several sets of invoices explain the amount and allocation@1 asks."""
    rows = [r for r in world.sql("SELECT id, kind, due_at, open_cents FROM invoice WHERE entity_code = 'F01'") if r["open_cents"] > 0]
    roy = min((r for r in rows if r["kind"] == "royalty"), key=lambda r: r["due_at"])
    wk = roy["id"].split("-", 2)[2]
    by_id = {r["id"]: r for r in rows}
    paid = [by_id[i] for i in (roy["id"], f"SUP-S01-{wk}", f"LF-{roy['id']}", f"LF-SUP-S01-{wk}") if i in by_id]
    amount = sum(r["open_cents"] for r in paid)
    csv = "invoice,amount\n" + "".join(f"{r['id']},{r['open_cents'] / 100:.2f}\n" for r in paid)
    outsider.call("send_email", "owner@f01.example", "Owner F01", "Remittance advice", "Paying the week of " + wk + " and the late fees on it. Advice attached.", "remittance.csv", csv)
    world.call("run_seats")
    today = world.sql("SELECT sim_date FROM config")[0]["sim_date"]
    account = world.sql("SELECT bank_account FROM entity WHERE code = 'F01'")[0]["bank_account"]
    world.call("ingest_obs", "bank_txn", "bank", today, "bank:ACH-F01-JAN", "entity:F01", json.dumps({
        "txnId": "ACH-F01-JAN", "date": today, "type": "ach_credit_in", "amountCents": amount, "counterpartyName": "OWNER F01",
        "counterpartyAccount": account, "reference": f"PEARL LANE {roy['id']}"}))
    world.call("run_seats")
    asks = world.sql("SELECT id, kind, status FROM ask WHERE subject = 'receipt:ACH-F01-JAN'")
    print(f"   F01 paid {amount / 100:,.2f}; questions on it: {[(a['id'], a['kind'], a['status']) for a in asks]}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--only", choices=["ambiguous-payment"], help="run one step against the database as it is, without resetting it")
    args = ap.parse_args()
    db = args.db
    if db in PROTECTED:
        sys.exit(f"refusing to reset {db}; this script is for development databases")
    os.environ["STDB_DB"] = db
    import stdb
    stdb.DB = db

    if args.only == "ambiguous-payment":
        step("F01 pays one January week; the bank reference and the remittance advice disagree")
        ambiguous_payment(bind(db, "world", "story-feeder"), Client(new_identity()[1], "outsider"))
        personas(db, rebind=False)
        return

    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, "tools"))
        os.makedirs(os.path.join(tmp, "data", "dev", "eval"))
        step("ten weeks of dev history (resets the company)")
        cwd = os.getcwd()
        os.chdir(os.path.join(tmp, "tools"))  # dev_history writes ../data/dev here, not into the repo
        import dev_history
        dev_history.main(10)
        os.chdir(cwd)

        step("UI personas")
        ui = personas(db)
        dana = Client(ui["Dana"]["token"], "Dana")

        step("evolution engine reads Lee's concern")
        tsx = os.path.join(WEB, "node_modules", ".bin", "tsx")
        subprocess.run([tsx, os.path.join(TOOLS, "evolve", "evolve.ts"), "--db", db, "--once", "--no-policies", "--data", os.path.join(tmp, "data", "dev")], cwd=tmp, check=True)
        if not any(s["key"] == "underreport@2" for s in dana.sql("SELECT key FROM skill")):
            sys.exit("the engine did not propose underreport@2; nothing to promote")

        step("Dana promotes underreport@2 and hires the refunds seat")
        for status, fraction in [("shadow", 0.0), ("canary", 0.2), ("active", 0.0)]:
            dana.call("set_skill_status", "underreport@2", status, fraction)
        dana.call("hire_seat", "refunds")

        world = bind(db, "world", "story-feeder")
        step("two more weeks; store 31 under-reports")
        print(week(world, "2026-03-16", {"S14", "S31"})[:160])
        print(week(world, "2026-03-23", {"S31"}, (0.05, 0.10))[:160])

    step("payables desk (tools/smoke_ap.py --keep)")
    subprocess.run([sys.executable, "smoke_ap.py", "--keep"], cwd=TOOLS, check=True, env={**os.environ, "STDB_DB": db}, stdout=subprocess.DEVNULL)
    ui = personas(db)
    dana = Client(ui["Dana"]["token"], "Dana")
    world = bind(db, "world", "story-feeder")

    step("Patel (F08) overpays by wire and asks for the excess back")
    owed = sum(r["open_cents"] for r in world.sql("SELECT open_cents FROM invoice WHERE entity_code = 'F08'"))
    account = world.sql("SELECT bank_account FROM entity WHERE code = 'F08'")[0]["bank_account"]
    today = world.sql("SELECT sim_date FROM config")[0]["sim_date"]
    world.call("ingest_obs", "bank_txn", "bank", today, "bank:WIRE-F08-OVER", "entity:F08", json.dumps({
        "txnId": "WIRE-F08-OVER", "date": today, "type": "wire_in", "amountCents": owed + 640_000, "counterpartyName": "OWNER F08 HOLDINGS",
        "counterpartyAccount": account, "reference": "catch-up payment, all open invoices"}))
    world.call("run_seats")
    outsider = Client(new_identity()[1], "outsider")
    outsider.call("send_email", "owner@f08.example", "Owner F08", "Refund of our overpayment",
                  "Hi, our catch-up wire was $6,400.00 more than we owed. Please refund the difference to our account on file. Thanks.", "", "")
    world.call("run_seats")

    step("F01 pays one January week; the bank reference and the remittance advice disagree")
    ambiguous_payment(world, outsider)

    step("internal auditor reports on January to March")
    auditor = bind(db, "auditor", "auditor")
    auditor.call("file_finding", "2026-01", "royalty_recompute", "store:S03:2026-01-12", "major",
                 "Store 3 reported about $6,800 for the week of Jan 12 while its supply orders imply about $9,000; royalty was billed on the lower figure.",
                 json.dumps({"reportedCents": 680000, "impliedCents": 900000, "label": {"domain": "underreport", "subject": "store:S03:2026-01-12", "correct": "flag_audit"}}))
    for period, opinion, projected, upper in [("2026-01", "qualified", 52800, 131000), ("2026-02", "clean", 0, 88000), ("2026-03", "clean", 0, 91000)]:
        auditor.call("record_opinion", period, opinion, projected, upper, 250000, 24, json.dumps({"population": f"{period} royalty, supply and fee invoices", "sampled": 24, "method": "monetary-unit sampling at 95% confidence"}))
    personas(db, rebind=False)
    print(f"done: open http://127.0.0.1:5190/?db={db}")


if __name__ == "__main__":
    main()
