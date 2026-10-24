"""Shared helpers for company A's world: calendar, money, stable hashing, files.

Everything random in the world is drawn from generators seeded by stable hashes
of names (store code, week, purpose), so the same seed always builds the same
six months, and changing one scenario does not reshuffle the others.
"""
from __future__ import annotations

import hashlib
import json
import random
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "data" / "companyA"

START = date(2026, 1, 5)  # Monday, first business date
END = date(2026, 6, 28)  # Sunday, last business date
N_WEEKS = ((END - START).days + 1) // 7  # 25 sales weeks: Jan 5 ... Jun 22
WEEKS = [(START + timedelta(weeks=i)).isoformat() for i in range(N_WEEKS)]

# Banks are closed on these days: no ACH settlements, wires or check deposits.
BANK_HOLIDAYS = {
    "2026-01-19": "Martin Luther King Jr. Day",
    "2026-02-16": "Presidents' Day",
    "2026-05-25": "Memorial Day",
    "2026-06-19": "Juneteenth",
}


def D(s: str) -> date:
    return date.fromisoformat(s)


def add_days(s: str, n: int) -> str:
    return (D(s) + timedelta(days=n)).isoformat()


def days_between(a: str, b: str) -> int:
    return (D(b) - D(a)).days


def weekday(s: str) -> int:
    """Monday is 0, Sunday is 6."""
    return D(s).weekday()


def day_name(s: str) -> str:
    return D(s).strftime("%a")


def is_business_day(s: str) -> bool:
    return weekday(s) < 5 and s not in BANK_HOLIDAYS


def next_business_day(s: str, n: int = 1) -> str:
    """The n-th business day after s."""
    d = s
    while n > 0:
        d = add_days(d, 1)
        if is_business_day(d):
            n -= 1
    return d


def business_day_on_or_after(s: str) -> str:
    return s if is_business_day(s) else next_business_day(s)


def all_days(start: str = START.isoformat(), end: str = END.isoformat()) -> list[str]:
    return [add_days(start, i) for i in range(days_between(start, end) + 1)]


def week_of(s: str) -> str:
    """The Monday that starts the sales week containing s."""
    return add_days(s, -weekday(s))


def stable_int(*parts: object) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:16], 16)


SEED = 20260105  # gen.py --seed overrides it before anything is drawn


def set_seed(seed: int) -> None:
    global SEED
    SEED = seed


def rng_for(*parts: object) -> random.Random:
    """A generator for one purpose (a store's sales, a week's supply order...), fixed by the world seed."""
    return random.Random(stable_int(SEED, *parts))


def split_for(case_id: str) -> str:
    """Default split: hash of the case id -> train 50 / val 25 / test 25."""
    h = stable_int("split", case_id) % 100
    return "train" if h < 50 else "val" if h < 75 else "test"


SLIP_EVERY = {"underreport": 14, "pre_chase": 14, "allocation": 25}


def spot_check_slip(domain: str, subject: str) -> bool:
    """Pre-registered human error: on one subject in SLIP_EVERY[domain], a person answering a spot check gets it wrong."""
    return domain in SLIP_EVERY and stable_int("slip", subject) % SLIP_EVERY[domain] == 0


def bp_of(amount: int, bp: int) -> int:
    """Basis-point share with banker's rounding, exactly as core/money.ts bpOf."""
    num = amount * bp
    floor, rem = divmod(num, 10_000)
    if rem > 5_000:
        return floor + 1
    if rem < 5_000:
        return floor
    return floor if floor % 2 == 0 else floor + 1


def dollars(cents: int) -> str:
    """8400.00 (CSV style, no thousands separator)."""
    return f"{cents // 100}.{cents % 100:02d}" if cents >= 0 else "-" + dollars(-cents)


def money(cents: int) -> str:
    """$8,400.00 (prose style)."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100:,}.{cents % 100:02d}"


def short_date(s: str) -> str:
    """1/5 style, as people write it."""
    d = D(s)
    return f"{d.month}/{d.day}"


def long_date(s: str) -> str:
    """Monday, January 5, 2026."""
    d = D(s)
    return d.strftime("%A, %B ") + str(d.day) + d.strftime(", %Y")


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    with open(path) as f:
        return json.load(f)


def write_json(path: Path, obj, indent: int | None = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=indent, ensure_ascii=False)
        f.write("\n")
    tmp.replace(path)
