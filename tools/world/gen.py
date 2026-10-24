"""Build company A, Pearl Lane Tea Co.: six months of messy reality and its answer key.

    python3 tools/world/gen.py              # uses cached prose; generates what is missing with qwen3.8-flash
    python3 tools/world/gen.py --offline    # templates only, no model calls (prose differs from a full build)

Writes, under data/companyA/:
  company.json          what load_company takes: contracts, franchisees, stores
  world.json            every scheduled observation with its date, the bank's rules, and what the staff know
  answer_key.json       AnswerKeyEntry[] (core/contracts.ts): the truth, for the evaluator only
  answer_key.meta.json  how the key is built: splits, families, subjects, outcomes
  texts.json            every generated text, keyed by a stable id (a rerun makes zero model calls)
"""
from __future__ import annotations

import argparse
from collections import Counter

from cast import COMPANY, CONTRACTS, ENTITIES, STAFF, company_file, entity
from common import DATA, END, START, WEEKS, add_days, all_days, dollars, set_seed, write_json
from economy import make_supply_invoices, settlement_payload, simulate_sales
from mail import planted_email, report_email
from scenarios import AUDIT_REACTIONS, PLANNED_AUDITS, S14_CONCERN, SAME_ORDER, Plan
from texts import Texts


def observations(plan: Plan, sales: dict, supply: dict, texts: Texts) -> list[dict]:
    """Every observation the world feeds in, with the day it arrives."""
    obs: list[dict] = []
    last = END.isoformat()
    for code, weeks in sales.items():
        for w, week in enumerate(WEEKS):
            for i in range(7):
                day = add_days(week, i)
                arrives = add_days(day, 1)  # the processor settles the next morning, seven days a week
                if arrives <= last:
                    obs.append({"date": arrives, "order": 0, "kind": "processor_settlement", "source": "processor", "validAt": day,
                                "refKey": f"stl:{code}:{day}", "subject": f"store:{code}", "payload": settlement_payload(code, day, weeks[w]["card_daily"][i])})
    for code, invs in supply.items():
        for s in invs:
            arrives = max(s["date"], START.isoformat())
            payload = {k: s[k] for k in ("invoiceNo", "storeCode", "entityCode", "date", "dueDate", "lines", "totalCents", "impliedDrinks")}
            obs.append({"date": arrives, "order": 1, "kind": "supply_invoice", "source": "erp", "validAt": s["date"], "refKey": f"sup:{s['invoiceNo']}",
                        "subject": f"store:{code}", "payload": payload})
    for b in plan.bank:
        obs.append({"date": b["date"], "order": 2, "kind": "bank_txn", "source": "bank", "validAt": b["date"], "refKey": f"bank:{b['payload']['txnId']}",
                    "subject": f"account:{b['payload']['counterpartyAccount']}", "payload": b["payload"]})
    for rep in plan.reports:
        p = report_email(texts, rep)
        obs.append({"date": rep["date"], "order": 3, "kind": "email", "source": "email", "validAt": rep["date"], "refKey": f"email:{rep['id']}",
                    "subject": f"sender:{p['from']}", "payload": p})
    for spec in plan.emails:
        p = planted_email(texts, spec)
        obs.append({"date": spec["date"], "order": 3, "kind": "email", "source": "email", "validAt": spec["date"], "refKey": f"email:{spec['id']}",
                    "subject": f"sender:{p['from']}", "payload": p})
    obs.sort(key=lambda o: (o["date"], o["order"], o["refKey"]))
    for o in obs:
        del o["order"]
    return obs


def staff_knowledge(plan: Plan, sales: dict) -> dict:
    """What the simulated staff know when they answer a seat's question (the world's truth, not the answer key)."""
    store_weeks = {}
    for rep in [r for r in plan.reports if r["kind"] == "weekly"]:
        key = f"{rep['store']}:{rep['week']}"
        reports = [r for r in plan.reports if r["store"] == rep["store"] and r["week"] == rep["week"]]
        store_weeks[key] = {"true_gross": rep["true_gross"], "reported_grosses": [r["card"] + r["cash"] for r in reports],
                            "underreported": rep.get("planted") in ("underreported_cash", "card_underreport"), "planted": rep.get("planted", ""),
                            "human_error": plan.human_errors.get(f"store:{rep['store']}:{rep['week']}", "")}
    receipts = {txn: {k: rc.get(k) for k in ("entity", "family", "intended", "ask_answer", "identify_on", "payer", "amount", "expected")}
                for txn, rc in plan.receipts.items()}
    return {
        "events": [dict(e, date=d) for d, evs in sorted(plan.staff.items()) for e in evs],
        "callbacks": plan.routing,
        "disputes": plan.disputes,
        "collections": [{k: w[k] for k in ("entity", "from", "to", "answer", "case")} for w in plan.windows],
        "receipts": receipts,
        "refunds": plan.refunds,
        "royalty_decreases": plan.royalty_decreases,
        "corrections": plan.corrections,
        "human_errors": plan.human_errors,
        "audit_reactions": AUDIT_REACTIONS,
        "planned_audits": PLANNED_AUDITS,
        "store_weeks": store_weeks,
        "mail": mail_truth(plan),
    }


def mail_truth(plan: Plan) -> dict:
    """What each email really says, so a person can tell which of two machine readings is right."""
    out = {f"email:{spec['id']}": spec.get("truth", {}) for spec in plan.emails}
    for rep in plan.reports:
        out[f"email:{rep['id']}"] = {"type": "sales_report", "store_code": rep["store"], "week_start": rep["week"], "card_sales": dollars(rep["card"]),
                                     "cash_sales": dollars(rep["cash"]), "gross_sales": dollars(rep["card"] + rep["cash"])}
    return out


META = {
    "about": "Answer key for company A (Pearl Lane Tea Co.), written by tools/world/gen.py before any run. The evaluator reads it; the database never does.",
    "entry": "AnswerKeyEntry from module/spacetimedb/src/core/contracts.ts: {caseId, family, split, subject, truth, expected}.",
    "subjects": {
        "store:{code}:{weekStartMonday}": "underreport decision: every store-week whose report arrives inside the window (clean weeks too), expected accept or flag_audit",
        "receipt:{txnId}": "allocation decision on a payment people sent by wire or check (ACH debit settlements are applied directly and have no decision)",
        "entity:{code}:{date}": "pre_chase decision on a day the franchisee has past-due items: payment-in-transit windows (hold), bounced-debit days (chase or hold), and a 1-in-9 sample of days inside the grace period (hold)",
        "routing:{entityCode}:{refKey}": "routing_change decision on a bank-change email; refKey is the email observation's refKey",
        "ask:{kind}:...": "what the right human answer is for questions that are not seat decisions (callbacks, disputes, identify_payer, unapplied cash, refunds, royalty decreases); tools/evolve ignores these",
    },
    "expected": {
        "underreport": "flag_audit when the reported sales were cut (seats.ts opens the same audit question for flag_audit and ask_consultant, so evaluators may treat them alike); otherwise accept",
        "allocation": "apply_unique when one invoice set is right (the remittance names it, or only one fits); apply_by_terms when contract order puts the cash where the payer meant; leave_unapplied_ask when no set fits and a person must decide (short payments, duplicates)",
        "pre_chase": "hold while a promised check is in the mail, while our own mistake caused the bounce, or inside the grace period; chase when genuinely late",
        "routing_change": "hold_and_verify when the request comes from the contact on file; reject when it comes from a look-alike address (hold_and_verify is safe but costs a callback)",
    },
    "splits": {
        "default": "sha256('split|' + caseId) mod 100: < 50 train, < 75 val, else test",
        "S14 March weeks": "train: the March lesson (Lee's concern on 2026-03-12)",
        "S31 June weeks": "live: the demo; never used for selection",
        "S03 and S22 under-reported weeks": "alternate val / test so the January-February cases the team missed can measure what it learned",
    },
    "families_not_in_contracts_ts": ["card_underreport", "duplicate_payment", "clean_low_cash", "clean_bulk_buy"],
    "human_error": "truth.human_error = true marks a case where, if a person is asked, the simulated staff member answers wrongly on purpose (pre-registered here before the run; run_report.json lists which were actually asked)",
    "calendar": "business dates 2026-01-05 .. 2026-06-28 are 25 sales weeks; reports for weeks through 2026-06-15 arrive inside the window; the ERP invoices 26 weeks of supplies (the last dated 2026-06-26)",
}


def summarize(plan: Plan, obs: list[dict]) -> None:
    fam = Counter((e["family"], e["subject"].split(":", 1)[0]) for e in plan.key)
    print(f"observations: {len(obs)} " + str(dict(Counter(o["kind"] for o in obs))))
    print(f"answer key: {len(plan.key)} entries; splits {dict(Counter(e['split'] for e in plan.key))}")
    for (f, kind), n in sorted(fam.items()):
        print(f"  {f:24s} {kind:8s} {n}")
    per_day = Counter(o["date"] for o in obs if o["kind"] == "email")
    busiest = per_day.most_common(3)
    print(f"emails: {sum(per_day.values())}, busiest days {busiest}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=20260105)
    ap.add_argument("--offline", action="store_true", help="templates only, no model calls")
    args = ap.parse_args()
    set_seed(args.seed)
    texts = Texts(offline=args.offline)
    sales = simulate_sales()
    supply = make_supply_invoices(sales, SAME_ORDER)
    plan = Plan(sales, supply)
    plan.plan_reports()
    plan.run()
    plan.finish_key()
    obs = observations(plan, sales, supply, texts)
    write_json(DATA / "company.json", company_file())
    write_json(DATA / "world.json", {
        "seed": args.seed, "company": COMPANY["name"], "window": [START.isoformat(), END.isoformat()], "days": len(all_days()),
        "concern": S14_CONCERN, "staff_roster": {k: {"role": v["role"], "full": v["full"]} for k, v in STAFF.items()},
        "bank": {**plan.bank_rules, "payer_names": {e[0]: entity(e[0])["name"].upper().replace(".", "") for e in ENTITIES}},
        "staff": staff_knowledge(plan, sales),
        "observations": obs,
    }, indent=None)
    write_json(DATA / "answer_key.json", plan.key)
    write_json(DATA / "answer_key.meta.json", {**META, "seed": args.seed, "entries": len(plan.key), "contracts": list(CONTRACTS),
                                                "families": dict(Counter(e["family"] for e in plan.key))})
    if not args.offline:
        texts.prune(("email:", "style:"))
    summarize(plan, obs)
    print(f"texts: {len(texts.cache)} cached, {texts.calls} model calls this build, {texts.failures} fell back to templates")


if __name__ == "__main__":
    main()
