"""Read-only: every cash-application decision of companies B and C with when it was made,
what the seat saw, what each outcome would have done, the label a person gave if any, and the
answer key's truth and split. Only SELECTs. Writes tools/certify/data/decisions-<co>.json.
For the team check it also writes company A's collections decisions (decisions-a-prechase.json)
and Patel Brews's open invoices, contract terms and the ratified policies (a-f02.json)."""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MAIN = os.path.expanduser("~/Developer/charter")  # the runs' answer keys live in the main checkout's data/
sys.path.insert(0, os.path.join(ROOT, "tools"))
import stdb  # noqa: E402
from stdb import Client, admin_token  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
for db, key in (("charter-b", "data/companyB/answer_key.json"), ("charter-c", "data/companyC/answer_key.json"), ("charter-c0", "data/companyC-alone/answer_key.json")):
    stdb.DB = db
    c = Client(admin_token(), "admin")
    k = json.load(open(os.path.join(MAIN, key)))
    entries = {e["subject"]: e for e in (k["entries"] if isinstance(k, dict) else k)}
    rows = []
    for d in sorted(c.sql("SELECT id, at, seat, domain, subject, features, skill_key, outcome, rule_index, shadow, label, label_source, treatments FROM decision"), key=lambda d: d["id"]):
        if d["domain"] != "allocation":
            continue
        e = entries.get(d["subject"], {})
        rows.append({"id": d["id"], "at": d["at"], "subject": d["subject"], "f": json.loads(d["features"]), "t": json.loads(d["treatments"] or "{}"),
                     "skill": d["skill_key"], "outcome": d["outcome"], "rule": d["rule_index"], "shadow": d["shadow"], "label": d["label"], "labelSource": d["label_source"],
                     "split": e.get("split"), "family": (e.get("family") or "").removeprefix("payment_"), "truth": sorted((e.get("truth") or {}).get("invoices", []))})
    path = os.path.join(OUT, f"decisions-{db.split('-', 1)[1]}.json")
    json.dump(rows, open(path, "w"), separators=(",", ":"))
    print(db, len(rows), "decisions;", sum(1 for r in rows if r["label"]), "labeled;", sum(1 for r in rows if r["shadow"]), "shadow;", "splits", {s: sum(1 for r in rows if r["split"] == s) for s in ("train", "val", "test", "live", None)}, os.path.getsize(path) // 1024, "KB")

stdb.DB = "charter-a"
a = Client(admin_token(), "admin")
rows = [{"id": d["id"], "at": d["at"], "subject": d["subject"], "f": json.loads(d["features"]), "skill": d["skill_key"], "outcome": d["outcome"], "label": d["label"]}
        for d in sorted(a.sql("SELECT id, at, domain, subject, features, skill_key, outcome, label FROM decision"), key=lambda d: d["id"]) if d["domain"] == "pre_chase"]
inv = [i for i in a.sql("SELECT id, entity_code, kind, amount_cents, open_cents, due_at, issued_at, status FROM invoice") if i["entity_code"] == "F02" and i["open_cents"] > 0]
pol = [{"id": p["policy_id"], "template": json.loads(p["template"]), "text": p["text"], "status": p["status"]} for p in a.sql("SELECT policy_id, template, text, status FROM policy") if p["status"] == "active" and p["policy_id"].startswith("P-")]
terms = {x["version"]: json.loads(x["terms_json"]) for x in a.sql("SELECT version, terms_json FROM contract_version")}
json.dump(rows, open(os.path.join(OUT, "decisions-a-prechase.json"), "w"), separators=(",", ":"))
json.dump({"party": "F02", "name": "Patel Brews Inc", "contract": "FA-2025", "terms": terms["FA-2025"], "open": inv, "policies": pol}, open(os.path.join(OUT, "a-f02.json"), "w"), indent=1)
print("charter-a", len(rows), "pre_chase decisions;", len(inv), "open F02 invoices; policies", [p["id"] for p in pol])
