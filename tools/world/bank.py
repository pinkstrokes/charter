"""The franchisor's bank. It reads one thing from the database, the debit
instructions the cash-application seat initiated, and answers the way a bank
does: a scheduled Wednesday debit settles the next business day, and comes back
two business days later if the franchisee's account had no money (R01) or no
longer exists (R02).
"""
from __future__ import annotations

from common import business_day_on_or_after, is_business_day, next_business_day


class Bank:
    def __init__(self, world: dict, feeder, log):
        rules = world["bank"]
        self.returns: dict[str, str] = rules["returns"]  # debit id -> return code
        self.closed: dict[str, str] = rules["closed_accounts"]  # account -> closed since
        self.names: dict[str, str] = rules["payer_names"]
        self.feeder, self.log = feeder, log

    def step(self, day: str) -> dict:
        """Settle and return debits due today. Returns counts for the day line."""
        counts = {"settled": 0, "returned": 0}
        if not is_business_day(day):
            return counts
        rows = self.feeder.sql("SELECT id, entity_code, amount_cents, bank_account, status, scheduled_for FROM debit_instruction")
        for d in sorted(rows, key=lambda r: r["id"]):
            if d["status"] == "scheduled" and d["scheduled_for"] <= day:
                self._post(day, d, "ach_debit_settled", f"ACHS-{d['id']}")
                counts["settled"] += 1
            elif d["status"] == "settled":
                code = self.return_code(d)
                settled_on = business_day_on_or_after(d["scheduled_for"])
                if code and next_business_day(settled_on, 2) == day:
                    self._post(day, d, "ach_debit_returned", f"ACHR-{d['id']}", code=code)
                    counts["returned"] += 1
        return counts

    def return_code(self, d: dict) -> str | None:
        if d["id"] in self.returns:
            return self.returns[d["id"]]
        since = self.closed.get(d["bank_account"])
        if since and d["scheduled_for"] >= since:
            return "R02"
        return None

    def _post(self, day: str, d: dict, typ: str, txn: str, code: str | None = None) -> None:
        payload = {"txnId": txn, "date": day, "type": typ, "amountCents": d["amount_cents"], "counterpartyName": self.names.get(d["entity_code"], d["entity_code"]),
                   "counterpartyAccount": d["bank_account"], "reference": d["id"] if not code else f"RETURN {code} {d['id']}", "debitId": d["id"]}
        if code:
            payload.update(returnCode=code, originalTxnId=f"ACHS-{d['id']}")
            self.log(f"bank: {d['id']} returned {code}")
        self.feeder.ingest("bank_txn", "bank", day, f"bank:{txn}", f"account:{d['bank_account']}", payload)
