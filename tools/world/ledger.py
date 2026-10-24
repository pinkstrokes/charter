"""A shadow of the module's receivables rules, used only by the generator.

To plant a payment the world must know what will be open that day: which
royalty and supply invoices, which fees after a returned debit, what the
Wednesday debit will pull. This file mirrors the day-0 behaviour of seats.ts,
world.ts, answers.ts and core/matching.ts closely enough to plan cases and to
write the pre_chase answer key. The live database stays the authority; the
run report compares the two.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from common import add_days, days_between

TOLERANCE_CENTS = 2_500  # seats.ts: findSubsets(amount, items, 2_500)
MAX_ITEMS = 24


@dataclass
class Invoice:
    id: str
    entity: str
    kind: str  # royalty | supply | fee | audit
    store: str
    issued: str
    due: str
    amount: int
    open: int
    status: str = "open"  # open | paid | disputed | waived | credited


@dataclass
class Debit:
    id: str
    entity: str
    date: str  # the Wednesday it was initiated
    amount: int
    invoices: list[str]
    applied: dict[str, int] = field(default_factory=dict)
    status: str = "scheduled"  # scheduled | settled | returned


# ---------- matching (port of core/matching.ts) ----------

def _subset_sums(items):
    out = []
    for mask in range(1 << len(items)):
        s = 0
        for i, it in enumerate(items):
            if mask & (1 << i):
                s += it.open
        out.append((s, mask))
    return out


def find_subsets(amount: int, items: list[Invoice], tolerance: int = TOLERANCE_CENTS, max_solutions: int = 3):
    """Subsets whose total is within [amount - tolerance, amount], best first: (solutions, residuals)."""
    pool = sorted(items, key=lambda i: (i.due, i.id))[:MAX_ITEMS]
    half = len(pool) // 2
    left, right = pool[:half], pool[half:]
    right_sums = sorted(_subset_sums(right), key=lambda x: x[0])
    found = []
    for lsum, lmask in _subset_sums(left):
        lo, hi = amount - tolerance - lsum, amount - lsum
        if hi < 0:
            continue
        a, b = 0, len(right_sums)
        while a < b:
            m = (a + b) // 2
            if right_sums[m][0] < lo:
                a = m + 1
            else:
                b = m
        k = a
        while k < len(right_sums) and right_sums[k][0] <= hi:
            total = lsum + right_sums[k][0]
            if total != 0:
                ids = [it.id for i, it in enumerate(left) if lmask & (1 << i)] + [it.id for i, it in enumerate(right) if right_sums[k][1] & (1 << i)]
                found.append((ids, amount - total))
                if len(found) > 50:
                    break
            k += 1
        if len(found) > 50:
            break
    found.sort(key=lambda f: (f[1], len(f[0])))
    top = found[:max_solutions]
    return [f[0] for f in top], [f[1] for f in top]


def apply_by_terms(amount: int, items: list[Invoice], order: list[str]) -> list[tuple[str, int]]:
    rank = {k: i for i, k in enumerate(order)}
    out, left = [], amount
    for it in sorted(items, key=lambda i: (rank.get(i.kind, len(order)), i.due, i.id)):
        if left <= 0:
            break
        take = min(left, it.open)
        if take > 0:
            out.append((it.id, take))
            left -= take
    return out


# ---------- the ledger ----------

class Ledger:
    def __init__(self, terms_for_entity):
        self.terms_for_entity = terms_for_entity
        self.inv: dict[str, Invoice] = {}
        self.debits: dict[str, Debit] = {}
        self.notices: dict[str, list[str]] = defaultdict(list)
        self.hold_until: dict[str, str] = {}

    # invoices
    def add(self, id: str, entity: str, kind: str, store: str, issued: str, due: str, amount: int) -> Invoice:
        if id not in self.inv:
            self.inv[id] = Invoice(id, entity, kind, store, issued, due, amount, amount)
        return self.inv[id]

    def of(self, entity: str) -> list[Invoice]:
        return [i for i in self.inv.values() if i.entity == entity]

    def open_items(self, entity: str) -> list[Invoice]:
        """What cash application may apply a receipt to (seats.ts openItemsFor)."""
        return [i for i in self.of(entity) if i.open > 0 and i.status != "disputed"]

    def apply(self, inv_id: str, cents: int) -> None:
        inv = self.inv[inv_id]
        assert 0 < cents <= inv.open, (inv_id, cents, inv.open)
        inv.open -= cents
        if inv.open == 0:
            inv.status = "paid"

    def apply_set(self, ids: list[str]) -> int:
        total = 0
        for i in ids:
            total += self.inv[i].open
            self.apply(i, self.inv[i].open)
        return total

    # Wednesday debits (seats.ts scheduleDebits)
    def schedule_debits(self, day: str) -> list[Debit]:
        out = []
        for entity in sorted({i.entity for i in self.inv.values()}):
            in_flight = {x for d in self.debits.values() if d.entity == entity and d.status == "scheduled" for x in d.invoices}
            due = [i for i in sorted(self.of(entity), key=lambda i: i.id) if i.open > 0 and i.status == "open" and i.due <= day and i.id not in in_flight and i.kind in ("royalty", "supply")]
            if not due:
                continue
            d = Debit(f"D-{entity}-{day}", entity, day, sum(i.open for i in due), [i.id for i in due])
            self.debits[d.id] = d
            out.append(d)
        return out

    def settle(self, debit_id: str) -> None:
        """world.ts settleDebit: apply to the listed invoices in order."""
        d = self.debits[debit_id]
        left = d.amount
        for inv_id in d.invoices:
            inv = self.inv[inv_id]
            take = min(inv.open, left)
            if take > 0:
                self.apply(inv_id, take)
                d.applied[inv_id] = take
                left -= take
        d.status = "settled"

    def reverse(self, debit_id: str) -> None:
        """world.ts returnDebit: reinstate every application of the settled debit."""
        d = self.debits[debit_id]
        for inv_id, cents in d.applied.items():
            inv = self.inv[inv_id]
            inv.open += cents
            inv.status = "open"
        d.applied = {}
        d.status = "returned"

    # collections (seats.ts collectionsCycle with the day-0 pre_chase skill)
    def pre_chase_features(self, entity: str, day: str, announced: int) -> dict | None:
        mine = self.of(entity)
        past = [i for i in mine if i.open > 0 and i.due < day]
        if not past:
            return None
        terms = self.terms_for_entity(entity)
        return {
            "days_past_due": days_between(min(i.due for i in past), day),
            "grace_days": terms["graceDays"],
            "open_amount": sum(i.open for i in past),
            "announced_payment": announced,
            "open_dispute": any(i.status == "disputed" for i in mine),
            "notices_last_30d": sum(1 for n in self.notices[entity] if days_between(n, day) <= 30),
        }

    @staticmethod
    def day0_pre_chase(f: dict) -> str:
        if f["days_past_due"] <= f["grace_days"]:
            return "hold"
        if f["open_dispute"]:
            return "ask_consultant"
        return "chase"

    def chase(self, entity: str, day: str) -> list[Invoice]:
        """A 'chase' decision: notice (at most weekly) and late fees on invoices past grace."""
        last = max(self.notices[entity], default="1970-01-01")
        if self.notices[entity] and days_between(last, day) < 7:
            return []
        self.notices[entity].append(day)
        terms = self.terms_for_entity(entity)
        fees = []
        for inv in sorted(self.of(entity), key=lambda i: i.id):
            if inv.open == 0 or inv.status != "open" or inv.kind in ("fee", "interest"):
                continue
            if days_between(inv.due, day) <= terms["graceDays"]:
                continue
            fid = f"LF-{inv.id}"
            if fid in self.inv:
                continue
            fees.append(self.add(fid, entity, "fee", inv.store, day, add_days(day, 7), terms["lateFeeCents"]))
        return fees
