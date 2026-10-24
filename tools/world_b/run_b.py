"""Company B: a real UK giftware wholesaler (UCI Online Retail II, CC BY 4.0).
Invoices and credit notes are real and booked on their real dates; the cash
side is simulated, and labelled as such: customers pay by profile (prompt,
monthly statement with remittance advice, late, through a parent company) and
the controller answers the seats' questions the way the simulated truth says.
  STDB_DB=charter-b python3 tools/world_b/run_b.py [--until 2011-06-30] [--no-evolve]"""
import argparse
import hashlib
import json
import os
import random
import subprocess
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from stdb import DB, Client, admin_token, identity_arg, load_key, new_identity  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
B = os.path.join(ROOT, "data/companyB")
TERMS = {"version": "TRADE-30", "royaltyBp": 0, "graceDays": 7, "lateFeeCents": 0, "interestBpPerMonth": 0, "nsfFeeCents": 0, "auditThresholdBp": 0,
         "paymentTermsDays": 30, "applicationOrder": ["trade", "fee", "interest", "royalty", "supply", "audit"]}


def acct(code, salt=""):
    return "****" + str(int(hashlib.sha256((code + salt).encode()).hexdigest(), 16) % 10_000).zfill(4)


def build(seed):
    rng = random.Random(seed)
    # The long tail of cash application, from its own random stream so every
    # payment drawn from the first stays as it was: bank charges and currency
    # differences on payments from abroad, money sent "on account" without a
    # reference, and one payment covering two invoices.
    mess = random.Random(seed * 7919 + 1)
    customers = json.load(open(f"{B}/customers.json"))
    customer = {c["customer_code"]: c for c in customers}
    invoices = json.load(open(f"{B}/invoices.json"))
    credits = json.load(open(f"{B}/credit_notes.json"))
    profile = {}
    for c in customers:
        r = rng.random()
        profile[c["customer_code"]] = "statement" if r < 0.25 else "late" if r < 0.40 else "parent" if r < 0.50 else "prompt"
    entities = [{"code": c["customer_code"], "name": f"Customer {c['source_customer_id']} ({c['country']})", "kind": "customer",
                 "contactEmail": f"accounts@c{c['source_customer_id']}.example", "phoneOnFile": f"+44-20-7946-{c['source_customer_id'] % 10000:04d}",
                 "bankAccount": acct(c["customer_code"]), "country": c["country"]} for c in customers]
    events = []  # (date, order, kind, payload)
    credit_by_invoice = {}
    for cn in credits:
        d = cn["date"][:10]
        parts = cn["allocations"] or [{"invoice_no": None, "amount_pence": cn["amount_pence"]}]
        for k, a in enumerate(parts):
            no = cn["credit_no"] + (f"-{k + 1}" if len(parts) > 1 else "")
            events.append((d, 1, "credit_note", {"creditNo": no, "customerCode": cn["customer_code"], "date": d, "amountCents": a["amount_pence"], "linkedInvoiceNo": a["invoice_no"], "reason": cn.get("reason_guess", "")}))
            if a["invoice_no"]:
                credit_by_invoice[a["invoice_no"]] = credit_by_invoice.get(a["invoice_no"], 0) + a["amount_pence"]
    key, truth = [], {}
    statements = {}
    owed_of = {i["invoice_no"]: i["net_pence"] - credit_by_invoice.get(i["invoice_no"], 0) for i in invoices}
    later = {}  # the customer's next invoice, for a payment that covers two
    for cust in {i["customer_code"] for i in invoices}:
        mine = sorted((i for i in invoices if i["customer_code"] == cust), key=lambda i: i["invoice_date"])
        for a, b2 in zip(mine, mine[1:]):
            later[a["invoice_no"]] = b2
    paid_with = {}  # invoice -> the earlier invoice whose payment also paid it

    def pay_event(when, txn, amount, payer, account, reference, cust, invoices_paid, family, expected):
        events.append((when, 2, "bank_txn", {"txnId": txn, "date": when, "type": "ach_credit_in", "amountCents": amount, "counterpartyName": payer, "counterpartyAccount": account, "reference": reference}))
        truth[txn] = {"customer": cust, "invoices": invoices_paid, "profile": family.removeprefix("payment_")}
        key.append({"caseId": f"b-{txn}", "family": family, "split": split_of(f"receipt:{txn}"), "subject": f"receipt:{txn}", "truth": truth[txn], "expected": expected})

    for inv in invoices:
        d = inv["invoice_date"][:10]
        due = (date.fromisoformat(d) + timedelta(days=30)).isoformat()
        events.append((d, 0, "trade_invoice", {"invoiceNo": inv["invoice_no"], "customerCode": inv["customer_code"], "date": d, "dueDate": due, "netCents": inv["net_pence"], "lines": []}))
        owed = inv["net_pence"] - credit_by_invoice.get(inv["invoice_no"], 0)
        if owed <= 0:
            continue
        p = profile[inv["customer_code"]]
        if p == "statement":
            m = due[:7]
            statements.setdefault((inv["customer_code"], m), []).append((inv["invoice_no"], owed))
            continue
        offset = rng.randint(20, 50) if p == "late" else rng.randint(-4, 5)
        pay = (date.fromisoformat(due) + timedelta(days=offset)).isoformat()
        duplicate = rng.random() < 0.01
        no, cust = inv["invoice_no"], inv["customer_code"]
        if no in paid_with:
            continue  # paid together with an earlier invoice
        txn = f"BACS-{no}"
        payer = f"{cust} HOLDINGS LTD" if p == "parent" else f"CUSTOMER {cust[2:]}"
        account = acct(cust, "parent") if p == "parent" else acct(cust)
        abroad, r = customer[cust]["country"] != "United Kingdom", mess.random()
        nxt = later.get(no)
        if abroad and r < 0.6 and owed > 3000:
            # An international transfer arrives short by the intermediary banks' charges.
            pay_event(pay, txn, owed - mess.choice([600, 800, 1000, 1200, 1500]), payer, account, no, cust, [no], "payment_bank_charge", "apply_to_reference")
            continue
        if abroad and customer[cust].get("currency_guess") == "EUR" and r < 0.9:
            # Paid from a euro account: the sterling amount is off by the bank's exchange rate.
            pay_event(pay, txn, round(owed * (1 + mess.choice([-1, 1]) * mess.uniform(0.005, 0.025))), payer, account, no, cust, [no], "payment_fx_difference", "apply_to_reference")
            continue
        if p == "prompt" and r < 0.07 and owed >= 4000:
            # Half "on account" with no reference, the balance a week later naming the invoice.
            first = owed // 2 // 100 * 100
            pay_event(pay, f"{txn}-A", first, payer, account, "ON ACCOUNT", cust, [no], "payment_on_account", "leave_unapplied_ask")
            pay_event((date.fromisoformat(pay) + timedelta(days=7)).isoformat(), txn, owed - first, payer, account, no, cust, [no], "payment_on_account_balance", "apply_unique")
            continue
        if p == "prompt" and r < 0.12 and nxt and owed_of[nxt["invoice_no"]] > 0 and nxt["invoice_no"] not in paid_with and \
                (datetime.fromisoformat(nxt["invoice_date"]) - datetime.fromisoformat(inv["invoice_date"])).days <= 10:
            # One payment for this invoice and the next, both numbers in the reference.
            paid_with[nxt["invoice_no"]] = no
            pay_event(pay, txn, owed + owed_of[nxt["invoice_no"]], payer, account, f"{no} {nxt['invoice_no']}", cust, [no, nxt["invoice_no"]], "payment_two_invoices", "apply_unique")
            continue
        pay_event(pay, txn, owed, payer, account, no, cust, [no], f"payment_{p}", "apply_unique")
        if duplicate:
            dup = f"{txn}-DUP"
            events.append(((date.fromisoformat(pay) + timedelta(days=3)).isoformat(), 2, "bank_txn", {"txnId": dup, "date": pay, "type": "ach_credit_in", "amountCents": owed, "counterpartyName": payer,
                                                                                                    "counterpartyAccount": acct(inv["customer_code"]), "reference": inv["invoice_no"]}))
            truth[dup] = {"customer": inv["customer_code"], "invoices": [], "profile": "duplicate"}
            key.append({"caseId": f"b-{dup}", "family": "payment_duplicate", "split": split_of(f"receipt:{dup}"), "subject": f"receipt:{dup}", "truth": truth[dup], "expected": "leave_unapplied_ask"})
    for (cust, m), items in statements.items():
        y, mo = map(int, m.split("-"))
        pay = (date(y + (mo == 12), mo % 12 + 1, 1) + timedelta(days=rng.randint(4, 9))).isoformat()
        txn = f"STMT-{cust}-{m}"
        total = sum(a for _, a in items)
        csv = "invoice,amount\n" + "\n".join(f"{n},{a / 100:.2f}" for n, a in items)
        email = {"messageId": f"<{txn}@remit>", "from": f"accounts@c{cust[2:]}.example", "fromName": f"Customer {cust[2:]} accounts", "to": "credit.control@wholesaler.example",
                 "subject": f"Remittance advice {m}", "body": f"Please find attached our remittance for {len(items)} invoices.", "attachments": [{"name": f"remittance-{m}.csv", "text": csv}]}
        prev_day = (date.fromisoformat(pay) - timedelta(days=1)).isoformat()
        events.append((prev_day, 3, "email", email))
        events.append((pay, 2, "bank_txn", {"txnId": txn, "date": pay, "type": "ach_credit_in", "amountCents": total, "counterpartyName": f"CUSTOMER {cust[2:]}", "counterpartyAccount": acct(cust), "reference": f"STATEMENT {m}"}))
        truth[txn] = {"customer": cust, "invoices": [n for n, _ in items], "profile": "statement"}
        key.append({"caseId": f"b-{txn}", "family": "payment_statement_with_remittance", "split": split_of(f"receipt:{txn}"), "subject": f"receipt:{txn}", "truth": truth[txn], "expected": "apply_unique"})
    events.sort(key=lambda e: (e[0], e[1]))
    json.dump({"note": "real invoices and credit notes; simulated payments and remittances", "entries": key}, open(f"{B}/answer_key.json", "w"))
    return entities, events, truth


def split_of(subject):
    h = int(hashlib.sha256(subject.encode()).hexdigest(), 16) % 100
    return "train" if h < 50 else "val" if h < 75 else "test"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--until", default="2011-06-30")
    ap.add_argument("--seed", type=int, default=5)
    ap.add_argument("--no-evolve", action="store_true")
    a = ap.parse_args()
    entities, events, truth = build(a.seed)
    admin = Client(admin_token(), "admin")
    admin.call("reset_company")
    who, ids = {}, {}
    for role, name in [("controller", "Dana"), ("controller", "Sam"), ("world", "feeder"), ("auditor", "auditor"), ("evolver", "evolver")]:
        ident, tok = new_identity()
        admin.call("bind_role", identity_arg(ident), role, name)
        who[name] = Client(tok, name)
        ids[name] = {"identity": ident, "token": tok, "role": role}
    json.dump(ids, open(f"{B}/identities.json", "w"), indent=1)
    admin.call("set_secret", "MODELSTUDIO_API_KEY", load_key())
    dana, world = who["Dana"], who["feeder"]
    world.call("load_company", json.dumps({"company": {"name": "UK giftware wholesaler (UCI Online Retail II)", "kind": "wholesaler", "currency": "GBP", "startDate": "2010-12-01"},
                                           "contracts": [{"version": "TRADE-30", "terms": TERMS}], "entities": entities, "stores": []}))
    by_day = {}
    for e in events:
        by_day.setdefault(e[0], []).append(e)
    d, end, prev = date(2010, 12, 1), date.fromisoformat(a.until), date(2010, 12, 1)
    n_ing = 0
    while d <= end:
        iso = d.isoformat()
        world.call("set_sim_date", iso)
        if d.month != prev.month:
            period = prev.strftime("%Y-%m")
            subprocess.run(["npx", "tsx", "tools/audit/auditor.ts", "--db", DB, "--period", period, "--data", "data/companyB"], cwd=ROOT, capture_output=True, text=True)
            dana.call("close_period", period, check=False)
        prev = d
        for _, _, kind, p in by_day.get(iso, []):
            if kind == "email":
                world.call("ingest_obs", "email", "email", iso, f"email:{p['messageId']}", f"sender:{p['from']}", json.dumps(p))
            else:
                src = "bank" if kind == "bank_txn" else "erp"
                ref = p.get("invoiceNo") or p.get("creditNo") or p.get("txnId")
                world.call("ingest_obs", kind, src, iso, f"{kind}:{ref}", f"entity:{p.get('customerCode', '')}", json.dumps(p))
            n_ing += 1
        world.call("run_seats")
        answer(admin, dana, truth)
        customers_notice_duplicates(admin, dana, truth, d)
        if d.weekday() == 6 and not a.no_evolve:
            r = subprocess.run(["npx", "tsx", "tools/evolve/evolve.ts", "--db", DB, "--once", "--data", "data/companyB", "--no-policies"], cwd=ROOT, capture_output=True, text=True)
            for line in (r.stdout or "").splitlines():
                if "proposed" in line:
                    print(f"{iso} evolver: {line}", flush=True)
            for s in admin.sql("SELECT key, status, proof FROM skill"):
                if s["status"] == "proposed" and json.loads(s["proof"] or "{}").get("gate") == "pass":
                    dana.call("set_skill_status", s["key"], "active", 0.0)
                    print(f"{iso} Dana activated {s['key']}", flush=True)
        if d.day == 1:
            print(f"{iso}: {n_ing} observations so far", flush=True)
        d += timedelta(days=1)


def answer(admin, dana, truth):
    for a in admin.sql("SELECT id, kind, subject, status, options, evidence FROM ask"):
        if a["status"] != "open":
            continue
        k, subj = a["kind"], a["subject"]
        t = truth.get(subj.replace("receipt:", ""), {})
        opts = json.loads(a["options"] or "[]")
        if k == "allocation":
            if t and not t.get("invoices"):
                dana.call("answer_ask", a["id"], "leave unapplied", "nothing open matches; this looks like a second payment of an invoice already paid")
                continue
            match = next((o for o in opts if set(o.split(" + ")) == set(t.get("invoices", []))), None)
            why = {"on_account": "called the customer: the money on account was for this invoice", "bank_charge": "the customer named the invoice; the difference is the banks' charges",
                   "fx_difference": "the customer named the invoice; the difference is the exchange rate"}.get(t.get("profile"), "the customer's remittance lists these invoices")
            dana.call("answer_ask", a["id"], match or "apply oldest first", why if match else "apply to the oldest")
        elif k == "identify_payer":
            dana.call("answer_ask", a["id"], t.get("customer", opts[0] if opts else ""), "parent company pays for this customer")
        elif k == "misapplied":
            ev = json.loads(a["evidence"] or "{}")
            if t and ev.get("invoice") in t.get("invoices", []):
                dana.call("answer_ask", a["id"], "undo the earlier application", f"this payment is the one for {ev.get('invoice')}; {ev.get('earlier')} was put on it by guesswork")
            else:
                dana.call("answer_ask", a["id"], "duplicate: keep as credit", "the customer paid this invoice twice")
        elif k == "unapplied_cash":
            dana.call("answer_ask", a["id"], "keep as credit", "customer paid twice; keep it against the next invoice")
        elif k == "spot_check:allocation":
            # Check where the money actually landed against what the customer paid for, and say
            # which way of applying it would have put it there (asking, when none would).
            rid = subj.replace("receipt:", "")
            got = sorted(x["invoice_id"] for x in admin.sql(f"SELECT invoice_id, reversed FROM application WHERE receipt_id = '{rid}'") if not x["reversed"])
            right = got == sorted(t.get("invoices", [])) if t else True
            treat = json.loads(a["evidence"] or "{}").get("treatments") or {}
            want = " + ".join(sorted(t.get("invoices", []))) or "ask"
            should = next((o for o in opts if treat.get(o) == want), "leave_unapplied_ask")
            dana.call("answer_ask", a["id"], "correct" if right else should, "the money landed on the invoices the customer paid" if right else f"landed on {', '.join(got) or 'nothing'}, the customer paid {', '.join(t.get('invoices', [])) or 'nothing open'}")
        elif k == "label_check":
            dana.call("answer_ask", a["id"], opts[1], "checked again against the remittance and the bank line: the verdict stands")
        elif k.startswith("spot_check:"):
            dana.call("answer_ask", a["id"], "correct", "checked against the remittance and the bank line")
        elif k == "collections":
            dana.call("answer_ask", a["id"], "chase", "overdue")
        elif k == "reading_conflict":
            dana.call("answer_ask", a["id"], "reading A", "matches the email")
        elif k == "finding":
            dana.call("answer_ask", a["id"], "acknowledge", "noted")


NOTICED = set()


# A week after a duplicate payment was applied to other invoices, the customer writes
# to ask for it back; the controller corrects the decision that applied it.
def customers_notice_duplicates(admin, dana, truth, today):
    for txn, t in truth.items():
        if t.get("profile") != "duplicate" or txn in NOTICED:
            continue
        rows = admin.sql(f"SELECT id, received_at FROM receipt WHERE id = '{txn}'")
        if not rows or rows[0]["received_at"] > (today - timedelta(days=7)).isoformat():
            continue
        applied = [x for x in admin.sql(f"SELECT reversed FROM application WHERE receipt_id = '{txn}'") if not x["reversed"]]
        NOTICED.add(txn)
        if not applied:
            continue
        dec = sorted((x for x in admin.sql("SELECT id, subject, domain FROM decision WHERE domain = 'allocation'") if x["subject"] == f"receipt:{txn}"), key=lambda x: x["id"])
        if dec:
            dana.call("correct_decision", dec[-1]["id"], "leave_unapplied_ask",
                      "the customer paid this invoice twice; the second payment should not have been spread over other invoices", check=False)


if __name__ == "__main__":
    main()
