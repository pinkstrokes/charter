"""The live demo's steps, resolved against the prepared databases: which screen each
beat opens and which row's Why panel. Printed as JSON for the step bar.
  STDB_URL=http://127.0.0.1:3100 python3 tools/demo/steps.py > ~/Developer/charter-demo-stdb/steps.json"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import stdb  # noqa: E402
from stdb import Client, admin_token  # noqa: E402


def client(db):
    stdb.DB = db
    return Client(admin_token(), "admin")


def used(a, tag):
    return tag in json.loads(a["used"] or "[]")


# Company B: the question that undid an earlier guess (the B-15061 moment).
b = client("charter-b")
moment = min(a["id"] for a in b.sql("SELECT id, kind, command FROM activity WHERE command = 'misapplied'") if a["kind"] == "ask")
# Company B: the first notice the kernel refused because the customer's own money covered it (C16).
refusals = sorted(b.sql("SELECT value, valid_from FROM fact WHERE attr = 'notice_refused'"), key=lambda f: f["valid_from"])
right_alone = json.loads(refusals[0]["value"])["activity"]

# Company A: the latest collections hold inside the grace period, for "This was wrong".
a = client("charter-a")
holds = [d for d in a.sql("SELECT id, domain, outcome, shadow, features FROM decision WHERE domain = 'pre_chase'")
         if d["outcome"] == "hold" and not d["shadow"] and 0 < json.loads(d["features"]).get("days_past_due", 0) <= json.loads(d["features"]).get("grace_days", 0)]
hold = max(holds, key=lambda d: d["id"])
pushback = max(x["id"] for x in a.sql("SELECT id, used FROM activity") if used(x, f"decision:{hold['id']}"))

# The pitch's beats in order (across agents; across time; steal, release, push back; learned; proof),
# then the judges' own payment.
steps = [
    {"label": "Right alone", "db": "charter-b", "hash": f"#/floor?why={right_alone}"},
    {"label": "The moment", "db": "charter-b", "hash": f"#/inbox?why={moment}"},
    {"label": "Try to steal", "db": "charter-a", "hash": "#/security"},
    {"label": "Release it", "db": "charter-a", "hash": "#/payables"},
    {"label": "Push back", "db": "charter-a", "hash": f"#/floor?why={pushback}"},
    {"label": "Learned", "db": "charter-b", "hash": "#/knowledge/allocation"},
    {"label": "Proof", "db": "charter-b", "hash": "#/proof"},
    {"label": "Your payment", "db": "charter-b", "hash": "#/world/payment"},
]
print(json.dumps({"persona": "dana", "steps": steps}, indent=1))
