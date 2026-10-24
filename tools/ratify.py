"""Act as controller Dana: activate skill proposals and ratify policies whose proof passed the gate."""
import json
import os
import sys

from stdb import Client

ids_file = sys.argv[1] if len(sys.argv) > 1 else "../data/dev/identities.json"
dana = Client(json.load(open(ids_file))["Dana"]["token"], "Dana")
for s in dana.sql("SELECT key, status, proof FROM skill"):
    if s["status"] == "proposed" and json.loads(s["proof"] or "{}").get("gate") == "pass":
        dana.call("set_skill_status", s["key"], "active", 0.0)
        print("activated", s["key"])
for p in dana.sql("SELECT key, status, proof, text FROM policy"):
    if p["status"] == "proposed" and json.loads(p["proof"] or "{}").get("gate") == "pass":
        dana.call("decide_policy", p["key"], True)
        print("ratified", p["key"], p["text"])
