"""After a run: how the team did on company A, family by family, written to data/companyA/run_report.json.

    python3 tools/world/report.py [--db charter-a]

This is the evaluator's side, so it reads anything in the database: every seat
decision joined to the answer key (the first one made and the latest), the
questions raised and how people answered (including the wrong answers that were
planted), and the money: royalties hidden and recovered by audits, duplicates
refunded, payments applied where the payer meant, debits returned and collected.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import stdb  # noqa: E402
from stdb import Client  # noqa: E402

from common import DATA, read_json, write_json  # noqa: E402

ESCALATE = {"flag_audit", "ask_consultant"}


def domain_of(subject: str) -> str | None:
    return {"store": "underreport", "receipt": "allocation", "entity": "pre_chase", "routing": "routing_change"}.get(subject.split(":", 1)[0])


def agrees(domain: str, a: str, b: str) -> bool:
    return (a in ESCALATE) == (b in ESCALATE) if domain == "underreport" else a == b


def build(db: Client, world: dict, state: dict, texts=None) -> dict:
    key = read_json(DATA / "answer_key.json", [])
    q = db.sql
    decisions = sorted(q("SELECT id, at, domain, subject, skill_key, outcome, shadow FROM decision"), key=lambda d: d["id"])
    asks = q("SELECT id, created_at, kind, subject, to_role, status, answer, answered_by, answered_at FROM ask")
    invoices = {i["id"]: i for i in q("SELECT id, kind, entity_code, store_code, amount_cents, open_cents, status FROM invoice")}
    receipts = {r["id"]: r for r in q("SELECT id, entity_code, payer_name, amount_cents, unapplied_cents, method, status FROM receipt")}
    apps = q("SELECT receipt_id, invoice_id, amount_cents, reversed FROM application")
    debits = q("SELECT id, entity_code, amount_cents, bank_account, status, scheduled_for FROM debit_instruction")
    routing = q("SELECT id, entity_code, requested_account, status, callback_status, created_at FROM routing_request")
    refunds = q("SELECT id, entity_code, amount_cents, bank_account, status FROM refund")
    security = q("SELECT at, kind, subject, detail FROM security_event")
    llm = q("SELECT purpose, status, cached FROM llm_call")
    facts = q("SELECT subject, attr, value, valid_from FROM fact")
    entities = {e["code"]: e for e in q("SELECT code, name, bank_account, bank_account_trusted FROM entity")}

    first, latest = {}, {}
    for d in decisions:
        if d["shadow"]:
            continue
        first.setdefault(d["subject"], d)
        latest[d["subject"]] = d
    by_receipt = defaultdict(list)
    for a in apps:
        if not a["reversed"]:
            by_receipt[a["receipt_id"]].append(a)
    notices = defaultdict(list)
    for f in facts:
        if f["attr"] == "notice_sent":
            notices[f["subject"].split(":", 1)[1]].append(f["valid_from"])

    families: dict[str, dict] = {}
    for e in key:
        fam = families.setdefault(e["family"], {"planted": 0, "decisions": defaultdict(lambda: Counter()), "asks": Counter(), "money": Counter(), "cases": []})
        fam["planted"] += 1
        dom = domain_of(e["subject"])
        if dom:
            cell = fam["decisions"][dom]
            cell["n"] += 1
            d0, d1 = first.get(e["subject"]), latest.get(e["subject"])
            if not d1:
                cell["no_decision"] += 1
            else:
                cell["first_right"] += agrees(dom, d0["outcome"], e["expected"])
                cell["latest_right"] += agrees(dom, d1["outcome"], e["expected"])
                cell[f"latest:{d1['outcome']}"] += 1
                if e["family"] != "clean" and not e["family"].startswith("clean_") and e["split"] in ("test", "live", "val", "train"):
                    fam["cases"].append({"case": e["caseId"], "split": e["split"], "expected": e["expected"], "first": f"{d0['outcome']} ({d0['skill_key']}, {d0['at']})",
                                         "latest": f"{d1['outcome']} ({d1['skill_key']}, {d1['at']})"})
        money_for(e, fam["money"], invoices, receipts, by_receipt, refunds, notices)

    for d in debits:
        if d["status"] == "returned":
            families.setdefault("ach_return", {"planted": 0, "decisions": {}, "asks": Counter(), "money": Counter(), "cases": []})["money"]["returned_cents"] += d["amount_cents"]
    for fam_name, fam in families.items():
        fam["decisions"] = {k: dict(v) for k, v in fam["decisions"].items()}
        fam["money"] = dict(fam["money"])
        fam["asks"] = dict(fam["asks"])

    answers = state.get("staff", {}).get("answers", [])
    ask_summary = Counter((a["kind"].split(":")[0], a["status"]) for a in asks)
    report = {
        "db": stdb.DB,
        "window": world["window"],
        "wall_seconds": round(state.get("wall_seconds", 0)),
        "seat_runs": state.get("seat_calls", 0),
        "llm": {"world_prose_cached_texts": len(texts.cache) if texts else None, "world_prose_calls_last_run": texts.calls if texts else None,
                "module_calls": len(llm), "module_calls_cached": sum(1 for c in llm if c["cached"]), "module_failures": sum(1 for c in llm if c["status"] != 200),
                "module_by_purpose": dict(Counter(c["purpose"] for c in llm))},
        "families": families,
        "asks": {
            "by_kind_status": {f"{k}:{s}": n for (k, s), n in sorted(ask_summary.items())},
            "answered_by": dict(Counter(a["answered_by"] for a in asks if a["status"] == "answered")),
            "staff_answers": len(answers),
            "human_errors_realized": [a for a in answers if a.get("human_error")],
            "human_error_rate": round(sum(1 for a in answers if a.get("human_error")) / max(1, len(answers)), 3),
        },
        "routing_requests": routing,
        "refunds": refunds,
        "security_events": dict(Counter(s["kind"] for s in security)),
        "bank": {"debits": len(debits), "by_status": dict(Counter(d["status"] for d in debits)), "returned": [d for d in debits if d["status"] == "returned"]},
        "entities_bank_accounts": {c: e["bank_account"] for c, e in entities.items()},
        "ratified": state.get("ratified", []),
        "evolve_hooks": state.get("hooks", []),
        "month_end_closes": state.get("closes", []),
        "module_errors": [line for line in (DATA / "run.log").read_text().splitlines() if "!" in line[:6]] if (DATA / "run.log").exists() else [],
    }
    write_json(DATA / "run_report.json", report)
    print_summary(report)
    return report


def money_for(e: dict, m: Counter, invoices: dict, receipts: dict, by_receipt: dict, refunds: list, notices: dict) -> None:
    """Dollars at risk and recovered for one answer-key case."""
    t, fam = e["truth"], e["family"]
    if e["subject"].startswith("store:") and t.get("underreported"):
        m["royalty_hidden_cents"] += t.get("royalty_at_risk_cents", 0)
        a = invoices.get(f"A-{t['store']}-{t['week']}")
        if a:
            m["audit_billed_cents"] += a["amount_cents"]
            m["audit_collected_cents"] += a["amount_cents"] - a["open_cents"]
            m["weeks_audited"] += 1
    elif e["subject"].startswith("receipt:"):
        txn = e["subject"].split(":", 1)[1]
        r = receipts.get(txn)
        m["receipt_cents"] += t.get("amount_cents", 0)
        if not r:
            m["receipts_missing"] += 1
            return
        intended = set(filter(None, t.get("intended", "").split(" + ")))
        applied = {a["invoice_id"]: a["amount_cents"] for a in by_receipt.get(txn, [])}
        on_target = sum(v for k, v in applied.items() if k in intended)
        m["applied_where_meant_cents"] += on_target
        m["applied_elsewhere_cents"] += sum(v for k, v in applied.items() if k not in intended)
        m["left_unapplied_cents"] += r["unapplied_cents"]
        if fam == "duplicate_payment" or t.get("paid_invoice"):
            m["duplicate_cents"] += t.get("amount_cents", 0)
    elif e["subject"].startswith("ask:refund_release:"):
        ent = e["subject"].split(":")[2]
        m["refunded_cents"] += sum(r["amount_cents"] for r in refunds if r["entity_code"] == ent and r["status"] == "released")
    elif e["subject"].startswith("entity:") and fam == "payment_in_transit":
        ent, day = e["subject"].split(":")[1:]
        if day in notices.get(ent, []):
            m["notices_sent_while_check_in_mail"] += 1
    elif e["subject"].startswith("ask:dispute:"):
        for ref in t.get("refs", "").split(" + "):
            inv = invoices.get(ref)
            if inv:
                m[f"disputed_{inv['status']}_cents"] += inv["amount_cents"]


def print_summary(r: dict) -> None:
    print(f"\nrun report ({r['window'][0]} .. {r['window'][1]}, {r['wall_seconds']}s, {r['seat_runs']} seat runs)")
    for name, f in sorted(r["families"].items()):
        cells = "; ".join(f"{d}: {c.get('latest_right', 0)}/{c.get('n', 0)} right (first {c.get('first_right', 0)}), {c.get('no_decision', 0)} undecided"
                          for d, c in f["decisions"].items())
        money = ", ".join(f"{k} {v}" for k, v in f["money"].items() if v)
        print(f"  {name:24s} planted {f['planted']:4d} | {cells}{' | ' + money if money else ''}")
    print(f"  asks: {r['asks']['by_kind_status']}")
    print(f"  human errors realized: {len(r['asks']['human_errors_realized'])} of {r['asks']['staff_answers']} answers")
    print(f"  security: {r['security_events']}")
    print(f"  ratified: {[x['key'] for x in r['ratified']]}")
    print(f"  module llm calls: {r['llm']['module_calls']} ({r['llm']['module_calls_cached']} cached, {r['llm']['module_failures']} failed)")
    if r["module_errors"]:
        print(f"  module/runner errors: {len(r['module_errors'])} (see run_report.json)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="charter-a")
    args = ap.parse_args()
    stdb.DB = args.db
    ids = read_json(DATA / "identities.json", {})
    build(Client(ids["Dana"]["token"], "Dana"), read_json(DATA / "world.json"), read_json(DATA / "run_state.json", {}))


if __name__ == "__main__":
    main()
