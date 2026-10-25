"""The people at Pearl Lane: Dana and Sam (controllers), Lee and Priya (field consultants).

After the seats run each day they read the questions addressed to them, the open
asks (besides the bank's debit list, the only thing the world reads from the
database; a person also opens the email or the decision a question is about),
and answer within the ask's deadline from what they know to be true. They also
do what only people do: Lee raises the March concern about #14, the consultants
perform the audits people requested, Dana endorses bank changes a callback
confirmed, hires the refunds seat, and corrects a few decisions she can see were
wrong once an owner complains. A few answers are wrong on purpose; the answer
key registered them before the run.

Every answer carries one sentence of reason in the person's voice (qwen3.8-flash,
cached in texts.json; --fast uses templates). Routine "the seat was right"
spot checks draw on a small cached phrase bank per person instead of a call each.
"""
from __future__ import annotations

import json
import re

from cast import ENTITIES, STAFF, entity, store, stores_of, terms_for_store
from common import add_days, bp_of, business_day_on_or_after, is_business_day, money, next_business_day, spot_check_slip, stable_int
from scenarios import audit_payment_txn
from texts import Texts

ENTITY_BY_NAME = {e[1]: e[0] for e in ENTITIES}
# The wrong answer a person gives when they slip on a spot check. It is always one the team would accept,
# never one that breaks a domain safety rule (chasing inside the grace period, applying cash the payer did not place).
WRONG_TURN = {"accept": "flag_audit", "flag_audit": "accept", "ask_consultant": "accept", "chase": "hold",
              "apply_unique": "leave_unapplied_ask", "apply_by_terms": "leave_unapplied_ask", "leave_unapplied_ask": "apply_by_terms"}


def wrong_turn(decided: str, features: dict) -> str | None:
    if decided == "hold":  # 'chase' only where chasing is allowed at all
        return "chase" if float(features.get("days_past_due", 0)) > float(features.get("grace_days", 0)) else "escalate_controller"
    return WRONG_TURN.get(decided)
ESCALATE = {"flag_audit", "ask_consultant"}
REASON_SYSTEM = ("You are {voice}. Your finance team's software asked you a question and you have decided the answer. "
                 "Write ONE plain sentence (at most 30 words) giving your reason, in your own voice. No preamble, no quotes, do not restate the question.")


def consultant_for_entity(code: str) -> str:
    return store(stores_of(code)[0])["consultant"]


def same_treatment(domain: str, a: str, b: str) -> bool:
    return (a in ESCALATE) == (b in ESCALATE) if domain == "underreport" else a == b


class Staff:
    def __init__(self, world: dict, clients: dict, texts: Texts, fast: bool, log, state: dict):
        self.k = world["staff"]
        self.c, self.texts, self.fast, self.log = clients, texts, fast, log
        self.s = state
        for key, default in [("audits", []), ("payments", []), ("routing_ids", {}), ("endorse", []), ("second_approval", []), ("done", []),
                             ("answers", []), ("reactive_receipts", {}), ("skipped", []), ("ap_duplicates_caught", 0), ("ap_second", [])]:
            self.s.setdefault(key, default)
        self.receipts = {**self.k["receipts"], **self.s["reactive_receipts"]}
        self.ap = self.k.get("payables") or {}
        self._slip = False
        self._ap_fix = None
        self.handlers = {"audit": self._audit, "callback": self._callback, "allocation": self._allocation, "identify_payer": self._identify,
                         "unapplied_cash": self._unapplied, "refund_release": self._refund, "collections": self._collections, "dispute": self._dispute,
                         "royalty_decrease": self._royalty_decrease, "reading_conflict": self._reading_conflict, "finding": self._finding,
                         "bill_exception": self._bill_exception, "payment_release": self._payment_release,
                         "unknown_report": lambda d, a: ("Dana", "ignore", "no store matches; asked the sender to resend", None),
                         "label_check": self._label_check, "set_aside": lambda d, a: ("Dana", "noted", "logged for the morning review", None)}

    # ---------- the day ----------

    def step(self, day: str) -> dict:
        counts = {"answered": 0, "audits": 0, "events": []}
        for ev in [e for e in self.k["events"] if e["date"] == day]:
            self._event(day, ev, counts)
        asks = self.c["Dana"].sql("SELECT id, created_at, kind, subject, to_role, question, options, evidence, deadline FROM ask WHERE status = 'open'")
        for a in sorted(asks, key=lambda a: a["id"]):
            if self._answer(day, a):
                counts["answered"] += 1
        counts["open"] = len(asks) - counts["answered"]
        counts["audits"] = self._close_due_audits(day)
        self._call_desk(day)
        self._endorse(day)
        self._second_approvals(day)
        self._second_releases(day)
        self._corrections(day, counts)
        return counts

    def due_payments(self, day: str) -> list[dict]:
        """Owners' payments of audit invoices that fall due today (the runner ingests them with the day's mail)."""
        return [p for p in self.s["payments"] if p["date"] == day]

    # ---------- answering ----------

    def _answer(self, day: str, a: dict) -> bool:
        kind = a["kind"]
        handler = self._spot_check if kind.startswith("spot_check:") else self.handlers.get(kind)
        if handler is None:
            self._skip(a, f"no persona handles '{kind}'")
            return False
        decided = handler(day, a)
        if decided is None:
            self._slip, self._ap_fix = False, None
            return False
        who, answer, context, when = decided
        due = min(when, a["deadline"]) if when else self._default_day(a)
        if day < due:
            self._slip, self._ap_fix = False, None
            return False
        options = json.loads(a["options"] or "[]")
        if kind != "identify_payer" and answer not in options:
            self._skip(a, f"answer '{answer}' not among {options}")
            return False
        reason = self._reason(who, a, answer, context)
        st, text = self.c[who].call("answer_ask", a["id"], answer, reason, check=False)
        self.s["answers"].append({"day": day, "ask": a["id"], "kind": kind, "subject": a["subject"], "answer": answer, "by": who, "ok": st == 200,
                                  "human_error": self._is_error(a, answer) or self._slip})
        self._slip = False
        if st != 200:
            self.log(f"  ! {who} answer_ask #{a['id']} {kind} -> {text[:160]}")
            self._ap_fix = None
            return False
        self.log(f"  {who} answered #{a['id']} {kind} {a['subject']}: {answer} ({reason})")
        self._after_answer(day, a, answer)
        return True

    def _default_day(self, a: dict) -> str:
        """0-2 business days after the question, never past its deadline."""
        d = add_days(a["created_at"], stable_int("lag", a["kind"], a["subject"]) % 3)
        while d > a["created_at"] and not is_business_day(d):
            d = add_days(d, -1)
        if not is_business_day(d):
            d = business_day_on_or_after(a["created_at"])
        return min(d, a["deadline"])

    def _is_error(self, a: dict, answer: str) -> bool:
        he = self.k["human_errors"]
        planted = he.get(a["subject"]) or he.get(f"collections:{a['subject'].split(':', 1)[-1]}:{a['created_at']}")
        return planted is not None and (planted == answer or (planted == "request audit" and answer in ESCALATE))

    # ---------- one handler per kind of question: (who, answer, what they know, planned day or None) ----------

    def _audit(self, day, a):
        _, code, week = a["subject"].split(":")
        sw = self.k["store_weeks"].get(f"{code}:{week}", {})
        who = store(code)["consultant"]
        if sw.get("human_error"):
            return who, "request audit", "the cash share looked low to you and you did not check the store's history first", None
        answer = "request audit" if sw.get("underreported") else "explained — accept report"
        return who, answer, self._audit_context(a, sw), None

    def _audit_context(self, a, sw) -> str:
        f = json.loads(a["evidence"] or "{}").get("features", {})
        code = a["subject"].split(":")[1]
        bits = []
        if f:
            bits.append(f"reported {money(int(f.get('reported_gross', 0)))}, supplies imply {money(int(f.get('supply_implied_gross', 0)))}, "
                        f"cash share {float(f.get('cash_share', 0)):.0%} vs its usual {float(f.get('own_cash_share_history', 0)):.0%}")
        if sw.get("underreported"):
            bits.append("you believe cash sales were kept off the report" if sw.get("planted") == "underreported_cash" else "card sales are below what the processor settled")
        elif code in ("S23", "S36"):
            bits.append("an office-district store that has always taken almost no cash")
        else:
            bits.append("you know this store's numbers are honest (a bulk buy, a promo or ordinary noise explains the gap)")
        return "; ".join(bits)

    def _callback(self, day, a):
        if a["to_role"] == "controller":
            return self._vendor_callback(day, a)
        m = re.match(r"(.+?) asked by email to move money to account (\*{4}\S+?)\.", a["question"])
        name, account = (m.group(1), m.group(2)) if m else ("", "")
        ent = ENTITY_BY_NAME.get(name, "")
        case = next((r for r in self.k["callbacks"] if r["entity"] == ent and r["account"] == account), None)
        self.s["routing_ids"][case["case"] if case else f"{ent}:{account}"] = int(a["subject"].split(":")[1])
        who = consultant_for_entity(ent) if ent else "Lee"
        if not case:  # nobody planned this change: the owner, reached on the number on file, did not ask for it
            owner = entity(ent)["owner"] if ent else "the owner"
            return who, "denied", f"you called {owner} on the number on file and they never asked for a bank change", None
        when, actor, outcome = case["callbacks"][0]
        e = entity(ent)
        context = {"confirmed": f"you called {e['owner']} at {e['phone']} (on file) and they confirmed the new account",
                   "denied": f"you called {e['owner']} at {e['phone']} (on file, not any number in the email) and they said they never sent it",
                   "no_answer": f"you called {e['phone']} (on file) and got voicemail; you will try again"}[outcome]
        return actor, outcome, context, when

    def _vendor_callback(self, day, a):
        """A vendor's bank change: the controller opens the request and its email, and calls the number on file."""
        rid = int(a["subject"].split(":")[1])
        rows = self.c["Dana"].sql(f"SELECT entity_code, source_obs FROM routing_request WHERE id = {rid}")
        ref = self.c["Dana"].sql(f"SELECT ref_key FROM observation WHERE id = {rows[0]['source_obs']}")[0]["ref_key"] if rows else ""
        truth = self.ap.get("emails", {}).get(ref)
        self.s["routing_ids"][ref or f"routing:{rid}"] = rid
        name = a["question"].split(" asked by email", 1)[0]
        if truth and not truth["fraud"]:
            return "Dana", "confirmed", f"you called {name} on the number on file and their accounts office confirmed the new account", None
        return "Dana", "denied", f"you called {name} on the number on file (not the one in the email) and they never asked to change banks", None

    def _bill_exception(self, day, a):
        """A held vendor bill: approve the standing service bill and the one agreed price increase; reject short shipments, other variances, duplicates."""
        known = self.ap.get("bills", {}).get(a["subject"], {})
        bill = a["subject"].split(":", 1)[1]
        fam = known.get("family", "")
        if bill in self.ap.get("approve_exceptions", []) or fam in ("bill_clean", "bill_no_po_service"):
            why = {"bill_no_po_service": "CleanPro's monthly service has no PO by design; the amount is the contract rate",
                   "bill_price_variance": "purchasing agreed this price increase with Golden Tapioca"}.get(fam, "it matches what we ordered and received")
            return "Dana", "approve", why, None
        why = {"bill_short_shipment": "billed at the full PO but the receiving log shows a short shipment", "bill_duplicate": "the same invoice was already billed",
               "bill_price_variance": "the unit price is above the PO and nobody agreed to it"}.get(fam, "it does not match what we ordered and received")
        return "Dana", "reject", why, None

    def _payment_release(self, day, a):
        """Dana releases a Friday run unless it pays a duplicate she spots (the first two) or the vendor's bank change is pending."""
        if day < self._default_day(a):
            return None  # decide on the day she answers, so the duplicates she catches are counted once
        ev = json.loads(a["evidence"] or "{}")
        bills = [b["id"] for b in ev.get("bills", [])]
        dups = [b for b in bills if b in self.ap.get("duplicates", {})]
        if dups and self.s["ap_duplicates_caught"] < 2:
            self.s["ap_duplicates_caught"] += 1
            self._ap_fix = (dups[0], self.ap["duplicates"][dups[0]])
            return "Dana", "cancel", f"this run pays {dups[0]}, the same invoice as {self.ap['duplicates'][dups[0]]} typed differently", None
        if "waiting for a callback" in a["question"]:
            return "Dana", "cancel", "the vendor's bank change is not verified yet; pay in the next run after the callback", None
        amount = sum(int(b.get("amount", 0)) for b in ev.get("bills", []))
        if amount > 2_500_000:
            self.s["ap_second"].append({"payment": a["subject"].split(":", 1)[1], "date": day})
        return "Dana", "release", "routine:payment_release:release", None

    def _same_day(self, a) -> str:
        """Cash application is cleared daily: the controller answers on the business day the question is raised."""
        return min(business_day_on_or_after(a["created_at"]), a["deadline"])

    def _allocation(self, day, a):
        txn = a["subject"].split(":", 1)[1]
        rc = self.receipts.get(txn)
        options = json.loads(a["options"] or "[]")
        today = self._same_day(a)
        if not rc:
            return "Dana", "apply oldest first", "you could not tell what this payment was for", today
        wrong = self.k["human_errors"].get(a["subject"])
        if wrong:
            return "Dana", wrong, "a busy close week; you took the contract-order option without opening the remittance", today
        # Where the money belongs: the one invoice the payer named, the set their remittance listed, or (only if that is the truth) contract order.
        want = sorted(rc["intended"] or [])
        if rc["family"] == "duplicate_payment":  # it should stay unapplied until it is refunded
            if "leave unapplied" in options:
                return "Dana", "leave unapplied", "this wire repeats an invoice the debit already collected; it waits for the refund", today
            self._skip(a, "duplicate payment: left unapplied for the refund")
            return None
        if len(want) == 1 and want[0] in options:
            why = "the payment names that invoice; it is short only by the amount the owner disputes" if rc["family"] == "short_payment" else "the payment names that invoice"
            return "Dana", want[0], why, today
        match = next((o for o in options if o != "apply oldest first" and sorted(o.split(" + ")) == want), None)
        if match:
            return "Dana", match, f"the payer's remittance lists exactly {' + '.join(want)}", today
        return "Dana", "apply oldest first", "nothing the payer said points at particular invoices, so the agreement's order applies", today

    def _identify(self, day, a):
        rc = self.receipts.get(a["subject"].split(":", 1)[1])
        if not rc:
            self._skip(a, "a payer the world did not plan")
            return None
        e = entity(rc["entity"])
        return "Dana", rc["entity"], f"\"{rc.get('payer')}\" is {e['owner']}, who owns {e['name']}; you recognized the name", rc.get("identify_on")

    def _unapplied(self, day, a):
        rc = self.receipts.get(a["subject"].split(":", 1)[1], {})
        if rc.get("family") == "duplicate_payment":
            return "Dana", "refund", "the wire repeats an invoice that the Wednesday debit already collected; the owner should get it back", self._same_day(a)
        return "Dana", "keep as credit", "money with nothing to pay yet; keep it on account for the next invoice", self._same_day(a)

    def _refund(self, day, a):
        if day < self._default_day(a):
            return None
        m = re.search(r"refund of \$([\d,]+\.\d{2}) to (.+?) at the account on file", a["question"])
        amount = int(round(float(m.group(1).replace(",", "")) * 100)) if m else 0
        ent = ENTITY_BY_NAME.get(m.group(2), "") if m else ""
        if any(r["entity"] == ent and amount <= r["amount"] for r in self.k["refunds"]):
            if amount > 500_000:
                self.s["second_approval"].append({"refund": int(a["subject"].split(":")[1]), "date": day})
            return "Sam", "release", f"the duplicate payment of {money(amount)} is on the bank statement; it goes back to the account on file", None
        return "Sam", "cancel", "there is no duplicate or overpayment on this account that you can verify", None

    def _collections(self, day, a):
        ent = a["subject"].split(":", 1)[1]
        who = "Dana" if a["to_role"] == "controller" else consultant_for_entity(ent)
        wrong = self.k["human_errors"].get(f"collections:{ent}:{a['created_at']}")
        if wrong:
            return who, wrong, "you had not seen the owner's email when you answered", None
        w = next((w for w in self.k["collections"] if w["entity"] == ent and w["from"] <= a["created_at"] <= w["to"]), None)
        if w:
            why = {"PIT1": "Anita mailed check #4410 for the fees", "PIT2": "Carmen mailed check #2207 for the NSF fee", "PIT3": "Ben mailed a check for the NSF fee",
                   "RC2": "the debit bounced because we used the account Emily told us was closed",
                   "LFD1": "Anita is disputing the late fees and the re-presented debit is already in flight"}.get(w["case"], "a payment is on its way")
            return who, w["answer"], why, None
        if any(d["entity"] == ent and d["date"] <= day and d["case"] not in self.s["done"] for d in self.k["disputes"]):
            return who, "hold 7 days", "the owner has an open dispute on part of the balance", None
        return who, "chase", "no payment promised and the balance is past the grace period", None

    def _dispute(self, day, a):
        ent = a["subject"].split(":", 1)[1]
        d = next((d for d in self.k["disputes"] if d["entity"] == ent and d["date"] <= day and d["case"] not in self.s["done"]), None)
        if not d:
            return "Dana", "uphold", "the charges follow the franchise agreement", None
        why = {"LFD1": "FA-2025 section 7.2 charges late fees on anything unpaid five days past due, and the debit bounced for insufficient funds",
               "LFD2": "we debited the account Emily told us on April 7 was closed; those fees are our mistake",
               "SP1": "the photos show torn pearl bags; credit the deduction", "SP2": "the fuel surcharge is in FA-2022 schedule B, which they signed",
               "SP3": "the delivery receipt for that order is signed for every case"}.get(d["case"], "")
        return "Dana", d["answer"], why, d["answer_on"]

    def _royalty_decrease(self, day, a):
        plan = self.k["royalty_decreases"].get(a["subject"])
        if plan:
            return "Dana", plan["answer"], "the revised card total matches the processor's settlement; the first report counted Saturday's batch twice", plan["on"]
        return "Dana", "keep original", "the revision is not supported by the processor's settlement", None

    def _reading_conflict(self, day, a):
        """Two models read an email differently; the controller opens the email and says which reading is right."""
        ev = json.loads(a["evidence"] or "{}")
        rows = self.c["Dana"].sql(f"SELECT ref_key FROM observation WHERE id = {int(ev.get('observation', 0))}")
        ref = rows[0]["ref_key"] if rows else ""
        truth = self.k["mail"].get(ref) or (self.ap.get("emails", {}).get(ref) or {}).get("reading")
        if not truth:
            return "Dana", "ignore the email", "you could not match the email to anything you expected", None
        if not ev.get("readingA") and not ev.get("readingB"):
            return "Dana", "read it again", "neither model answered; send it back to the readers", None
        sa, sb = mismatches(ev.get("readingA") or {}, truth), mismatches(ev.get("readingB") or {}, truth)
        if min(len(sa), len(sb)) and truth.get("type") == "other":
            return "Dana", "ignore the email", "the email asks for nothing that touches the ledger", None
        pick, wrong = ("reading A", sb) if len(sa) <= len(sb) else ("reading B", sa)
        return "Dana", pick, f"you read the email yourself; the other reading got {', '.join(wrong) or 'a detail'} wrong", None

    def _finding(self, day, a):
        return "Dana", "acknowledge", f"internal audit is right to flag it: {a['question'][:120]}", None

    def _spot_check(self, day, a):
        """kind 'spot_check:<domain>': was an autonomous decision right? Options are 'correct' plus the domain's other outcomes."""
        if day < self._default_day(a):
            return None
        domain = a["kind"].split(":", 1)[1]
        options = json.loads(a["options"] or "[]")
        ev = json.loads(a["evidence"] or "{}")
        decided = ev.get("decided")
        who = store(a["subject"].split(":")[1])["consultant"] if domain == "underreport" else "Dana"
        if domain == "underreport":
            sw = self.k["store_weeks"].get(":".join(a["subject"].split(":")[1:]), {})
            if sw.get("human_error") and decided == "accept" and "flag_audit" in options:
                return who, "flag_audit", "the cash share looked low to you and you did not check the store's history first", None
        cash = self._cash_truth(a["subject"], ev) if domain == "allocation" else None
        if cash:  # cash is right when the money went where the payer meant, whatever the outcome is called
            expected, right = cash[1], ev["treatments"].get(decided) == cash[0]
        else:
            expected = self.expected_outcome(domain, a["subject"], ev.get("features", {}))
            right = expected is None or decided is None or same_treatment(domain, decided, expected)
        if spot_check_slip(domain, a["subject"]):  # the pre-registered slip
            wrong = "correct" if not right else wrong_turn(decided, ev.get("features", {}))
            if wrong in options:
                self._slip = True
                return who, wrong, ("it looked fine at a glance" if wrong == "correct" else f"you misread the case and thought '{wrong}'"), None
        if right:
            return who, "correct", f"routine:{domain}:{decided}", None
        if expected in options:
            return who, expected, f"the seat decided '{decided}' but it should have been '{expected}'", None
        alt = next((o for o in options if o in ESCALATE), None) if domain == "underreport" else None
        return (who, alt, f"this week should have gone to audit, not '{decided}'", None) if alt else (who, "correct", f"routine:{domain}:{decided}", None)

    def _label_check(self, day, a):
        """kind 'label_check': the team asks the person to look again at a verdict against a rule with a clean record.
        A misread is admitted on a second look; a belief the person holds (a planted human error) or a true catch stands."""
        ev = json.loads(a["evidence"] or "{}")
        domain, decided = ev.get("domain"), ev.get("decided")
        options = json.loads(a["options"] or "[]")
        who = store(a["subject"].split(":")[1])["consultant"] if domain == "underreport" else "Dana"
        if spot_check_slip(domain, a["subject"]):
            return who, options[0], "you look again: you had misread the case and the seat was right", None
        cash = self._cash_truth(a["subject"], ev) if domain == "allocation" else None
        expected = self.expected_outcome(domain, a["subject"], ev.get("features", {}))
        right = ev["treatments"].get(decided) == cash[0] if cash else expected is not None and same_treatment(domain, decided, expected)
        if right and not self.k["store_weeks"].get(":".join(a["subject"].split(":")[1:]), {}).get("human_error"):
            return who, options[0], "you look again: the seat was right", None
        return who, options[1], "you look again and stand by it", None

    def _cash_truth(self, subject: str, ev: dict):
        """Where a receipt's money belongs, in the seat's spelling of what each outcome would do ('ask' when no
        outcome would put it there), and an outcome that does that. None when the seat recorded no treatments."""
        rc = self.receipts.get(subject.split(":", 1)[1])
        t = ev.get("treatments") or {}
        if not rc or not t:
            return None
        want = "ask" if rc.get("family") == "duplicate_payment" else " + ".join(sorted(rc.get("intended") or [])) or "ask"
        if want not in t.values():
            want = "ask"
        return want, "leave_unapplied_ask" if want == "ask" else next(o for o in t if t[o] == want)

    def expected_outcome(self, domain: str, subject: str, features: dict) -> str | None:
        """What the staff know to be right for a seat decision."""
        if domain == "underreport":
            sw = self.k["store_weeks"].get(":".join(subject.split(":")[1:]))
            return None if sw is None else "flag_audit" if sw["underreported"] else "accept"
        if domain == "allocation":
            return (self.receipts.get(subject.split(":", 1)[1]) or {}).get("expected")
        if domain == "bill_match":
            return (self.ap.get("bills", {}).get(subject) or {}).get("expected")
        if domain == "routing_change":
            _, ent, refkey = subject.split(":", 2)
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
        kind = a["kind"]
        if (kind == "audit" and answer == "request audit") or (kind == "spot_check:underreport" and answer in ESCALATE):
            _, code, week = a["subject"].split(":")
            self._open_audit(day, code, week)
        elif kind == "callback" and answer == "confirmed":
            self.s["endorse"].append({"id": int(a["subject"].split(":")[1]), "date": day})
        elif kind == "payment_release" and getattr(self, "_ap_fix", None):
            dup, original = self._ap_fix
            self._ap_fix = None
            rows = [r for r in self.c["Dana"].sql(f"SELECT id, outcome, shadow FROM decision WHERE subject = 'bill:{dup}'") if not r["shadow"]]
            if rows:
                last = max(rows, key=lambda r: r["id"])
                st, text = self.c["Dana"].call("correct_decision", last["id"], "reject", f"duplicate of {original}: same amount, same invoice number typed differently", check=False)
                self.log(f"  Dana corrected bill_match on {dup}: {last['outcome']} -> reject" + ("" if st == 200 else f" FAILED {text[:120]}"))
        elif kind == "dispute":
            d = next((d for d in self.k["disputes"] if d["entity"] == a["subject"].split(":", 1)[1] and d["case"] not in self.s["done"]), None)
            if d:
                self.s["done"].append(d["case"])

    def _open_audit(self, day, code, week):
        if any(x["store"] == code and x["week"] == week for x in self.s["audits"]):
            return
        planned = next((p for p in self.k["planned_audits"] if p["store"] == code and p["week"] == week), None)
        close_on = max(planned["close_on"], day) if planned else business_day_on_or_after(add_days(day, 5 + stable_int("audit", code, week) % 6))
        self.s["audits"].append({"store": code, "week": week, "opened": day, "close_on": close_on, "closed": False})

    def _close_due_audits(self, day) -> int:
        n = 0
        for au in self.s["audits"]:
            if au["closed"] or au["close_on"] > day:
                continue
            au["closed"] = True
            code, week = au["store"], au["week"]
            sw = self.k["store_weeks"].get(f"{code}:{week}")
            if not sw:
                continue
            who = store(code)["consultant"]
            st, text = self.c[who].call("close_audit", code, week, sw["true_gross"], self._audit_note(who, code, week, sw), check=False)
            if st != 200:
                self.log(f"  ! close_audit {code} {week} -> {text[:160]}")
                continue
            n += 1
            self.log(f"  {who} closed the audit of {code} week {week}: true sales {money(sw['true_gross'])}")
            self._owner_pays_audit(day, code, week, sw)
        return n

    def _owner_pays_audit(self, day, code, week, sw):
        """The owner pays the audit invoice a few business days later: the world's reaction to the staff's audit."""
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
        reference = f"AUDIT {code} WK {week}" if react.get("payer") else f"A-{code}-{week}"
        self.s["payments"].append({"date": pay_on, "payload": {"txnId": txn, "date": pay_on, "type": react["method"], "amountCents": owed, "counterpartyName": payer,
                                                              "counterpartyAccount": react.get("account") or e["bank"], "reference": reference}})
        known = {"entity": ent, "family": "audit_payment", "intended": [f"A-{code}-{week}"], "ask_answer": None, "identify_on": pay_on, "payer": payer,
                 "amount": owed, "expected": "apply_unique"}
        self.receipts.setdefault(txn, known)
        if txn not in self.k["receipts"]:
            self.s["reactive_receipts"][txn] = known

    def _call_desk(self, day):
        """Follow-up calls the call desk logs (a trusted source) when the first call went to voicemail."""
        for r in self.k["callbacks"]:
            for when, _who, outcome in r["callbacks"][1:]:
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
            if st == 200:
                self.s["endorse"].remove(item)
                self.log(f"  Dana endorsed bank change #{item['id']}")
            elif item["date"] < add_days(day, -3):
                self.s["endorse"].remove(item)
                self.log(f"  ! endorse_routing #{item['id']} -> {text[:160]}")

    def _second_approvals(self, day):
        for item in list(self.s["second_approval"]):
            st, text = self.c["Dana"].call("release_refund", item["refund"], check=False)
            self.s["second_approval"].remove(item)
            self.log(f"  Dana gave the second approval on refund #{item['refund']}: {'ok' if st == 200 else text[:120]}")

    def _second_releases(self, day):
        """Vendor payments over $25,000 need a second person: Sam releases after Dana."""
        for item in list(self.s["ap_second"]):
            st, text = self.c["Sam"].call("release_payment", item["payment"], check=False)
            self.s["ap_second"].remove(item)
            self.log(f"  Sam gave the second release on {item['payment']}: {'ok' if st == 200 else text[:120]}")

    def _corrections(self, day, counts):
        """A person marks a decision wrong after an owner complains: a third of the mistakes they see, not all of them."""
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
                counts["events"].append(f"corrected {c['domain']}")

    # ---------- planned events ----------

    def _event(self, day, ev, counts):
        tag = f"event:{ev['action']}:{ev.get('store', ev.get('seat', ''))}:{ev.get('week', '')}"
        if tag in self.s["done"] or ev["action"] == "close_audit":  # planned audits close through _close_due_audits once opened
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

    # ---------- prose ----------

    def _reason(self, who: str, a: dict, answer: str, context: str) -> str:
        if context.startswith("routine:"):
            return self._routine(who, context.split(":", 1)[1], a)
        template = f"{answer}: {context}"[:240]
        if self.fast:
            return template
        prompt = f"The question: {a['question'][:600]}\nYour answer: {answer}\nWhat you know: {context}"
        return self.texts.get(f"reason:{who}:{a['kind']}:{a['subject']}:{answer}", REASON_SYSTEM.format(voice=STAFF[who]["voice"]), prompt,
                              fallback=template, check=lambda t: isinstance(t, str) and 8 < len(t) < 320 and "\n" not in t, max_tokens=80, temperature=0.7)

    def _routine(self, who: str, what: str, a: dict) -> str:
        """A routine answer (the seat was right; a clean Friday payment run) from a small cached bank of lines per person."""
        domain, decided = what.split(":", 1)
        fallback = {"lines": [f"Checked it: '{decided}' was the right call.", f"Looked at the source data; '{decided}' holds up."]}
        situation = ("you release this Friday's payment run to a vendor after checking that every bill in it was matched to its purchase order and receipt"
                     if domain == "payment_release" else
                     f"a spot check asks whether the team's software was right to decide '{decided}' on a {domain.replace('_', ' ')} case, and you checked and it was right")
        if not self.fast:
            prompt = (f"Write 6 different one-sentence replies (at most 20 words each) you would type when {situation}. Vary the wording; mention "
                      'what you looked at. Return JSON {"lines": [...]}.')
            bank = self.texts.get(f"phrases:{who}:{domain}:{decided}", REASON_SYSTEM.format(voice=STAFF[who]["voice"]).replace("ONE plain sentence (at most 30 words)", "short lines"),
                                  prompt, fallback=fallback, json_mode=True, max_tokens=300,
                                  check=lambda x: isinstance(x, dict) and isinstance(x.get("lines"), list) and len(x["lines"]) >= 3 and all(isinstance(t, str) for t in x["lines"]))
        else:
            bank = fallback
        return bank["lines"][stable_int(a["subject"]) % len(bank["lines"])]

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
        system = REASON_SYSTEM.replace("ONE plain sentence (at most 30 words)", "two plain sentences").format(voice=STAFF["Lee"]["voice"])
        return self.texts.get("concern:S14:2026-03-02", system, prompt, fallback=template, max_tokens=140,
                              check=lambda t: isinstance(t, str) and "%" in t and "$" in t and len(t) < 500)

    def _audit_note(self, who, code, week, sw) -> str:
        reported = max(sw["reported_grosses"])
        template = f"Audited the week of {week} from POS Z-reports and bank deposits: actual sales {money(sw['true_gross'])} against {money(reported)} reported."
        if self.fast:
            return template
        prompt = (f"You audited {store(code)['name']} for the week of {week}: the POS Z-reports and bank deposits show actual sales of {money(sw['true_gross'])}; "
                  f"the owner reported {money(reported)}. Write the audit finding, including both amounts exactly as written.")
        return self.texts.get(f"auditnote:{code}:{week}", REASON_SYSTEM.format(voice=STAFF[who]["voice"]), prompt, fallback=template, max_tokens=90,
                              check=lambda t: isinstance(t, str) and money(sw["true_gross"]) in t and len(t) < 320)

    def _skip(self, a: dict, why: str) -> None:
        if str(a["id"]) not in self.s["skipped"]:
            self.s["skipped"].append(str(a["id"]))
            self.log(f"  (left #{a['id']} {a['kind']} {a['subject']} open: {why})")


def mismatches(reading: dict, truth: dict) -> list[str]:
    """Fields where a machine reading of an email differs from what the email says."""
    def num(v):
        try:
            return float(re.sub(r"[^0-9.\-]", "", str(v)) or "nan")
        except ValueError:
            return float("nan")

    out = []
    if reading.get("type") != truth.get("type"):
        out.append("the kind of email")
    for f in ("card_sales", "cash_sales", "gross_sales", "amount"):
        if truth.get(f):
            a, b = num(reading.get(f)), num(truth[f])
            if not abs(a - b) <= max(1.0, abs(b) * 0.005):
                out.append(f.replace("_", " "))
    if truth.get("store_code") and re.sub(r"\D", "", str(reading.get("store_code", ""))).lstrip("0") != truth["store_code"][1:].lstrip("0"):
        out.append("the store")
    if truth.get("week_start") and reading.get("week_start") != truth["week_start"]:
        out.append("the week")
    if truth.get("new_account_last4") and str(reading.get("new_account_last4", "")) != truth["new_account_last4"]:
        out.append("the new account")
    if truth.get("invoice_refs") and sorted(map(str, reading.get("invoice_refs") or [])) != sorted(truth["invoice_refs"]):
        out.append("the invoice numbers")
    return out
