"""What the people did, month by month: the questions the seats asked them, the spot checks and
second looks that grade the seats, and the things only a person may do (release money, endorse a
bank change, approve a skill version or a policy, close the month). Read from the database.
  STDB_DB=charter-b python3 tools/evolve/workload.py [--json data/companyB/eval/workload.json]"""
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from stdb import Client, admin_token  # noqa: E402

PEOPLE = ("controller", "consultant")
# Commands only a person may run (the kernel's role matrix), grouped the way a controller would count them.
ONLY_PEOPLE = {
    "release_payment": "money released", "issue_refund": "money released",
    "endorse_routing_change": "bank changes endorsed",
    "activate_skill": "versions and policies approved", "activate_policy": "versions and policies approved",
    "close_period": "months closed",
    "write_off": "write-offs, waivers, reversals", "waive_fee": "write-offs, waivers, reversals", "reverse_application": "write-offs, waivers, reversals",
}
COLUMNS = ["decisions", "asked", "spot checks", "second looks", "corrections", "answered", "money released", "bank changes endorsed",
           "versions and policies approved", "write-offs, waivers, reversals", "months closed"]


def ask_kind(kind):
    if kind.startswith("spot_check"):
        return "spot checks"
    if kind == "label_check":
        return "second looks"
    if kind.startswith("correction"):
        return "corrections"  # a person volunteered it; nobody was asked
    return "asked"


def main():
    out = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    db = Client(admin_token(), "admin")
    months = defaultdict(Counter)
    asked_by_kind = defaultdict(Counter)
    for d in db.sql("SELECT at, shadow FROM decision"):
        if not d["shadow"]:
            months[d["at"][:7]]["decisions"] += 1
    for a in db.sql("SELECT created_at, kind, status FROM ask"):
        m, k = a["created_at"][:7], ask_kind(a["kind"])
        months[m][k] += 1
        if k == "asked":
            asked_by_kind[a["kind"]][m] += 1
    for r in db.sql("SELECT at, role, command, outcome FROM activity WHERE outcome = 'committed'"):
        if r["role"] not in PEOPLE:
            continue
        if r["command"] == "answer_ask":
            months[r["at"][:7]]["answered"] += 1
        elif r["command"] in ONLY_PEOPLE:
            months[r["at"][:7]][ONLY_PEOPLE[r["command"]]] += 1
    order = sorted(months)
    print("| Month | " + " | ".join(c.capitalize() for c in COLUMNS) + " |")
    print("|---" * (len(COLUMNS) + 1) + "|")
    total = Counter()
    for m in order:
        total.update(months[m])
        print(f"| {m} | " + " | ".join(str(months[m][c]) for c in COLUMNS) + " |")
    print("| all | " + " | ".join(str(total[c]) for c in COLUMNS) + " |")
    print("\nQuestions the seats asked, by kind:")
    for kind, per in sorted(asked_by_kind.items(), key=lambda kv: -sum(kv[1].values())):
        print(f"  {kind}: {sum(per.values())}  (" + ", ".join(f"{m} {per[m]}" for m in order if per[m]) + ")")
    if out:
        json.dump({"months": {m: dict(months[m]) for m in order}, "total": dict(total),
                   "askedByKind": {k: dict(v) for k, v in asked_by_kind.items()}}, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()
