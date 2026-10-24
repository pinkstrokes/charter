"""Run company A's six months against the database, one business day at a time.

    python3 tools/world/run.py --reset                    # fresh company, Jan 5 through Jun 28
    python3 tools/world/run.py --reset --until 2026-03-31 --fast
    python3 tools/world/run.py --until 2026-06-28         # resume where the last run stopped

Each day: set_sim_date (feeder) -> ingest the day's observations -> the bank
settles and returns debits -> run_seats -> the staff answer due questions,
perform audits and act -> after Sunday the evolution hook (evolve.ts --once,
then Dana ratifies what passed the gate) -> on the first business day of a
month Dana closes the previous period. One line per day goes to stdout; the
detail goes to data/companyA/run.log.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import stdb  # noqa: E402
from stdb import Client, admin_token, identity_arg, load_key, new_identity  # noqa: E402

from bank import Bank  # noqa: E402
from common import DATA, REPO, add_days, all_days, day_name, is_business_day, read_json, weekday, write_json  # noqa: E402
from staff import Staff  # noqa: E402
from texts import Texts  # noqa: E402

ROSTER = [("Dana", "controller"), ("Sam", "controller"), ("Lee", "consultant"), ("Priya", "consultant"), ("feeder", "world"),
          ("evolver", "evolver"), ("auditor", "auditor"), ("outsider", "")]
STATE = DATA / "run_state.json"
LOG = DATA / "run.log"


class Person(Client):
    def ingest(self, kind: str, source: str, valid_at: str, ref_key: str, subject: str, payload: dict) -> None:
        self.call("ingest_obs", kind, source, valid_at, ref_key, subject, json.dumps(payload))


def log(msg: str) -> None:
    with open(LOG, "a") as f:
        f.write(msg + "\n")


def identities(admin: Client, bind: bool) -> dict:
    """The staff's identities, kept in data/companyA/identities.json (gitignored) so the UI can act as them."""
    path = DATA / "identities.json"
    ids = read_json(path, {})
    for name, role in ROSTER:
        if name not in ids:
            ident, token = new_identity()
            ids[name] = {"identity": ident, "token": token, "role": role}
        ids[name]["role"] = role
        if bind and role:
            st, text = admin.call("bind_role", identity_arg(ids[name]["identity"]), role, name, check=False)
            if st != 200:
                print(f"note: could not bind {name} as {role}: {text[:120]}")
                ids[name]["bound"] = False
            else:
                ids[name]["bound"] = True
    write_json(path, ids)
    return ids


def first_business_day_of_month(day: str) -> bool:
    if not is_business_day(day):
        return False
    d = day[:8] + "01"
    while d < day:
        if is_business_day(d):
            return False
        d = add_days(d, 1)
    return True


class Runner:
    def __init__(self, args):
        self.args = args
        stdb.DB = args.db
        self.world = read_json(DATA / "world.json")
        self.company = read_json(DATA / "company.json")
        self.admin = Client(admin_token(), "admin")
        self.texts = Texts()
        self.by_day: dict[str, list[dict]] = {}
        for o in self.world["observations"]:
            self.by_day.setdefault(o["date"], []).append(o)
        self.ratified: list[str] = []
        self.hook_log: list[dict] = []
        self.close_log: list[dict] = []
        self.failures = 0

    def setup(self) -> None:
        if self.args.reset:
            self.admin.call("reset_company")
            LOG.write_text("")
        self.ids = identities(self.admin, bind=self.args.reset)
        self.c = {name: Person(v["token"], f"{v['role'] or 'unbound'}:{name}") for name, v in self.ids.items()}
        if self.args.reset:
            self.admin.call("set_secret", "MODELSTUDIO_API_KEY", load_key())
            # The final run's email readings, so a replay on a fresh database reads every email the same way.
            carried = read_json(DATA / "module_llm_cache.json", {}).get("calls", [])
            if carried:
                self.admin.call("carry_llm_calls", json.dumps(carried))
            self.c["feeder"].call("load_company", json.dumps(self.company))
            self.state = {"last_day": None, "staff": {}, "wall_seconds": 0.0, "seat_calls": 0, "ratified": [], "hooks": [], "closes": []}
            write_json(STATE, self.state)
        else:
            self.state = read_json(STATE, None)
            if not self.state:
                sys.exit("no run_state.json: start with --reset")
        self.ratified, self.hook_log, self.close_log = self.state["ratified"], self.state["hooks"], self.state["closes"]
        self.bank = Bank(self.world, self.c["feeder"], log)
        self.staff = Staff(self.world, self.c, self.texts, self.args.fast, log, self.state["staff"])

    def days(self) -> list[str]:
        start = self.world["window"][0] if not self.state["last_day"] else add_days(self.state["last_day"], 1)
        return [d for d in all_days(start, self.args.until)]

    def run(self) -> None:
        t_start = time.time()
        for day in self.days():
            t0 = time.time()
            log(f"== {day} {day_name(day)}")
            feeder = self.c["feeder"]
            feeder.call("set_sim_date", day)
            arrivals = self.by_day.get(day, [])
            for o in arrivals:
                feeder.ingest(o["kind"], o["source"], o["validAt"], o["refKey"], o["subject"], o["payload"])
            for p in self.staff.due_payments(day):
                feeder.ingest("bank_txn", "bank", day, f"bank:{p['payload']['txnId']}", f"account:{p['payload']['counterpartyAccount']}", p["payload"])
            bank = self.bank.step(day)
            seats = self.run_seats()
            self.failures = self.failures + 1 if "FAILED" in seats else 0
            if self.failures >= 2:
                print(f"{day}: run_seats failed twice in a row; stopping (see run.log and `spacetime logs {self.args.db}`)")
                break
            people = self.staff.step(day)
            extra = []
            if weekday(day) == 6:
                extra += self.weekly_hook(day)
            if first_business_day_of_month(day):
                extra += self.close_month(day)
            kinds = Counter(o["kind"] for o in arrivals)
            line = (f"{day} {day_name(day)} | in {len(arrivals):3d} (bank {kinds['bank_txn'] + bank['settled'] + bank['returned']:2d}) | "
                    f"{seats} | answered {people['answered']:2d}" + (f" | audits closed {people['audits']}" if people["audits"] else "")
                    + "".join(f" | {e}" for e in people["events"] + extra) + f" | {time.time() - t0:.1f}s")
            print(line, flush=True)
            log(line)
            self.state["last_day"] = day
            self.state["wall_seconds"] += time.time() - t0
            write_json(STATE, self.state)
        print(f"done through {self.state['last_day']}: {time.time() - t_start:.0f}s this run, {self.state['wall_seconds']:.0f}s in total")

    def run_seats(self) -> str:
        """Call the run_seats procedure; again if triage hit its 15-email limit."""
        parts = []
        for _ in range(4):
            st, text = self.c["feeder"].call("run_seats", check=False)
            self.state["seat_calls"] += 1
            if st != 200:
                log(f"  ! run_seats -> {st} {text[:300]}")
                return f"run_seats FAILED {st}"
            summary = json.loads(text) if text.startswith('"') else text
            log(f"  seats: {summary}")
            parts.append(summary)
            if not summary.startswith("triage 15 "):
                break
        return compact(parts)

    def weekly_hook(self, day: str) -> list[str]:
        """After each simulated Sunday: let the evolver propose, then Dana ratifies whatever passed its gate."""
        out = []
        evolve = REPO / "tools" / "evolve" / "evolve.ts"
        if evolve.exists() and not self.args.no_evolve:
            t0 = time.time()
            try:
                p = subprocess.run(["npx", "tsx", "tools/evolve/evolve.ts", "--once", "--db", self.args.db], cwd=REPO, capture_output=True, text=True,
                                   timeout=1800, env={**os.environ, "STDB_DB": self.args.db})
                lines = [x for x in (p.stdout + p.stderr).splitlines() if x.strip()]
                status = "ok" if p.returncode == 0 else f"exit {p.returncode}"
            except (subprocess.TimeoutExpired, OSError) as e:
                lines, status = [str(e)], "failed"
            for x in lines:
                log(f"  evolve: {x}")
            self.hook_log.append({"day": day, "status": status, "seconds": round(time.time() - t0, 1), "lines": lines[-12:]})
            out.append(f"evolve {status} {time.time() - t0:.0f}s")
        elif not evolve.exists():
            log("  evolve: tools/evolve/evolve.ts not found; skipped")
        dana = self.c["Dana"]
        for s in dana.sql("SELECT key, status, proof FROM skill"):
            if s["status"] == "proposed" and json.loads(s["proof"] or "{}").get("gate") == "pass":
                st, text = dana.call("set_skill_status", s["key"], "active", 0.0, check=False)
                self.ratified.append({"day": day, "kind": "skill", "key": s["key"], "ok": st == 200, "result": text[:300]})
                log(f"  Dana activated {s['key']}: {text[:300]}")
                out.append(f"activated {s['key']}")
        for p in dana.sql("SELECT key, status, proof, text FROM policy"):
            if p["status"] == "proposed" and json.loads(p["proof"] or "{}").get("gate") == "pass":
                st, text = dana.call("decide_policy", p["key"], True, check=False)
                self.ratified.append({"day": day, "kind": "policy", "key": p["key"], "text": p["text"], "ok": st == 200, "result": text[:300]})
                log(f"  Dana ratified {p['key']}: {p['text']}")
                out.append(f"ratified {p['key']}")
        return out

    def close_month(self, day: str) -> list[str]:
        """Month-end for the previous period: the internal auditor reports, then Dana closes the books (or is told why not)."""
        period = add_days(day[:8] + "01", -1)[:7]
        if period < self.world["window"][0][:7]:
            return []
        auditor = REPO / "tools" / "audit" / "auditor.ts"
        if auditor.exists():
            try:
                p = subprocess.run(["npx", "tsx", "tools/audit/auditor.ts", "--db", self.args.db, "--period", period], cwd=REPO, capture_output=True, text=True,
                                   timeout=900, env={**os.environ, "STDB_DB": self.args.db})
                for x in (p.stdout + p.stderr).splitlines()[-15:]:
                    log(f"  auditor: {x}")
                audit = "auditor ok" if p.returncode == 0 else f"auditor exit {p.returncode}"
            except (subprocess.TimeoutExpired, OSError) as e:
                audit = f"auditor failed ({e})"
        else:
            st, text = self.c["auditor"].call("record_opinion", period, "clean", 0, 0, 0, 0, json.dumps({"note": "placeholder: auditor tool not run"}), check=False)
            audit = "placeholder opinion" if st == 200 else f"placeholder opinion failed {text[:100]}"
        log(f"  internal audit of {period}: {audit}")
        st, text = self.c["Dana"].call("close_period", period, check=False)
        rows = self.c["Dana"].sql("SELECT id, outcome, reasons FROM activity WHERE command = 'close_period'")
        last = max(rows, key=lambda r: r["id"]) if rows else None
        ok = st == 200 and last is not None and last["outcome"] == "committed"
        why = "" if ok else (json.loads(last["reasons"]) if last and last["reasons"] else [text[:200]])
        self.close_log.append({"day": day, "period": period, "audit": audit, "closed": ok, "reasons": why})
        log(f"  Dana close_period {period}: {'closed' if ok else f'refused: {why}'}")
        return [f"close {period} {'ok' if ok else 'refused'}"]


def compact(parts: list[str]) -> str:
    """The seats' summary ('triage 3 | cash_app reports 2, receipts 1, debits 0 | ... | payments payments prepared 1') in one short row."""
    totals: Counter = Counter()
    for summary in parts:
        for chunk in summary.split(" | "):
            seat, _, rest = chunk.partition(" ")
            for m in re.finditer(r"([a-z]+) (-?\d+)", rest if seat != "triage" else chunk):
                totals[f"{seat}.{m.group(1)}"] += int(m.group(2))
    cols = [("mail", "triage.triage"), ("rep", "cash_app.reports"), ("rcpt", "cash_app.receipts"), ("debit", "cash_app.debits"), ("notice", "collections.notices"),
            ("fee", "collections.fees"), ("refund", "refunds.prepared"), ("bill", "ap_clerk.bills"), ("pay", "payments.prepared")]
    return " ".join(f"{label} {totals[k]:2d}" for label, k in cols)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reset", action="store_true", help="wipe the company, bind identities, load company.json")
    ap.add_argument("--until", default="2026-06-28")
    ap.add_argument("--fast", action="store_true", help="template reasons instead of model prose")
    ap.add_argument("--db", default="charter-a")
    ap.add_argument("--no-evolve", action="store_true", help="skip the weekly evolve.ts call (still ratifies)")
    ap.add_argument("--no-report", action="store_true")
    args = ap.parse_args()
    r = Runner(args)
    r.setup()
    try:
        r.run()
    finally:
        write_json(STATE, r.state)
        print(f"texts: {r.texts.calls} model calls this run ({len(r.texts.cache)} cached)")
    if not args.no_report and r.state["last_day"] == r.world["window"][1]:
        from report import build
        build(r.c["Dana"], r.world, r.state, r.texts)


if __name__ == "__main__":
    main()
