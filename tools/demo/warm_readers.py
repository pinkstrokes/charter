"""Read the demo's preset bank-change email once, before the table, and carry both readings into
company A's model cache, so step 4 does not wait on a live model call. The draft is built the way
the Security screen builds it (web/src/screens/Security.tsx, the first preset) and the prompt the way
the mailroom builds it (module seats.ts triage), so the cache key is the one the seat will look up.
A judge's own email is still read live; if a reader does not answer, the email waits for a person.
  STDB_URL=http://127.0.0.1:3100 STDB_DB=charter-a python3 tools/demo/warm_readers.py"""
import hashlib
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from stdb import Client, admin_token, load_key  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
ENDPOINT = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
ROLE_MAILBOXES = {"ar", "ap", "accounts", "billing", "finance", "info", "admin", "office", "sales", "owner", "payments"}
SYMBOL = {"USD": "$", "GBP": "£", "EUR": "€"}


def person_name(email, entity):
    local = email.split("@")[0]
    surname = entity["name"].split()[0]
    if re.fullmatch(r"[a-z]{2,10}", local, re.I) and local.lower() not in ROLE_MAILBOXES:
        return f"{local[0].upper()}{local[1:]} {surname}"
    return f"{entity['name']} accounts"


def money(cents, currency):
    return f"{SYMBOL.get(currency, currency + ' ')}{cents // 100:,}.{cents % 100:02d}"


def extract_system():
    src = open(os.path.join(ROOT, "module/spacetimedb/src/seats.ts")).read()
    m = re.search(r"const EXTRACT_SYSTEM = `(.*?)`;", src, re.S)
    if not m or "${" in m.group(1):
        raise SystemExit("could not read EXTRACT_SYSTEM from seats.ts")
    return m.group(1)


def read(model, system, user, key):
    body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_tokens": 600, "temperature": 0, "enable_thinking": False, "response_format": {"type": "json_object"}}
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


def main():
    admin = Client(admin_token(), "admin")
    cfg = admin.sql("SELECT sim_date, currency, llm_model, checker_model FROM config")[0]
    entities = {e["code"]: e for e in admin.sql("SELECT code, name, contact_email FROM entity")}
    due = sorted([p for p in admin.sql("SELECT vendor_code, amount_cents, status FROM payment") if p["status"] == "prepared"], key=lambda p: -int(p["amount_cents"]))
    if not due:
        raise SystemExit("no prepared payment: the preset is not shown")
    v = entities[due[0]["vendor_code"]]
    amount = money(int(due[0]["amount_cents"]), cfg["currency"])
    body = (f"Hello,\n\nOur bank account is closing this week. Please send today's payment of {amount} to our new account ending 7713, routing 026009593. "
            f"The old account will reject transfers from Monday.\n\nThanks for updating this before the run,\nAccounts receivable, {v['name']}")
    text = f"From: {person_name(v['contact_email'], v)} <{v['contact_email']}>\nSubject: Updated remittance details\n\n{body}\n"
    system, key = extract_system(), load_key()
    carried = []
    for purpose, model in (("extract", cfg["llm_model"]), ("extract-check", cfg["checker_model"])):
        if not model:
            continue
        h = hashlib.sha256(f"{model}|{system}|{text}".encode()).hexdigest()
        if admin.sql(f"SELECT id FROM llm_call WHERE prompt_hash = '{h}' AND status = 200"):
            print(f"{model}: already cached")
            continue
        response = read(model, system, text, key)
        carried.append({"at": cfg["sim_date"], "purpose": purpose, "model": model, "promptHash": h, "response": response})
        print(f"{model}: {response[:120]}")
    if carried:
        admin.call("carry_llm_calls", json.dumps(carried))
    print(f"preset from {v['contact_email']} about {amount}: {len(carried)} reading(s) carried")


if __name__ == "__main__":
    main()
