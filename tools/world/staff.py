"""The people at Pearl Lane: Dana and Sam (controllers), Lee and Priya (field consultants).

After the seats run each day they read the questions addressed to them, the open
asks (besides the bank's debit list, the only thing the world reads from the
database), and answer within the ask's deadline from what they know to be true.
They also do what only people do: Lee raises the March concern about #14, the
consultants perform the audits people requested, Dana endorses bank changes a
callback confirmed, hires the refunds seat, and corrects a few decisions she can
see were wrong once an owner complains. A few answers are wrong on purpose; the
answer key registered them before the run.

Every answer carries one sentence of reason in the person's voice (qwen3.8-flash,
cached in texts.json; --fast uses templates).
"""
from __future__ import annotations

import json
import re

from cast import STAFF, entity, store, stores_of, terms_for_store
from common import add_days, bp_of, business_day_on_or_after, is_business_day, money, next_business_day, stable_int, weekday
from scenarios import audit_payment_txn
from texts import Texts

ENTITY_BY_NAME = {}
for _code in [f"F{i:02d}" for i in range(1, 15)]:
    ENTITY_BY_NAME[entity(_code)["name"]] = _code

REASON_SYSTEM = ("You are {voice}. Your finance team's software asked you a question and you have decided the answer. "
                 "Write ONE plain sentence (at most 30 words) giving your reason, in your own voice. No preamble, no quotes, do not restate the question.")
ESCALATE = {"flag_audit", "ask_consultant"}


def consultant_for_entity(code: str) -> str:
    return store(stores_of(code)[0])["consultant"]


class Staff:
    def __init__(self, world: dict, clients: dict, texts: Texts, fast: bool, log, state: dict):
        self.k = world["staff"]
        self.c, self.texts, self.fast, self.log = clients, texts, fast, log
        self.s = state
        for key, default in [("audits", []), ("payments", []), ("routing_ids", {}), ("endorse", []), ("second_approval", []), ("done", []),
                             ("answers", []), ("reactive_receipts", {}), ("skipped", [])]:
            self.s.setdefault(key, default)
        self.receipts = {**self.k["receipts"], **self.s["reactive_receipts"]}
        self.dispute_done = {d["case"] for d in self.k["disputes"] if d["case"] in self.s["done"]}

    # ---------- the day ----------

    def step(self, day: str) -> dict:
        counts = {"answered": 0, "audits": 0, "events": []}
        for ev in [e for e in self.k["events"] if e["date"] == day]:
            self._event(day, ev, counts)
        for a in sorted(self.c["Dana"].sql("SELECT id, created_at, kind, subject, to_role, question, options, evidence, deadline FROM ask WHERE status = 'open'"),
                        key=lambda a: a["id"]):
            if self._answer(day, a):
                counts["answered"] += 1
        counts["audits"] = self._close_due_audits(day)
        self._call_desk(day)
        self._endorse(day)
        self._second_approvals(day)
        self._corrections(day, counts)
        return counts

    def due_payments(self, day: str) -> list[dict]:
        """Owners' payments of audit invoices that fall due today (ingested by the runner with the day's mail)."""
        return [p for p in self.s["payments"] if p["date"] == day]

    # ---------- answering ----------

    def _answer(self, day: str, a: dict) -> bool:
        kind = a["kind"]
        handler = {"audit": self._audit, "callback": self._callback, "allocation": self._allocation, "identify_payer": self._identify,
                   "unapplied_cash": self._unapplied, "refund_release": self._refund, "collections": self._collections, "dispute": self._dispute,
                   "royalty_decrease": self._royalty_decrease, "unknown_report": lambda d, a: ("Dana", "ignore", "no store matches; asked the sender to resend", None)}
        if kind.startswith("spot_check:"):
            decided = self._spot_check(day, a)
        elif kind in handler:
            decided = handler[kind](day, a)
        else:
            self._skip(a, f"no persona handles '{kind}'")
            return False
        if decided is None:
            return False
        who, answer, context, when = decided
        if when:
            when = min(when, a["deadline"])
        if when and day < when:
            return False
        if not when and day < self._default_day(a):
            return False
        options = json.loads(a["options"] or "[]")
        if kind != "identify_payer" and answer not in options:
            self._skip(a, f"answer '{answer}' not among {options}")
            return False
        reason = self._reason(who, a, answer, context)
        st, text = self.c[who].call("answer_ask", a["id"], answer, reason, check=False)
        ok = st == 200
        self.s["answers"].append({"day": day, "ask": a["id"], "kind": kind, "subject": a["subject"], "answer": answer, "by": who, "ok": ok,
                                  "human_error": self._is_error(a, answer)})
        if not ok:
            self.log(f"  ! {who} answer_ask #{a['id']} {kind} -> {text[:160]}")
            return False
        self.log(f"  {who} answered #{a['id']} {kind} {a['subject']}: {answer}")
        self._after_answer(day, a, answer)
        return True

    def _default_day(self, a: dict) -> str:
        """0-2 business days after the question, never past its deadline."""
        lag = stable_int("lag", a["kind"], a["subject"]) % 3
        d = add_days(a["created_at"], lag)
        while d > a["created_at"] and not is_business_day(d):
            d = add_days(d, -1)
        if not is_business_day(d):
            d = business_day_on_or_after(a["created_at"])
        return min(d, a["deadline"])

    def _is_error(self, a: dict, answer: str) -> bool:
        he = self.k["human_errors"]
        return he.get(a["subject"]) == answer or he.get(f"collections:{a['subject'].split(':', 1)[-1]}:{a['created_at']}") == answer

    # ---------- one handler per kind of question: (who, answer, what they know, planned day) ----------

    def _audit(self, day, a):
        _, code, week = a["subject"].split(":")
        sw = self.k["store_weeks"].get(f"{code}:{week}", {})
        who = store(code)["consultant"]
        if sw.get("human_error"):
            return who, sw["human_error"], "you suspected something but had no evidence beyond the numbers", None
        if sw.get("underreported"):
            return who, "request audit", self._audit_context(a, sw, True), None
        return who, "explained — accept report", self._audit_context(a, sw, False), None

    def _audit_context(self, a, sw, under: bool) -> str:
        f = json.loads(a["evidence"] or "{}").get("features", {})
        code = a["subject"].split(":")[1]
        bits = []
        if f:
            bits.append(f"reported {money(int(f.get('reported_gross', 0)))}, supplies imply {money(int(f.get('supply_implied_gross', 0)))}, "
                        f"cash share {float(f.get('cash_share', 0)):.0%} vs its usual {float(f.get('own_cash_share_history', 0)):.0%}")
        if under:
            bits.append("you believe the owner kept cash sales off the report" if sw.get("planted") == "underreported_cash" else "card sales are below what the processor settled")
        elif code in ("S23", "S36"):
            bits.append("it is an office-district store that has always taken almost no cash")
        else:
            bits.append("you know this store's numbers are honest (a bulk buy, a promo or normal noise explains the gap)")
        return "; ".join(bits)

    def _callback(self, day, a):
        m = re.match(r"(.+?) asked by email to move money to account (\*{4}\S+?)\.", a["question"])
        name, account = (m.group(1), m.group(2)) if m else ("", "")
        ent = ENTITY_BY_NAME.get(name, "")
        case = next((r for r in self.k["callbacks"] if r["entity"] == ent and r["account"] == account), None)
        self.s["routing_ids"][case["case"] if case else f"{ent}:{account}"] = int(a["subject"].split(":")[1])
        who = consultant_for_entity(ent) if ent else "Lee"
        if not case:  # nobody planned this change: the owner, reached on the number on file, did not ask for it
            return who, "denied", f"you called {entity(ent)['owner'] if ent else 'the owner'} on the number on file and they never asked for a bank change", None
        first = case["callbacks"][0]
        when = first[0]
        owner = entity(ent)["owner"]
        context = {"confirmed": f"you called {owner} at {entity(ent)['phone']} (on file) and {owner} confirmed the new account",
                   "denied": f"you called {owner} at {entity(ent)['phone']} (on file, not the number in the email) and {owner} said they never sent it",
                   "no_answer": f"you called {entity(ent)['phone']} (on file) and got voicemail; will try again tomorrow"}[first[2]]
        return first[1], first[2], context, min(when, a["deadline"])

    def _allocation(self, day, a):
        txn = a["subject"].split(":", 1)[1]
        rc = self.receipts.get(txn)
        options = json.loads(a["options"] or "[]")
        if not rc:
            return "Dana", "apply oldest first", "you could not tell what this payment was for", None
        wrong = self.k["human_errors"].get(a["subject"])
        if wrong:
            return "Dana", wrong, "busy close week; took the contract-order option without opening the remittance", None
        want = sorted(rc["intended"] or [])
        match = next((o for o in options if o != "apply oldest first" and sorted(o.split(" + ")) == want), None)
        if match:
            return "Dana", match, f"the payer's remittance lists exactly {' + '.join(want)}", None
        if rc["family"] == "duplicate_payment":  # none of the options is right: it should stay unapplied until it is refunded
            self._skip(a, "duplicate payment: leaving it unapplied for the refund")
            return None
        return "Dana", "apply oldest first", "the amount matches no invoice set; it is a short payment with a dispute, so apply it and settle the gap on the dispute", None

    def _identify(self, day, a):
        txn = a["subject"].split(":", 1)[1]
        rc = self.receipts.get(txn)
        if not rc:
            self._skip(a, "unknown payer the world did not plan")
            return None
        e = entity(rc["entity"])
        return "Dana", rc["entity"], f"\"{rc.get('payer')}\" is {e['owner']}, who owns {e['name']}; she recognized the name", rc.get("identify_on")

    def _unapplied(self, day, a):
        txn = a["subject"].split(":", 1)[1]
        rc = self.receipts.get(txn, {})
        if rc.get("family") == "duplicate_payment":
            return "Dana", "refund", "the wire repeats an invoice that the Wednesday debit already collected; the owner should get it back", None
        return "Dana", "keep as credit", "money with nothing to pay yet; keep it on account until the next invoice", None

    def _refund(self, day, a):
        m = re.search(r"refund of \$([\d,]+\.\d{2}) to (.+?) at the account on file", a["question"])
        amount = int(round(float(m.group(1).replace(",", "")) * 100)) if m else 0
        ent = ENTITY_BY_NAME.get(m.group(2), "") if m else ""
        planned = [r for r in self.k["refunds"] if r["entity"] == ent and amount <= r["amount"]]
        if planned:
            if amount > 500_000:
                self.s["second_approval"].append({"refund": int(a["subject"].split(":")[1]), "date": day})
            return "Sam", "release", f"duplicate payment of {money(amount)} confirmed on the bank statement; it goes back to the account on file", None
        return "Sam", "cancel", "no duplicate or overpayment on this account that I can verify", None

    def _collections(self, day, a):
        ent = a["subject"].split(":", 1)[1]
        wrong = self.k["human_errors"].get(f"collections:{ent}:{a['created_at']}")
        who = "Dana" if a["to_role"] == "controller" else consultant_for_entity(ent)
        if wrong:
            return who, wrong, "you did not see the owner's email before answering", None
        w = next((w for w in self.k["collections"] if w["entity"] == ent and w["from"] <= a["created_at"] <= w["to"]), None)
        if w:
            return who, w["answer"], {"PIT1": "Anita mailed check #4410 for the fees", "PIT2": "Carmen mailed check #2207 for the NSF fee",
                                      "PIT3": "Ben mailed a check for the NSF fee", "RC2": "the debit bounced because we used the account Emily told us was closed",
                                      "LFD1": "Anita disputes the late fees and the re-presented debit is already in flight"}.get(w["case"], "a payment is on its way"), None
        open_dispute = any(d["entity"] == ent and d["date"] <= day and d["case"] not in self.dispute_done for d in self.k["disputes"])
        if open_dispute:
            return who, "hold 7 days", "the owner has an open dispute on part of the balance", None
        return who, "chase", "no payment promised and the balance is past the grace period", None

    def _dispute(self, day, a):
        ent = a["subject"].split(":", 1)[1]
        cands = [d for d in self.k["disputes"] if d["entity"] == ent and d["date"] <= day and d["case"] not in self.dispute_done]
        if not cands:
            return "Dana", "uphold", "the charges follow the franchise agreement", None
        d = cands[0]
        why = {"LFD1": "FA-2025 section 7.2 charges late fees on anything unpaid five days past due, and the debit bounced for insufficient funds",
               "LFD2": "we debited the account Emily told us on April 7 was closed; the fees are our mistake",
               "SP1": "the photos show torn pearl bags; credit the $92.40 deduction",
               "SP2": "the fuel surcharge is in FA-2022 schedule B, which they signed",
               "SP3": "the delivery receipt for that order is signed for every case"}.get(d["case"], "")
        self._dispute_pending = d["case"]
        return "Dana", d["answer"], why, d["answer_on"]

    def _royalty_decrease(self, day, a):
        plan = self.k["royalty_decreases"].get(a["subject"])
        if plan:
            return "Dana", plan["answer"], "the revised card total matches the processor's settlement; the first report counted Saturday's batch twice", plan["on"]
        return "Dana", "keep original", "the revision is not supported by the processor's settlement", None

    def _spot_check(self, day, a):
        """kind 'spot_check:<domain>': was an autonomous decision right? Options are 'correct' plus the domain's other outcomes."""
        domain = a["kind"].split(":", 1)[1]
        options = json.loads(a["options"] or "[]")
        ev = json.loads(a["evidence"] or "{}")
        dec = ev.get("decision")
        decided = ev.get("outcome") or ev.get("was") or (dec.get("outcome") if isinstance(dec, dict) else None)
        if not decided:
            decided = next((o for o in options if o != "correct" and f'"{o}"' in a["question"]), None)
        expected = self.expected_outcome(domain, a["subject"], ev.get("features", {}))
        who = "Dana"
        if domain == "underreport":
            who = store(a["subject"].split(":")[1])["consultant"]
        if expected is None or decided is None:
            return who, "correct", "nothing I know contradicts it", None
        same = (decided in ESCALATE) == (expected in ESCALATE) if domain == "underreport" else decided == expected
        if same:
            return who, "correct", f"'{decided}' is what I would have done", None
        if expected in options:
            return who, expected, f"should have been '{expected}', not '{decided}'", None
        alt = next((o for o in options if o in ESCALATE), None) if domain == "underreport" else None
        return (who, alt, f"should have gone to audit, not '{decided}'", None) if alt else (who, "correct", "close enough", None)

    def expected_outcome(self, domain: str, subject: str, features: dict) -> str | None:
        """What the staff know to be right for a seat decision (used for spot checks)."""
        if domain == "underreport":
            _, code, week = subject.split(":")
            sw = self.k["store_weeks"].get(f"{code}:{week}")
            return None if sw is None else "flag_audit" if sw["underreported"] else "accept"
        if domain == "allocation":
            return (self.receipts.get(subject.split(":", 1)[1]) or {}).get("expected")
        if domain == "routing_change":
            ent, refkey = subject.split(":", 1)[1].split(":", 1)
            case = next((r for r in self.k["callbacks"] if r["entity"] == ent and r["refKey"] == refkey), None)
            return None if case is None else "hold_and_verify" if case["legit"] else "reject"
        if domain == "pre_chase":
            _, ent, day = subject.split(":")
            if any(w["entity"] == ent and w["from"] <= day <= w["to"] for w in self.k["collections"]):
                return "hold"
            if features and float(features.get("days_past_due", 0)) <= float(features.get("grace_days", 0)):
                return "hold"
            return None if features.get("open_dispute") else "chase"
        return None

    # ---------- what follows an answer ----------

    def _after_answer(self, day, a, answer):
        if a["kind"] == "audit" and answer == "request audit":
            _, code, week = a["subject"].split(":")
            self._open_audit(day, code, week)
        if a["kind"] == "callback" and answer == "confirmed":
            self.s["endorse"].append({"id": int(a["subject"].split(":")[1]), "date": day})
        if a["kind"] == "dispute" and getattr(self, "_dispute_pending", None):
            self.dispute_done.add(self._dispute_pending)
            self.s["done"].append(self._dispute_pending)
            self._dispute_pending = None

    def _open_audit(self, day, code, week):
        if any(x["store"] == code and x["week"] == week for x in self.s["audits"]):
            return
        planned = next((p for p in self.k["planned_audits"] if p["store"] == code and p["week"] == week), None)
        if planned:
            close_on = max(planned["close_on"], day)
        else:
            close_on = business_day_on_or_after(add_days(day, 5 + stable_int("audit", code, week) % 6))
        self.s["audits"].append({"store": code, "week": week, "opened": day, "close_on": close_on, "closed": False})

    def _close_due_audits(self, day) -> int:
        n = 0
        for au in self.s["audits"]:
            if au["closed"] or au["close_on"] > day:
                continue
            code, week = au["store"], au["week"]
            sw = self.k["store_weeks"].get(f"{code}:{week}")
            if not sw:
                au["closed"] = True
                continue
            who = store(code)["consultant"]
            note = self._audit_note(who, code, week, sw)
            st, text = self.c[who].call("close_audit", code, week, sw["true_gross"], note, check=False)
            au["closed"] = True
            if st != 200:
                self.log(f"  ! close_audit {code} {week} -> {text[:160]}")
                continue
            n += 1
            self.log(f"  {who} closed the audit of {code} week {week}: true sales {money(sw['true_gross'])}")
            self._owner_pays_audit(day, code, week, sw)
        return n

    def _owner_pays_audit(self, day, code, week, sw):
        """The owner pays the audit invoice a few business days later (the world's reaction to the staff's audit)."""
        terms = terms_for_store(code)
        owed = bp_of(sw["true_gross"], terms["royaltyBp"]) - bp_of(max(sw["reported_grosses"]), terms["royaltyBp"])
        if owed <= 0:
            return
        ent = store(code)["entity"]
        e = entity(ent)
        react = self.k["audit_reactions"].get(f"{code}:{week}", {"method": "wire_in", "delay": 3})
        pay_on = next_business_day(day, react["delay"])
        txn = audit_payment_txn(react["method"], pay_on, code, week)
        payer = react.get("payer") or e["name"].upper().replace(".", "")
        payload = {"txnId": txn, "date": pay_on, "type": react["method"], "amountCents": owed, "counterpartyName": payer,
                   "counterpartyAccount": react.get("account") or e["bank"], "reference": f"A-{code}-{week}" if not react.get("payer") else f"AUDIT {code} WK {week}"}
        self.s["payments"].append({"date": pay_on, "payload": payload})
        known = {"entity": ent, "family": "audit_payment", "intended": [f"A-{code}-{week}"], "ask_answer": None, "identify_on": pay_on, "payer": payer,
                 "amount": owed, "expected": "apply_unique"}
        self.receipts.setdefault(txn, known)
        if txn not in self.k["receipts"]:
            self.s["reactive_receipts"][txn] = known

    def _call_desk(self, day):
        """Follow-up calls logged by the call desk (a trusted source) when the first call went to voicemail."""
        for r in self.k["callbacks"]:
            for when, who, outcome in r["callbacks"][1:]:
                if when != day or f"desk:{r['case']}" in self.s["done"]:
                    continue
                e = entity(r["entity"])
                payload = {"entityCode": r["entity"], "phoneUsed": e["phone"], "phoneSource": "master_data_asof", "outcome": outcome,
                           "note": f"second call by {consultant_for_entity(r['entity'])}; reached {e['owner']} on the number on file"}
                self.c["feeder"].ingest("callback", "callback_desk", day, f"callback:desk:{r['entity']}:{day}", f"entity:{r['entity']}", payload)
                self.s["done"].append(f"desk:{r['case']}")
                self.log(f"  call desk: {e['owner']} {outcome}")
                if outcome == "confirmed" and r["case"] in self.s["routing_ids"]:
                    self.s["endorse"].append({"id": self.s["routing_ids"][r["case"]], "date": day})

    def _endorse(self, day):
        for item in list(self.s["endorse"]):
            st, text = self.c["Dana"].call("endorse_routing", item["id"], check=False)
            if st == 200 or "applied" in text:
                self.s["endorse"].remove(item)
                self.log(f"  Dana endorsed bank change #{item['id']}")
            elif item["date"] < add_days(day, -3):
                self.s["endorse"].remove(item)
                self.log(f"  ! endorse_routing #{item['id']} -> {text[:160]}")

    def _second_approvals(self, day):
        for item in list(self.s["second_approval"]):
            st, text = self.c["Dana"].call("release_refund", item["refund"], check=False)
            self.s["second_approval"].remove(item)
            self.log(f"  Dana second approval on refund #{item['refund']}: {'ok' if st == 200 else text[:120]}")

    def _corrections(self, day, counts):
        """A person marks a decision wrong after an owner complains (a third of the mistakes they see, not all)."""
        for c in self.k["corrections"]:
            if c["date"] != day or f"fix:{c['subject']}" in self.s["done"]:
                continue
            self.s["done"].append(f"fix:{c['subject']}")
            rows = [r for r in self.c["Dana"].sql(f"SELECT id, outcome, shadow FROM decision WHERE subject = '{c['subject']}'") if not r["shadow"]]
            if not rows:
                continue
            last = max(rows, key=lambda r: r["id"])
            if last["outcome"] == c["outcome"]:
                continue
            st, text = self.c[c["actor"]].call("correct_decision", last["id"], c["outcome"], c["why"], check=False)
            self.log(f"  {c['actor']} corrected decision #{last['id']} on {c['subject']}: {last['outcome']} -> {c['outcome']}" + ("" if st == 200 else f" FAILED {text[:120]}"))
            if st == 200:
                counts["events"].append(f"correction {c['domain']}")

    # ---------- planned events ----------

    def _event(self, day, ev, counts):
        tag = f"event:{ev['action']}:{ev.get('store', ev.get('seat', ''))}:{ev.get('week', '')}"
        if tag in self.s["done"]:
            return
        self.s["done"].append(tag)
        if ev["action"] == "raise_concern":
            note = self._concern_note(ev)
            st, text = self.c[ev["actor"]].call("raise_concern", ev["store"], ev["week"], note, check=False)
            self.log(f"  {ev['actor']} raised a concern on {ev['store']} week {ev['week']}: {note}" + ("" if st == 200 else f" FAILED {text[:160]}"))
            if st == 200:
                self._open_audit(day, ev["store"], ev["week"])
                counts["events"].append(f"concern {ev['store']}")
        elif ev["action"] == "hire_seat":
            st, text = self.c[ev["actor"]].call("hire_seat", ev["seat"], check=False)
            self.log(f"  {ev['actor']} hired the {ev['seat']} seat" + ("" if st == 200 else f" FAILED {text[:160]}"))
            counts["events"].append(f"hired {ev['seat']}")
        elif ev["action"] == "close_audit":
            pass  # planned audits close through _close_due_audits once someone has opened them

    # ---------- prose ----------

    def _reason(self, who: str, a: dict, answer: str, context: str) -> str:
        template = f"{answer}: {context}".capitalize()[:240]
        if self.fast:
            return template
        prompt = f"The question: {a['question'][:600]}\nYour answer: {answer}\nWhat you know: {context}"
        return self.texts.get(f"reason:{who}:{a['kind']}:{a['subject']}:{answer}", REASON_SYSTEM.format(voice=STAFF[who]["voice"]), prompt,
                              fallback=template, check=lambda t: isinstance(t, str) and 8 < len(t) < 320 and "\n" not in t, max_tokens=80, temperature=0.7)

    def _concern_note(self, ev) -> str:
        f = ev["facts"]
        template = (f"Supplies at #{ev['store'][1:]} imply about {money(f['supply_implied_gross'])} of drinks but they reported {money(f['reported_gross'])}, "
                    f"and cash fell to {f['cash_share']:.0%} of sales from about {f['usual_cash_share']:.0%} while other stores held near {f['peer_cash_share']:.0%}.")
        if self.fast:
            return template
        prompt = (f"You are writing a short note to the controller about {store(ev['store'])['name']} (owner Maya Chen), week of {ev['week']}. "
                  f"Facts: the supplies they bought imply about {money(f['supply_implied_gross'])} of drink sales, but they reported {money(f['reported_gross'])}; "
                  f"their cash share fell to {f['cash_share']:.0%} from their usual {f['usual_cash_share']:.0%}, while other stores held near {f['peer_cash_share']:.0%}. "
                  "Say you want an audit. Two sentences, your own words, include the dollar amounts and percentages.")
        return self.texts.get("concern:S14:2026-03-02", REASON_SYSTEM.replace("ONE plain sentence (at most 30 words)", "two plain sentences").format(voice=STAFF["Lee"]["voice"]),
                              prompt, fallback=template, check=lambda t: isinstance(t, str) and "%" in t and "$" in t and len(t) < 500, max_tokens=140)

    def _audit_note(self, who, code, week, sw) -> str:
        reported = max(sw["reported_grosses"])
        template = f"Audited week of {week} from POS Z-reports and bank deposits: actual sales {money(sw['true_gross'])} against {money(reported)} reported."
        if self.fast:
            return template
        prompt = (f"You audited {store(code)['name']} for the week of {week}: the POS Z-reports and bank deposits show actual sales of {money(sw['true_gross'])}; "
                  f"the owner reported {money(reported)}. Write the audit finding.")
        return self.texts.get(f"auditnote:{code}:{week}", REASON_SYSTEM.format(voice=STAFF[who]["voice"]), prompt, fallback=template,
                              check=lambda t: isinstance(t, str) and money(sw["true_gross"]) in t and len(t) < 320, max_tokens=90)

    def _skip(self, a: dict, why: str) -> None:
        key = f"{a['id']}"
        if key not in self.s["skipped"]:
            self.s["skipped"].append(key)
            self.log(f"  (left #{a['id']} {a['kind']} {a['subject']} open: {why})")
