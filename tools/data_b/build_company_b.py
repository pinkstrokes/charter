#!/usr/bin/env python3
"""Build "company B": a compact accounts-receivable world from UCI Online Retail II.

Source: Chen, D. (2012). Online Retail II [Dataset]. UCI Machine Learning Repository.
https://doi.org/10.24432/C5CG6D, licensed CC BY 4.0. See data/companyB/PROVENANCE.md.

Real (copied from the source file): invoice and credit-note numbers, customers,
countries, line items, quantities, unit prices, timestamps, cancellations and the
special lines (postage, manual, discount, bank charges, fees).
Derived (computed here): customer codes, the customer selection, line types and
special-line buckets, credit-note -> invoice links with confidence and reason
guesses, currency guesses, flags and statistics. Cash is not modelled here.

Usage, from tools/data_b:
    uv run python build_company_b.py           # default window and selection
    uv run python build_company_b.py --help

The output depends only on the source file and the arguments (no clocks, no
randomness, sorted iteration everywhere), so reruns are byte-identical.
"""
from __future__ import annotations

import argparse
import bisect
import csv
import gzip
import hashlib
import json
import io
import math
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from pathlib import Path
from typing import Iterable, NamedTuple

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
DATA_DIR = REPO_ROOT / "data" / "companyB"
DEFAULT_XLSX = DATA_DIR / "raw" / "online_retail_II.xlsx"
DEFAULT_CACHE_DIR = DATA_DIR / "raw" / "cache"

SOURCE_PAGE = "https://archive.ics.uci.edu/dataset/502/online+retail+ii"
SOURCE_URL = "https://archive.ics.uci.edu/static/public/502/online+retail+ii.zip"
SOURCE_DOI = "https://doi.org/10.24432/C5CG6D"
SOURCE_LICENSE = "CC BY 4.0"
EXPECTED_XLSX_SHA256 = "bcbe73b35f5b7babf197fb0cb983a11f5d9ff929078d4aa53d171b1f2df2e980"
SHEETS = ("Year 2009-2010", "Year 2010-2011")
COLUMNS = ["Invoice", "StockCode", "Description", "Quantity", "InvoiceDate", "Price", "Customer ID", "Country"]
CACHE_VERSION = 1
CACHE_HEADER = ["sheet", "row", "invoice", "stock_code", "description", "quantity", "ts", "price", "customer_id", "country"]

DEFAULT_START = date(2010, 12, 1)
DEFAULT_END = date(2011, 5, 31)
DEFAULT_TOP = 120
DEFAULT_MIN_INVOICES = 3

# Non-product stock codes found in the source, keyed by the upper-cased code.
SPECIAL_LINE_TYPES = {
    "POST": "postage",          # "POSTAGE"
    "DOT": "postage",           # "DOTCOM POSTAGE"
    "C2": "postage",            # "CARRIAGE"
    "M": "manual",              # "Manual" (also spelled "m")
    "ADJUST": "adjustment",     # "Adjustment by john on 26/01/2010 ..."
    "ADJUST2": "adjustment",
    "B": "adjustment",          # "Adjust bad debt"
    "D": "discount",            # "Discount"
    "S": "samples",             # "SAMPLES"
    "BANK CHARGES": "bank_charges",
    "AMAZONFEE": "fee",         # "AMAZON FEE"
    "CRUK": "fee",              # "CRUK Commission"
    "TEST001": "test",
    "TEST002": "test",
}
GOODS_LINE_TYPES = frozenset({"product", "gift_voucher"})
SPECIAL_BUCKET = {
    "postage": "postage_pence",
    "manual": "manual_pence",
    "adjustment": "manual_pence",
    "discount": "manual_pence",
    "samples": "manual_pence",
    "test": "manual_pence",
    "bank_charges": "fees_pence",
    "fee": "fees_pence",
}
BUCKETS = ("postage_pence", "manual_pence", "fees_pence")

# Euro area members during the window (Estonia joined 2011-01-01; the source spells Ireland "EIRE").
EUROZONE_2011 = frozenset({
    "Austria", "Belgium", "Cyprus", "EIRE", "Estonia", "Finland", "France", "Germany", "Greece",
    "Italy", "Luxembourg", "Malta", "Netherlands", "Portugal", "Slovakia", "Slovenia", "Spain",
})

# Credit-note linking heuristics (documented in data/companyB/README.md).
RECENCY_SCALE_DAYS = 14.0      # recency prior 1 / (1 + age_days / 14)^2 (fits the observed credit lags)
FULL_REVERSAL_BOOST = 10.0     # credit note reverses every goods line of the candidate (or its whole amount)
NULL_WEIGHT = 0.01             # pseudo-candidate "the original is not in the data"
LATER_MATCH_MIN_SHARE = 0.5    # a re-bill must be mostly the credited goods, not a big unrelated re-order
LATER_MATCH_MIN_COVERAGE = 0.8 # ... and contain most of them (prices may differ: re-bills often re-price)
MAX_EXTRA_INVOICES = 3         # a credit note may reverse items from up to 1 + 3 earlier invoices
MIN_EXTRA_GAIN = 0.05          # an extra invoice must explain >= 5% of the credited value
LATER_MATCH_WINDOW = timedelta(days=2)
DUPLICATE_CREDIT_WINDOW = timedelta(days=31)
DISCOUNT_LOOKBACK_DAYS = 31.0
DISCOUNT_PERCENTS = tuple(Decimal(p) for p in [*range(1, 51), "2.5", "7.5", "12.5", "17.5", "22.5"])
CANCELLATION_SHARE = 0.9       # credit covers >= 90% of the invoice's goods value
LARGE_QTY = 1000
EXAMPLES = 5

ONE = Decimal(1)
HUNDRED = Decimal(100)


# --------------------------------------------------------------------------- raw rows


class Row(NamedTuple):
    sheet: str
    row: int                 # spreadsheet row number (header is row 1)
    invoice: str
    stock_code: str          # exactly as in the source (may carry case/whitespace variants)
    description: str | None
    quantity: int
    ts: datetime
    price: str               # exact decimal string in GBP, e.g. "2.55", "0.001"
    customer_id: int | None
    country: str


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _is_nan(v: object) -> bool:
    return isinstance(v, float) and math.isnan(v)


def _text(v: object) -> str | None:
    if v is None or _is_nan(v):
        return None
    if isinstance(v, bool):
        raise ValueError(f"unexpected boolean cell {v!r}")
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    s = str(v)
    return s if s != "" else None


def _int(v: object) -> int:
    if isinstance(v, bool):
        raise ValueError(f"unexpected boolean cell {v!r}")
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    raise ValueError(f"expected an integer, got {v!r}")


def _price(v: object) -> str:
    if isinstance(v, bool) or v is None or _is_nan(v):
        raise ValueError(f"bad price cell {v!r}")
    d = Decimal(v) if isinstance(v, int) else Decimal(repr(float(v)))
    if d == 0:
        return "0"
    return format(d.normalize(), "f")


def _timestamp(v: object) -> datetime:
    if hasattr(v, "to_pydatetime"):
        v = v.to_pydatetime()
    if not isinstance(v, datetime):
        raise ValueError(f"expected a datetime, got {v!r}")
    return v.replace(tzinfo=None)


def read_xlsx(path: Path) -> list[Row]:
    """Parse both sheets with pandas/openpyxl, keeping exact cell values."""
    import pandas as pd

    frames = pd.read_excel(path, sheet_name=list(SHEETS), engine="openpyxl", dtype=object)
    rows: list[Row] = []
    for sheet in SHEETS:
        df = frames[sheet]
        if list(df.columns) != COLUMNS:
            raise ValueError(f"unexpected columns in {sheet!r}: {list(df.columns)}")
        for i, (inv, code, desc, qty, ts, price, cid, country) in enumerate(df.itertuples(index=False, name=None)):
            invoice = _text(inv)
            stock = _text(code)
            if invoice is None or stock is None:
                raise ValueError(f"{sheet} row {i + 2}: missing invoice or stock code")
            cid_text = _text(cid)
            rows.append(Row(
                sheet=sheet,
                row=i + 2,
                invoice=invoice.strip(),
                stock_code=stock,
                description=_text(desc),
                quantity=_int(qty),
                ts=_timestamp(ts),
                price=_price(price),
                customer_id=None if cid_text is None else int(cid_text),
                country=_text(country) or "",
            ))
    return rows


def write_cache(path: Path, rows: Iterable[Row]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
        text = io.TextIOWrapper(gz, encoding="utf-8", newline="")
        w = csv.writer(text, lineterminator="\n")
        w.writerow(CACHE_HEADER)
        for r in rows:
            w.writerow([r.sheet, r.row, r.invoice, r.stock_code, r.description or "", r.quantity,
                        r.ts.isoformat(), r.price, "" if r.customer_id is None else r.customer_id, r.country])
        text.flush()
        text.detach()
    tmp.replace(path)


def read_cache(path: Path) -> list[Row]:
    rows: list[Row] = []
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        if next(reader) != CACHE_HEADER:
            raise ValueError(f"unexpected cache header in {path}")
        for sheet, row, inv, code, desc, qty, ts, price, cid, country in reader:
            rows.append(Row(sheet, int(row), inv, code, desc or None, int(qty), datetime.fromisoformat(ts),
                            price, int(cid) if cid else None, country))
    return rows


def load_rows(xlsx: Path, cache_dir: Path | None = DEFAULT_CACHE_DIR) -> tuple[list[Row], str]:
    """Return all rows of both sheets plus the xlsx SHA-256 (a gzip CSV cache speeds up reruns)."""
    sha = sha256_file(xlsx)
    cache = None if cache_dir is None else cache_dir / f"{xlsx.stem}.{sha[:16]}.v{CACHE_VERSION}.csv.gz"
    if cache is not None and cache.exists():
        return read_cache(cache), sha
    rows = read_xlsx(xlsx)
    if cache is not None:
        write_cache(cache, rows)
    return rows, sha


def drop_sheet_overlap(rows: list[Row]) -> tuple[list[Row], dict]:
    """Sheet 2 restarts on 2010-12-01, so sheet 1's last days are an exact copy. Keep sheet 2's copy."""
    s1 = [r for r in rows if r.sheet == SHEETS[0]]
    s2 = [r for r in rows if r.sheet == SHEETS[1]]
    if len(s1) + len(s2) != len(rows):
        raise ValueError("rows from an unexpected sheet")
    s2_start = min(r.ts for r in s2)
    s1_end = max(r.ts for r in s1)
    dup1 = [r for r in s1 if r.ts >= s2_start]
    dup2 = [r for r in s2 if r.ts <= s1_end]
    content = lambda r: r[2:]  # everything except sheet and row number
    if Counter(map(content, dup1)) != Counter(map(content, dup2)):
        raise ValueError("the overlap between the two sheets is not an exact duplicate; refusing to guess")
    kept = [r for r in s1 if r.ts < s2_start] + s2
    info = {
        "rows_per_sheet_in_source": {SHEETS[0]: len(s1), SHEETS[1]: len(s2)},
        "overlap_from": s2_start.isoformat(),
        "overlap_to": s1_end.isoformat(),
        "duplicate_rows_removed": len(dup1),
        "duplicate_invoices_removed": len({r.invoice for r in dup1}),
        "rule": f"rows of {SHEETS[0]!r} dated on/after {s2_start.isoformat()} are exact copies of rows in {SHEETS[1]!r} and were dropped",
    }
    return kept, info


# --------------------------------------------------------------------------- documents


def pence(gbp: Decimal) -> int:
    """GBP -> integer pence, rounding half away from zero."""
    return int((gbp * HUNDRED).quantize(ONE, rounding=ROUND_HALF_UP))


def line_type_of(stock_code: str) -> str:
    key = stock_code.strip().upper()
    if key in SPECIAL_LINE_TYPES:
        return SPECIAL_LINE_TYPES[key]
    if key.startswith("GIFT"):
        return "gift_voucher"
    return "product"


@dataclass
class Line:
    source_row: int
    stock_code: str
    description: str | None
    quantity: int
    price: Decimal
    line_type: str
    total_pence: int

    @property
    def key(self) -> str:
        return self.stock_code.upper()

    @property
    def sub_penny(self) -> bool:
        return (self.price * HUNDRED) != (self.price * HUNDRED).to_integral_value()

    def to_json(self) -> dict:
        out = {
            "stock_code": self.stock_code,
            "description": self.description,
            "quantity": self.quantity,
            "unit_price_pence": pence(self.price),
            "line_total_pence": self.total_pence,
            "line_type": self.line_type,
            "source_row": self.source_row,
        }
        if self.sub_penny:
            out["unit_price_gbp_exact"] = format(self.price, "f")
        return out


@dataclass
class Doc:
    number: str
    kind: str                       # "invoice" | "credit_note" | "adjustment" (A-prefixed)
    customer_id: int | None
    sheet: str
    lines: list[Line] = field(default_factory=list)
    timestamps: set = field(default_factory=set)
    countries: set = field(default_factory=set)
    goods: dict = field(default_factory=dict)   # stock key -> (qty, pence, prices); credited side for CNs

    @property
    def ts(self) -> datetime:
        return min(self.timestamps)

    @property
    def total_pence(self) -> int:
        return sum(ln.total_pence for ln in self.lines)

    @property
    def goods_pence(self) -> int:
        return sum(ln.total_pence for ln in self.lines if ln.line_type in GOODS_LINE_TYPES)

    def buckets(self) -> dict[str, int]:
        out = dict.fromkeys(BUCKETS, 0)
        for ln in self.lines:
            if ln.line_type not in GOODS_LINE_TYPES:
                out[SPECIAL_BUCKET[ln.line_type]] += ln.total_pence
        return out


def doc_kind(number: str) -> str:
    if number.startswith("C"):
        return "credit_note"
    if number.startswith("A"):
        return "adjustment"
    return "invoice"


def goods_profile(doc: Doc) -> dict[str, tuple[int, int, frozenset]]:
    """Per stock code: quantity, value and unit prices, signed so that the document's own direction is positive."""
    sign = -1 if doc.kind == "credit_note" else 1
    acc: dict[str, tuple[int, int, frozenset]] = {}
    for ln in doc.lines:
        if ln.line_type not in GOODS_LINE_TYPES:
            continue
        q, v, prices = acc.get(ln.key, (0, 0, frozenset()))
        acc[ln.key] = (q + sign * ln.quantity, v + sign * ln.total_pence, prices | {ln.price})
    return {k: val for k, val in acc.items() if val[0] > 0}


def build_docs(rows: Iterable[Row]) -> dict[str, Doc]:
    docs: dict[str, Doc] = {}
    for r in rows:
        d = docs.get(r.invoice)
        if d is None:
            d = docs[r.invoice] = Doc(r.invoice, doc_kind(r.invoice), r.customer_id, r.sheet)
        elif d.customer_id != r.customer_id:
            raise ValueError(f"invoice {r.invoice} has lines for several customers")
        price = Decimal(r.price)
        desc = r.description.strip() if r.description else None
        d.lines.append(Line(r.row, r.stock_code.strip(), desc or None, r.quantity, price,
                            line_type_of(r.stock_code), pence(price * r.quantity)))
        d.timestamps.add(r.ts)
        d.countries.add(r.country)
    for d in docs.values():
        d.goods = goods_profile(d)
    return docs


# --------------------------------------------------------------------------- credit-note linking


@dataclass
class Match:
    coverage: float            # share of the credited value found on the candidate (quantity-capped)
    price_coverage: float      # ... of which at the same unit price
    effective: float           # (coverage + price_coverage) / 2: price mismatches count half
    exact_qty_share: float     # share of credited value whose quantity equals the candidate's line quantity
    share_of_invoice: float    # share of the candidate's goods value that this credit note reverses
    full_reversal: bool
    basis: str
    matched: dict = field(default_factory=dict)      # credited stock key -> units found on the candidate
    price_ok: frozenset = frozenset()                # credited stock keys found at the same unit price
    typos: tuple = ()                                # (credited key, invoiced key) one character apart, see evaluate_goods
    covered_value: float = 0.0                       # candidate goods value (pence) reversed


def _one_char_apart(a: str, b: str) -> bool:
    """Same length and either one substituted character or two swapped neighbours (typo-like)."""
    if len(a) != len(b) or a == b:
        return False
    diff = [i for i, (x, y) in enumerate(zip(a, b, strict=True)) if x != y]
    if len(diff) == 1:
        return True
    return len(diff) == 2 and diff[1] == diff[0] + 1 and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]]


def _weights(credit: dict) -> tuple[dict, float]:
    weights = {k: max(v, 0) for k, (_, v, _) in credit.items()}
    if sum(weights.values()) <= 0:            # zero-priced credit lines: weight by units instead
        weights = {k: q for k, (q, _, _) in credit.items()}
    return weights, sum(weights.values())


def evaluate_goods(credit: dict, invoice: dict) -> Match | None:
    weights, total = _weights(credit)
    if total <= 0:
        return None
    cov = pcov = exact = 0.0
    covered_value = covered_units = 0.0
    matched: dict[str, int] = {}
    price_ok: set[str] = set()
    typos: list[tuple[str, str]] = []
    exact_hits = sum(1 for k in credit if k in invoice)
    for k, (q, _, prices) in credit.items():
        ik = k if k in invoice else None
        if ik is None and exact_hits and q >= 2:
            # neighbouring stock code (wrong variant keyed or returned): only on an invoice that already
            # matches other credited codes, with the same quantity and unit price
            near = [c for c, (iq, _, ip) in invoice.items()
                    if c not in credit and iq == q and prices & ip and _one_char_apart(k, c)]
            if len(near) == 1:
                ik = near[0]
                typos.append((k, ik))
        if ik is None:
            continue
        iq, iv, iprices = invoice[ik]
        units = min(q, iq)
        cov += weights[k] * units / q
        if prices & iprices:
            pcov += weights[k] * units / q
            price_ok.add(k)
        if iq == q:
            exact += weights[k]
        matched[k] = units
        covered_value += iv * units / iq
        covered_units += units
    if cov <= 0:
        return None
    inv_value = sum(iv for _, iv, _ in invoice.values())
    inv_units = sum(iq for iq, _, _ in invoice.values())
    share = covered_value / inv_value if inv_value > 0 else covered_units / inv_units
    cov, pcov, exact = cov / total, pcov / total, exact / total
    full = cov >= 0.98 and share >= 0.98
    basis = "stock_codes+neighbouring_code" if typos else "stock_codes"
    return Match(cov, pcov, (cov + pcov) / 2, exact, share, full, basis, matched, frozenset(price_ok),
                 tuple(typos), covered_value)


def _residual(credit: dict, matched: dict) -> dict:
    out = {}
    for k, (q, v, prices) in credit.items():
        left = q - matched.get(k, 0)
        if left > 0:
            out[k] = (left, v * left / q, prices)
    return out


def _matches_discount_percent(amount: int, base: int) -> bool:
    if base <= 0:
        return False
    return any(abs(Decimal(amount) - Decimal(base) * p / HUNDRED) <= ONE for p in DISCOUNT_PERCENTS)


def evaluate_special(cn: Doc, inv: Doc, lag_days: float) -> Match | None:
    """Credit notes made only of special lines (Manual, Discount, POSTAGE, ...)."""
    total = sum(abs(ln.total_pence) for ln in cn.lines)
    if total == 0:
        return None
    pool = Counter((ln.line_type, ln.total_pence) for ln in inv.lines if ln.line_type not in GOODS_LINE_TYPES)
    goods_lines = [ln for ln in inv.lines if ln.line_type in GOODS_LINE_TYPES and ln.quantity > 0]
    explained = 0.0          # evidence-weighted
    explained_any = 0.0      # amount of credit lines with any evidence
    all_same_line = True
    bases: set[str] = set()
    recent = lag_days <= DISCOUNT_LOOKBACK_DAYS
    for ln in cn.lines:
        amount = abs(ln.total_pence)
        qty = abs(ln.quantity)
        rules: list[tuple[float, str]] = []
        if pool[(ln.line_type, amount)] > 0:
            pool[(ln.line_type, amount)] -= 1
            rules.append((1.0, "same_special_line"))
        else:
            all_same_line = False
            if ln.line_type in ("manual", "adjustment") and qty > 1:
                same_price = [g for g in goods_lines if g.price == ln.price]
                if any(g.quantity == qty for g in same_price):
                    rules.append((0.8, "manual_line_matches_goods_qty_and_price"))
                elif any(g.quantity > qty for g in same_price):
                    rules.append((0.6, "manual_line_matches_goods_price"))
            if ln.line_type == "discount" and recent:
                if _matches_discount_percent(amount, inv.goods_pence):
                    rules.append((0.7, "discount_is_round_percent_of_invoice"))
                if qty > 1 and any(g.quantity == qty for g in goods_lines):
                    rules.append((0.5, "discount_qty_matches_goods_line"))
            if ln.line_type == "postage":
                same_rate = [s for s in inv.lines if s.line_type == "postage" and s.price == ln.price]
                if any(s.quantity >= qty for s in same_rate):
                    rules.append((0.9, "postage_refund_within_invoice_postage"))
                elif same_rate:
                    rules.append((0.6, "same_postage_rate"))
        if rules:
            weight, basis = max(rules)
            bases.add(basis)
            explained += weight * amount
            explained_any += amount
    if explained <= 0 and -cn.total_pence != inv.total_pence:
        return None
    cov, eff = explained_any / total, explained / total
    full = (all_same_line and sum(pool.values()) == 0 and not goods_lines) or (-cn.total_pence == inv.total_pence)
    if -cn.total_pence == inv.total_pence:   # amount-only evidence: fully explained, but weaker than line matches
        cov, eff = 1.0, max(eff, 0.9)
        explained_any = total
        bases.add("amount_equals_invoice_total")
    share = min(1.0, explained_any / inv.total_pence) if inv.total_pence > 0 else 0.0
    return Match(cov, cov, eff, 0.0, 1.0 if full else share, full, "+".join(sorted(bases)))


def candidate_score(m: Match, lag_days: float) -> float:
    s = m.effective ** 4 * (1.0 + m.exact_qty_share) * (FULL_REVERSAL_BOOST if m.full_reversal else 1.0)
    return s / (1.0 + max(lag_days, 0.0) / RECENCY_SCALE_DAYS) ** 2


def evaluate(cn: Doc, inv: Doc, lag_days: float) -> Match | None:
    if cn.goods:
        return evaluate_goods(cn.goods, inv.goods)
    return evaluate_special(cn, inv, lag_days)


@dataclass
class Link:
    invoice: Doc | None                 # primary (most likely) original
    confidence: float
    reason: str
    match: Match | None                 # primary match
    lag_days: float | None
    candidates: int
    plausible_alternatives: int
    later_match: Doc | None
    extra: list = field(default_factory=list)          # [(Doc, Match)] further originals, most valuable first
    coverage: float = 0.0               # combined over primary + extra
    price_coverage: float = 0.0
    share_of_invoices: float = 0.0      # credited share of the linked invoices' goods value
    allocations: list = field(default_factory=list)    # [(invoice_no, pence)], summing to the credit amount
    typos: tuple = ()


def _combined(credit: dict, matches: list[Match]) -> tuple[float, float]:
    weights, total = _weights(credit)
    got: Counter = Counter()
    got_price: Counter = Counter()
    for m in matches:
        for k, units in m.matched.items():
            got[k] += units
            if k in m.price_ok:
                got_price[k] += units
    cov = sum(weights[k] * min(q, got[k]) / q for k, (q, _, _) in credit.items()) / total
    pcov = sum(weights[k] * min(q, got_price[k]) / q for k, (q, _, _) in credit.items()) / total
    return cov, pcov


def link_credit_note(cn: Doc, earlier: list[Doc], later: list[Doc]) -> Link:
    """Pick the most likely original among the customer's earlier invoices.

    score      = effective^4 * (1 + exact_qty_share) * (10 if full reversal) / (1 + age_days / 14)^2
    confidence = best score / (sum of scores + 0.01 for "not in the data") * effective coverage
    If the primary leaves >5% of the credited goods unexplained, further earlier invoices are added
    greedily (each must explain >= 5%). `later` holds the customer's invoices raised up to 2 days
    after the credit note, to spot re-bills.
    """
    scored = []
    for inv in earlier:
        lag = (cn.ts - inv.ts).total_seconds() / 86400.0
        m = evaluate(cn, inv, lag)
        if m is not None:
            scored.append((candidate_score(m, lag), inv.ts, inv.number, inv, m, lag))
    scored.sort(key=lambda t: (t[0], t[1], t[2]), reverse=True)

    later_match = None
    later_cov = None
    for inv in sorted(later, key=lambda d: (d.ts, d.number)):
        m = evaluate(cn, inv, 0.0)
        if m is None or m.coverage < LATER_MATCH_MIN_COVERAGE or m.share_of_invoice < LATER_MATCH_MIN_SHARE:
            continue
        if later_cov is None or m.coverage > later_cov:
            later_match, later_cov = inv, m.coverage

    has_goods = bool(cn.goods)
    if not scored:
        reason = "return" if has_goods else "manual_adjustment"
        return Link(None, 0.0, reason, None, None, 0, 0, later_match)
    best_score, _, _, inv, m, lag = scored[0]
    posterior = best_score / (sum(t[0] for t in scored) + NULL_WEIGHT)
    alternatives = sum(1 for t in scored[1:] if t[0] >= 0.5 * best_score)

    extra: list[tuple[Doc, Match]] = []
    cov, pcov = m.coverage, m.price_coverage
    if has_goods and cov < 1.0 - MIN_EXTRA_GAIN:
        residual = _residual(cn.goods, m.matched)
        used = {inv.number}
        while residual and len(extra) < MAX_EXTRA_INVOICES:
            best = None
            for _, _, _, cand, _, cand_lag in scored[1:]:
                if cand.number in used:
                    continue
                m2 = evaluate_goods(residual, cand.goods)
                if m2 is None:
                    continue
                gain = _combined(cn.goods, [m2])[0]
                if gain < MIN_EXTRA_GAIN:
                    continue
                key = (candidate_score(m2, cand_lag), cand.ts, cand.number)
                if best is None or key > best[0]:
                    best = (key, cand, m2)
            if best is None:
                break
            extra.append((best[1], best[2]))
            used.add(best[1].number)
            residual = _residual(residual, best[2].matched)
        if extra:
            cov, pcov = _combined(cn.goods, [m] + [mx for _, mx in extra])
    effective = (cov + pcov) / 2 if has_goods else m.effective
    linked = [(inv, m)] + extra
    if has_goods:
        share = sum(mx.covered_value for _, mx in linked) / max(sum(d.goods_pence for d, _ in linked), 1)
    else:
        share = m.share_of_invoice
    if extra:  # score the set of linked invoices as one hypothesis against the remaining candidates
        full = cov >= 0.98 and share >= 0.98
        joint = candidate_score(Match(cov, pcov, effective, 1.0 if full else 0.0, share, full, ""), lag)
        numbers = {d.number for d, _ in linked}
        rest = sum(t[0] for t in scored if t[2] not in numbers)
        posterior = max(posterior, joint / (joint + rest + NULL_WEIGHT))
    confidence = round(posterior * effective, 3)

    # allocate the credit to the linked invoices: each extra invoice gets the credited value it explains,
    # the primary gets the rest (including unexplained value and special lines)
    amount = -cn.total_pence
    allocations = []
    for d, mx in extra:
        allocations.append((d.number, int(round(sum(cn.goods[k][1] * units / cn.goods[k][0] for k, units in mx.matched.items())))))
    allocations.insert(0, (inv.number, amount - sum(a for _, a in allocations)))

    if not has_goods:
        reason = "manual_adjustment"
    elif share >= CANCELLATION_SHARE and effective >= 0.9:
        reason = "cancellation"
    else:
        reason = "return"
    typos = tuple(t for _, mx in linked for t in mx.typos)
    return Link(inv, confidence, reason, m, lag, len(scored), alternatives, later_match, extra,
                cov, pcov, share, allocations, typos)


# --------------------------------------------------------------------------- helpers


def iso_day(ts: datetime) -> str:
    return ts.date().isoformat()


def _round_half_away(x: Fraction) -> int:
    n = math.floor(abs(x) + Fraction(1, 2))
    return n if x >= 0 else -n


def percentiles(values: list[int], ps=(0, 5, 10, 25, 50, 75, 90, 95, 99, 100)) -> dict[str, int]:
    """Linear interpolation between closest ranks (numpy's default), exact, rounded to whole units."""
    xs = sorted(values)
    out: dict[str, int] = {}
    for p in ps if xs else ():
        pos = Fraction((len(xs) - 1) * p, 100)
        lo, hi = math.floor(pos), math.ceil(pos)
        out[f"p{p}"] = _round_half_away(xs[lo] + (xs[hi] - xs[lo]) * (pos - lo))
    return out


def ratio(a: float, b: float, nd: int = 4) -> float:
    return round(a / b, nd) if b else 0.0


def phenomenon(pid: str, scope: str, description: str, count: int, examples: Iterable = (), **extra) -> dict:
    out = {"id": pid, "scope": scope, "count": count, "description": description}
    out.update(extra)
    ex = list(examples)[:EXAMPLES]
    if ex:
        out["examples"] = ex
    return out


def dumps_records(records: list[dict]) -> str:
    """A JSON array with one record per line: valid JSON, compact, grep- and diff-friendly."""
    if not records:
        return "[]\n"
    body = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in records)
    return "[\n" + body + "\n]\n"


# --------------------------------------------------------------------------- the build


@dataclass
class Params:
    start: date = DEFAULT_START
    end: date = DEFAULT_END
    top: int = DEFAULT_TOP
    min_invoices: int = DEFAULT_MIN_INVOICES

    @property
    def t0(self) -> datetime:
        return datetime.combine(self.start, datetime.min.time())

    @property
    def t1(self) -> datetime:  # exclusive
        return datetime.combine(self.end + timedelta(days=1), datetime.min.time())


def select_customers(window_rows: list[Row], p: Params) -> tuple[list[int], dict]:
    net: Counter = Counter()
    invoices: dict[int, set] = defaultdict(set)
    for r in window_rows:
        if r.customer_id is None:
            continue
        net[r.customer_id] += pence(Decimal(r.price) * r.quantity)
        if doc_kind(r.invoice) == "invoice":
            invoices[r.customer_id].add(r.invoice)
    active = sorted(net)
    eligible = [c for c in active if len(invoices[c]) >= p.min_invoices]
    ranked = sorted(eligible, key=lambda c: (-net[c], c))
    chosen = ranked[: p.top]
    info = {
        "customers_active_in_window": len(active),
        "customers_with_min_invoices": len(eligible),
        "selected": len(chosen),
        "cutoff_net_revenue_pence": net[chosen[-1]] if chosen else None,
        "next_excluded_net_revenue_pence": net[ranked[p.top]] if len(ranked) > p.top else None,
        "selected_share_of_window_customer_revenue": ratio(sum(net[c] for c in chosen), sum(net.values())),
    }
    return chosen, info


def build(all_rows: list[Row], source_sha256: str, p: Params) -> dict:
    """Pure function: raw rows in, the four output documents (as Python objects) out."""
    rows, overlap = drop_sheet_overlap(all_rows)
    window_rows = [r for r in rows if p.t0 <= r.ts < p.t1]
    selected_ids, selection_info = select_customers(window_rows, p)
    selected = set(selected_ids)
    code_of = {c: f"B-{c}" for c in selected_ids}

    # Documents of the selected customers over the whole source (history is needed for linking).
    docs = build_docs(r for r in rows if r.customer_id in selected)
    in_window = lambda d: p.t0 <= d.ts < p.t1
    invoices = sorted((d for d in docs.values() if d.kind == "invoice" and in_window(d)), key=lambda d: (d.ts, d.number))
    credits = sorted((d for d in docs.values() if d.kind == "credit_note" and in_window(d)), key=lambda d: (d.ts, d.number))
    if any(d.kind == "adjustment" for d in docs.values()):
        raise ValueError("A-prefixed adjustment documents unexpectedly carry a customer id")

    history: dict[int, list[Doc]] = defaultdict(list)
    for d in sorted((d for d in docs.values() if d.kind == "invoice"), key=lambda d: (d.ts, d.number)):
        history[d.customer_id].append(d)
    history_ts = {c: [d.ts for d in ds] for c, ds in history.items()}

    # ---- link credit notes
    links: dict[str, Link] = {}
    claimed_later: set[str] = set()   # each later invoice is the re-bill of at most one credit note
    for cn in credits:
        invs, ts_list = history.get(cn.customer_id, []), history_ts.get(cn.customer_id, [])
        cut = bisect.bisect_right(ts_list, cn.ts)
        stop = bisect.bisect_right(ts_list, cn.ts + LATER_MATCH_WINDOW)
        later = [d for d in invs[cut:stop] if in_window(d) and d.number not in claimed_later]
        lk = links[cn.number] = link_credit_note(cn, invs[:cut], later)
        if lk.later_match is not None:
            claimed_later.add(lk.later_match.number)

    # credit notes repeating an earlier credit note's amount for the same customer within 31 days
    repeat_of: dict[str, str] = {}
    for i, cn in enumerate(credits):
        for prev in reversed(credits[:i]):
            if cn.ts - prev.ts > DUPLICATE_CREDIT_WINDOW:
                break
            if prev.customer_id == cn.customer_id and prev.total_pence == cn.total_pence:
                repeat_of[cn.number] = prev.number
                break

    credited_by: dict[str, list[str]] = defaultdict(list)
    allocated: Counter = Counter()
    rebill_of: dict[str, list[str]] = defaultdict(list)
    for cn in credits:
        lk = links[cn.number]
        for inv_no, pence_ in lk.allocations:
            credited_by[inv_no].append(cn.number)
            allocated[inv_no] += pence_
        if lk.later_match is not None:
            rebill_of[lk.later_match.number].append(cn.number)

    # ---- invoice-level messy signals
    day_net = Counter((d.customer_id, d.ts.date(), d.total_pence) for d in invoices)
    signature = lambda d: (d.customer_id, tuple(sorted((ln.key, ln.quantity, str(ln.price)) for ln in d.lines)))
    content_count = Counter(signature(d) for d in invoices)

    def doc_line_flags(d: Doc) -> list[str]:
        flags = []
        if len(d.timestamps) > 1:
            flags.append("multiple_timestamps")
        exact = Counter((ln.key, ln.description, ln.quantity, ln.price) for ln in d.lines)
        if any(n > 1 for n in exact.values()):
            flags.append("duplicate_lines")
        if any(ln.price == 0 for ln in d.lines):
            flags.append("zero_price_line")
        if any(ln.sub_penny for ln in d.lines):
            flags.append("sub_penny_price")
        if any(abs(ln.quantity) >= LARGE_QTY for ln in d.lines):
            flags.append("large_quantity_line")
        sign_wrong = (lambda q: q < 0) if d.kind == "invoice" else (lambda q: q > 0)
        if any(sign_wrong(ln.quantity) for ln in d.lines):
            flags.append("quantity_sign_mismatch")
        return flags

    invoice_records = []
    for d in invoices:
        b = d.buckets()
        cns = sorted(credited_by.get(d.number, []), key=lambda n: (docs[n].ts, n))
        credited = allocated[d.number]
        flags = doc_line_flags(d)
        if day_net[(d.customer_id, d.ts.date(), d.total_pence)] > 1:
            flags.append("duplicate_looking_same_day_same_amount")
        if content_count[signature(d)] > 1:
            flags.append("identical_content_repeat")
        if cns:
            flags.append("fully_credited" if credited >= CANCELLATION_SHARE * d.total_pence else "partially_credited")
        if rebill_of.get(d.number):
            flags.append("matches_earlier_credit_note")
        invoice_records.append({
            "invoice_no": d.number,
            "customer_code": code_of[d.customer_id],
            "invoice_date": d.ts.isoformat(),
            "gross_pence": d.goods_pence,
            "special_lines": b,
            "net_pence": d.total_pence,
            "currency": "GBP",
            "line_count": len(d.lines),
            "credit_note_nos": cns,
            "credited_pence": credited,
            "flags": sorted(flags),
            "source_sheet": d.sheet,
            "lines": [ln.to_json() for ln in d.lines],
        })

    window_invoice_nos = {d.number for d in invoices}
    credit_records = []
    for cn in credits:
        lk = links[cn.number]
        b = {k: -v for k, v in cn.buckets().items()}
        flags = doc_line_flags(cn)
        m = lk.match
        linked_docs = [lk.invoice] + [d for d, _ in lk.extra] if lk.invoice else []
        if lk.invoice is None:
            flags.append("no_findable_original")
        else:
            if lk.invoice.number not in window_invoice_nos:
                flags.append("original_before_window")
            if lk.plausible_alternatives:
                flags.append("ambiguous_original")
            if lk.coverage < 0.999:
                flags.append("partially_traceable")
            if cn.goods and lk.price_coverage < lk.coverage - 1e-9:
                flags.append("price_differs_from_original")
            if -cn.total_pence > sum(d.total_pence for d in linked_docs):
                flags.append("exceeds_original_invoice")
            if lk.extra:
                flags.append("spans_several_invoices")
            if lk.typos:
                flags.append("neighbouring_stock_code_matched")
        if lk.later_match is not None:
            flags.append("cancel_and_rebill" if lk.invoice is not None and lk.coverage >= 0.9 else "precedes_matching_invoice")
        if not cn.goods:
            flags.append("special_lines_only")
        if cn.number in repeat_of:
            flags.append("same_amount_as_recent_credit_note")
        rec = {
            "credit_no": cn.number,
            "customer_code": code_of[cn.customer_id],
            "date": cn.ts.isoformat(),
            "amount_pence": -cn.total_pence,
            "linked_invoice_no": lk.invoice.number if lk.invoice else None,
            "link_confidence": lk.confidence,
            "reason_guess": lk.reason,
            "currency": "GBP",
            "linked_invoice_date": lk.invoice.ts.isoformat() if lk.invoice else None,
            "linked_invoice_net_pence": lk.invoice.total_pence if lk.invoice else None,
            "linked_invoice_in_window": (lk.invoice.number in window_invoice_nos) if lk.invoice else None,
            "additional_linked_invoice_nos": [d.number for d, _ in lk.extra],
            "allocations": [{"invoice_no": n, "amount_pence": a} for n, a in lk.allocations],
            "match": None if m is None else {
                "basis": "+".join(sorted({m.basis, *(mx.basis for _, mx in lk.extra)})),
                "coverage": round(lk.coverage, 3),
                "price_coverage": round(lk.price_coverage, 3),
                "share_of_invoice_credited": round(lk.share_of_invoices, 3),
                "days_after_invoice": round(lk.lag_days, 2),
                "candidates": lk.candidates,
                "plausible_alternatives": lk.plausible_alternatives,
                "neighbouring_code_matches": [list(t) for t in lk.typos],
            },
            "later_matching_invoice_no": lk.later_match.number if lk.later_match else None,
            "goods_pence": -cn.goods_pence,
            "special_lines": b,
            "line_count": len(cn.lines),
            "flags": sorted(flags),
            "source_sheet": cn.sheet,
            "lines": [ln.to_json() for ln in cn.lines],
        }
        credit_records.append(rec)

    # ---- customers
    inv_by_cust: dict[int, list[Doc]] = defaultdict(list)
    for d in invoices:
        inv_by_cust[d.customer_id].append(d)
    cn_by_cust: dict[int, list[Doc]] = defaultdict(list)
    for d in credits:
        cn_by_cust[d.customer_id].append(d)
    all_countries: dict[int, set] = defaultdict(set)
    for r in rows:
        if r.customer_id in selected:
            all_countries[r.customer_id].add(r.country)

    customer_records = []
    for rank, cid in enumerate(selected_ids, start=1):
        ivs = inv_by_cust[cid]
        cnl = cn_by_cust[cid]
        votes = Counter()
        for d in ivs:
            for c in d.countries:
                votes[c] += 1
        latest = max(ivs, key=lambda d: (d.ts, d.number))
        country = sorted(votes, key=lambda c: (-votes[c], c != sorted(latest.countries)[0], c))[0]
        invoiced = sum(d.total_pence for d in ivs)
        credited = sum(-d.total_pence for d in cnl)
        before = [d for d in history[cid] if d.ts < p.t0]
        customer_records.append({
            "customer_code": code_of[cid],
            "source_customer_id": cid,
            "country": country,
            "currency_guess": "EUR" if country in EUROZONE_2011 else "GBP",
            "invoice_count": len(ivs),
            "net_revenue_pence": invoiced - credited,
            "first_invoice_date": iso_day(min(d.ts for d in ivs)),
            "last_invoice_date": iso_day(max(d.ts for d in ivs)),
            "rank": rank,
            "invoiced_pence": invoiced,
            "credit_note_count": len(cnl),
            "credited_pence": credited,
            "countries_seen": sorted(all_countries[cid]),
            "first_seen_in_source": iso_day(min(d.ts for d in history[cid])),
            "invoices_before_window": len(before),
            "invoiced_before_window_pence": sum(d.total_pence for d in before),
        })

    stats = build_stats(rows, window_rows, overlap, selection_info, p, source_sha256, docs, invoices, credits,
                        invoice_records, credit_records, customer_records)
    return {
        "customers": customer_records,
        "invoices": invoice_records,
        "credit_notes": credit_records,
        "stats": stats,
    }


def build_stats(rows, window_rows, overlap, selection_info, p, sha, docs, invoices, credits,
                invoice_records, credit_records, customer_records) -> dict:
    sel_lines = [(d, ln) for d in invoices + credits for ln in d.lines]
    cust_country = {c["customer_code"]: c["country"] for c in customer_records}
    cust_currency = {c["customer_code"]: c["currency_guess"] for c in customer_records}

    # ---- totals
    totals = {
        "invoices_gross_pence": sum(r["gross_pence"] for r in invoice_records),
        "invoices_postage_pence": sum(r["special_lines"]["postage_pence"] for r in invoice_records),
        "invoices_manual_pence": sum(r["special_lines"]["manual_pence"] for r in invoice_records),
        "invoices_fees_pence": sum(r["special_lines"]["fees_pence"] for r in invoice_records),
        "invoices_net_pence": sum(r["net_pence"] for r in invoice_records),
        "credit_notes_pence": sum(r["amount_pence"] for r in credit_records),
    }
    totals["net_revenue_pence"] = totals["invoices_net_pence"] - totals["credit_notes_pence"]
    by_currency: dict[str, dict] = {}
    for cur in sorted(set(cust_currency.values())):
        inv_c = [r for r in invoice_records if cust_currency[r["customer_code"]] == cur]
        cn_c = [r for r in credit_records if cust_currency[r["customer_code"]] == cur]
        by_currency[cur] = {
            "customers": sum(1 for v in cust_currency.values() if v == cur),
            "invoices": len(inv_c),
            "credit_notes": len(cn_c),
            "net_revenue_pence": sum(r["net_pence"] for r in inv_c) - sum(r["amount_pence"] for r in cn_c),
        }
    totals["by_currency_guess"] = by_currency

    # ---- per country
    per_country: dict[str, dict] = defaultdict(lambda: {"customers": 0, "invoices": 0, "credit_notes": 0, "net_revenue_pence": 0})
    for c in customer_records:
        pc = per_country[c["country"]]
        pc["customers"] += 1
        pc["invoices"] += c["invoice_count"]
        pc["credit_notes"] += c["credit_note_count"]
        pc["net_revenue_pence"] += c["net_revenue_pence"]
    per_country_sorted = {k: per_country[k] for k in sorted(per_country, key=lambda k: (-per_country[k]["customers"], -per_country[k]["net_revenue_pence"], k))}

    # ---- link summary
    reasons = Counter(r["reason_guess"] for r in credit_records)
    conf = [r["link_confidence"] for r in credit_records if r["linked_invoice_no"]]
    conf_bands = Counter()
    for c in conf:
        conf_bands[">=0.8" if c >= 0.8 else "0.5-0.8" if c >= 0.5 else "0.2-0.5" if c >= 0.2 else "<0.2"] += 1

    # ---- messy phenomena
    ph: list[dict] = []
    cn_flag = lambda f: [r["credit_no"] for r in credit_records if f in r["flags"]]
    inv_flag = lambda f: [r["invoice_no"] for r in invoice_records if f in r["flags"]]

    x = cn_flag("no_findable_original")
    ph.append(phenomenon("credit_note_without_findable_original", "selected",
                         "credit notes for which no earlier invoice of the same customer contains the credited items (or, for manual/discount/postage credits, a matching amount)",
                         len(x), x, amount_pence=sum(amount_of(credit_records, x))))
    x = cn_flag("original_before_window")
    ph.append(phenomenon("credit_note_against_pre_window_invoice", "selected",
                         "credit notes whose most likely original was invoiced before the window (likely already settled, so the credit becomes an unapplied balance)",
                         len(x), x, amount_pence=sum(amount_of(credit_records, x))))
    x = cn_flag("ambiguous_original")
    ph.append(phenomenon("credit_note_ambiguous_original", "selected",
                         "credit notes with at least one other earlier invoice scoring >= 50% of the chosen one (the customer re-ordered the same items)",
                         len(x), x))
    x = cn_flag("partially_traceable")
    ph.append(phenomenon("credit_note_partially_traceable", "selected",
                         "linked credit notes where part of the credited value is not on the linked invoice (items spread over several invoices, or more units credited than invoiced there)",
                         len(x), x))
    x = cn_flag("price_differs_from_original")
    ph.append(phenomenon("credit_note_price_differs_from_original", "selected",
                         "credited unit price differs from the unit price on the linked invoice for some items", len(x), x))
    x = cn_flag("exceeds_original_invoice")
    ph.append(phenomenon("credit_note_exceeds_linked_invoice", "selected",
                         "credit note amount is larger than the whole linked invoice", len(x), x))
    x = cn_flag("spans_several_invoices")
    ph.append(phenomenon("credit_note_spans_several_invoices", "selected",
                         "one credit note reverses items from two or more earlier invoices (see additional_linked_invoice_nos / allocations)",
                         len(x), x))
    x = cn_flag("neighbouring_stock_code_matched")
    ph.append(phenomenon("credit_line_neighbouring_stock_code", "selected",
                         "a credited stock code is one character away from a code on the linked invoice with the same quantity and price, "
                         "on an invoice that matches the credit note otherwise (wrong variant keyed, e.g. 47566B 'TEA TIME PARTY BUNTING' credited against 47556B 'TEA TIME TEA TOWELS')",
                         len(x), x))
    x = cn_flag("cancel_and_rebill")
    ph.append(phenomenon("cancel_and_rebill", "selected",
                         "credit note reverses an earlier invoice and a near-identical invoice follows within 2 days", len(x), x))
    x = cn_flag("precedes_matching_invoice")
    ph.append(phenomenon("credit_note_precedes_matching_invoice", "selected",
                         "no good earlier original, but an invoice with the same items/amount is raised within 2 days AFTER the credit note (out-of-order entry)",
                         len(x), x))
    x = cn_flag("same_amount_as_recent_credit_note")
    ph.append(phenomenon("duplicate_looking_credit_notes", "selected",
                         "credit notes with exactly the same amount as an earlier credit note of the same customer within 31 days (possible double credit)",
                         len(x), x, amount_pence=sum(amount_of(credit_records, x))))
    multi = [r["invoice_no"] for r in invoice_records if len(r["credit_note_nos"]) > 1]
    ph.append(phenomenon("invoice_with_multiple_credit_notes", "selected",
                         "in-window invoices that more than one credit note links to", len(multi), multi))
    x = inv_flag("fully_credited")
    ph.append(phenomenon("invoice_fully_credited", "selected",
                         "in-window invoices whose linked credit notes total >= 90% of the invoice", len(x), x))
    x = inv_flag("duplicate_looking_same_day_same_amount")
    groups = Counter((r["customer_code"], r["invoice_date"][:10], r["net_pence"]) for r in invoice_records if r["invoice_no"] in set(x))
    ph.append(phenomenon("duplicate_looking_invoices", "selected",
                         "different invoice numbers for the same customer on the same day with the same net amount",
                         len(x), x, groups=len(groups)))
    x = inv_flag("identical_content_repeat")
    ph.append(phenomenon("identical_content_invoices", "selected",
                         "invoices whose line items (code, quantity, price) are identical to another invoice of the same customer, any day",
                         len(x), x))
    x = inv_flag("multiple_timestamps")
    ph.append(phenomenon("invoice_with_multiple_timestamps", "selected",
                         "invoices whose lines carry more than one timestamp (invoice_date uses the earliest)", len(x), x))
    dup_groups = Counter((d.number, ln.key, ln.description, ln.quantity, ln.price) for d, ln in sel_lines)
    dup = sorted({k[0] for k, n in dup_groups.items() if n > 1})
    ph.append(phenomenon("exact_duplicate_lines_within_document", "selected",
                         "the same line (code, description, quantity, price) appears more than once on one document",
                         sum(n - 1 for n in dup_groups.values() if n > 1), dup, documents=len(dup)))
    rep = defaultdict(set)
    for d, ln in sel_lines:
        rep[(d.number, ln.key)].add(ln.price)
    rep_counts = Counter((d.number, ln.key) for d, ln in sel_lines)
    repeated = [k for k, n in rep_counts.items() if n > 1]
    ph.append(phenomenon("stock_code_repeated_within_document", "selected",
                         "a stock code appears on several lines of one document (split lines)", len(repeated),
                         sorted({k[0] for k in repeated}), with_different_prices=sum(1 for k in repeated if len(rep[k]) > 1)))
    zero = [(d.number, ln.stock_code) for d, ln in sel_lines if ln.price == 0]
    ph.append(phenomenon("zero_unit_price_lines", "selected", "lines with unit price 0.00", len(zero), [f"{a}:{b}" for a, b in zero]))
    neg = [(d.number, ln.stock_code) for d, ln in sel_lines if ln.price < 0]
    ph.append(phenomenon("negative_unit_price_lines", "selected", "lines with a negative unit price", len(neg), [f"{a}:{b}" for a, b in neg]))
    sub = [(d.number, ln.stock_code) for d, ln in sel_lines if ln.sub_penny]
    ph.append(phenomenon("sub_penny_unit_prices", "selected",
                         "unit prices with fractions of a penny (e.g. 0.001); line totals are rounded to the penny",
                         len(sub), [f"{a}:{b}" for a, b in sub]))
    neg_inv = [(d.number, ln.stock_code) for d, ln in sel_lines if d.kind == "invoice" and ln.quantity < 0]
    ph.append(phenomenon("negative_quantity_line_not_marked_C", "selected",
                         "negative-quantity lines on invoices whose number does not start with C", len(neg_inv),
                         [f"{a}:{b}" for a, b in neg_inv]))
    pos_cn = [(d.number, ln.stock_code) for d, ln in sel_lines if d.kind == "credit_note" and ln.quantity > 0]
    ph.append(phenomenon("positive_quantity_line_on_credit_note", "selected",
                         "positive-quantity lines on C-numbered credit notes", len(pos_cn), [f"{a}:{b}" for a, b in pos_cn]))
    big = [(d.number, ln.stock_code) for d, ln in sel_lines if abs(ln.quantity) >= LARGE_QTY]
    ph.append(phenomenon("very_large_quantity_lines", "selected", f"lines with |quantity| >= {LARGE_QTY}", len(big),
                         [f"{a}:{b}" for a, b in big]))
    for lt in ("manual", "discount", "postage", "bank_charges", "fee", "adjustment", "samples", "test"):
        on_inv = [(d, ln) for d, ln in sel_lines if ln.line_type == lt and d.kind == "invoice"]
        on_cn = [(d, ln) for d, ln in sel_lines if ln.line_type == lt and d.kind == "credit_note"]
        if not on_inv and not on_cn:
            continue
        ph.append(phenomenon(f"{lt}_lines", "selected",
                             f"special '{lt}' lines ({', '.join(sorted(k for k, v in SPECIAL_LINE_TYPES.items() if v == lt))}) kept as flagged lines",
                             len(on_inv) + len(on_cn),
                             sorted({d.number for d, _ in on_inv + on_cn}, key=lambda n: (docs[n].ts, n)),
                             on_invoices=len(on_inv), on_invoices_pence=sum(ln.total_pence for _, ln in on_inv),
                             on_credit_notes=len(on_cn), on_credit_notes_pence=sum(ln.total_pence for _, ln in on_cn)))
    x = cn_flag("special_lines_only")
    ph.append(phenomenon("credit_note_special_lines_only", "selected",
                         "credit notes made only of Manual/Discount/POSTAGE/... lines (no stock codes to trace)", len(x), x))
    desc_var = defaultdict(set)
    for _, ln in sel_lines:
        if ln.line_type in GOODS_LINE_TYPES and ln.description:
            desc_var[ln.key].add(ln.description)
    multi_desc = sorted(k for k, v in desc_var.items() if len(v) > 1)
    ph.append(phenomenon("stock_code_with_several_descriptions", "selected",
                         "stock codes that appear with more than one description", len(multi_desc), multi_desc))

    # ---- window-wide and source-wide context (rows that are not part of the selected world)
    no_cid_w = [r for r in window_rows if r.customer_id is None]
    ph.append(phenomenon("rows_without_customer_id", "window_all_customers",
                         "window rows with no Customer ID (excluded from the world)", len(no_cid_w),
                         sorted({r.invoice for r in no_cid_w})[:EXAMPLES],
                         documents=len({r.invoice for r in no_cid_w}),
                         value_pence=sum(pence(Decimal(r.price) * r.quantity) for r in no_cid_w)))
    wneg = [r for r in window_rows if r.quantity < 0 and doc_kind(r.invoice) == "invoice"]
    ph.append(phenomenon("negative_quantity_line_not_marked_C", "window_all_customers",
                         "negative-quantity lines on non-C invoices anywhere in the window (stock write-offs such as 'damaged', 'thrown away')",
                         len(wneg), sorted({r.invoice for r in wneg})[:EXAMPLES],
                         with_customer_id=sum(1 for r in wneg if r.customer_id is not None)))
    wzero = [r for r in window_rows if Decimal(r.price) == 0]
    ph.append(phenomenon("zero_unit_price_lines", "window_all_customers", "lines with unit price 0.00 anywhere in the window",
                         len(wzero), sorted({r.invoice for r in wzero})[:EXAMPLES],
                         with_customer_id=sum(1 for r in wzero if r.customer_id is not None)))
    wcn_nocid = sorted({r.invoice for r in no_cid_w if doc_kind(r.invoice) == "credit_note"})
    ph.append(phenomenon("credit_notes_without_customer_id", "window_all_customers",
                         "C-numbered documents with no Customer ID (cannot be put on any account)", len(wcn_nocid), wcn_nocid))
    wpos = [r for r in window_rows if r.quantity > 0 and doc_kind(r.invoice) == "credit_note"]
    ph.append(phenomenon("positive_quantity_line_on_credit_note", "window_all_customers",
                         "positive-quantity lines on C-numbered documents anywhere in the window", len(wpos),
                         sorted({r.invoice for r in wpos})[:EXAMPLES]))
    ph.append(phenomenon("cross_sheet_duplicate_rows", "source",
                         "rows present in both sheets (sheet 1 runs to 2010-12-09, sheet 2 restarts on 2010-12-01); the sheet-1 copy is dropped",
                         overlap["duplicate_rows_removed"], [], documents=overlap["duplicate_invoices_removed"]))
    a_docs = sorted({r.invoice for r in rows if doc_kind(r.invoice) == "adjustment"})
    ph.append(phenomenon("bad_debt_adjustment_documents", "source",
                         "A-numbered 'Adjust bad debt' documents (negative prices, no customer)", len(a_docs), a_docs,
                         value_pence=sum(pence(Decimal(r.price) * r.quantity) for r in rows if doc_kind(r.invoice) == "adjustment")))
    sneg = [r for r in rows if r.quantity < 0 and doc_kind(r.invoice) == "invoice"]
    ph.append(phenomenon("negative_quantity_line_not_marked_C", "source",
                         "negative-quantity lines on non-C invoices in the whole source", len(sneg),
                         sorted({r.invoice for r in sneg})[:EXAMPLES],
                         with_customer_id=sum(1 for r in sneg if r.customer_id is not None)))
    sprice = [r for r in rows if Decimal(r.price) < 0]
    ph.append(phenomenon("negative_unit_price_lines", "source", "lines with a negative unit price in the whole source",
                         len(sprice), sorted({r.invoice for r in sprice})[:EXAMPLES]))
    ssub = [r for r in rows if (Decimal(r.price) * HUNDRED) % 1 != 0]
    ph.append(phenomenon("sub_penny_unit_prices", "source", "unit prices with fractions of a penny in the whole source",
                         len(ssub), sorted({f"{r.invoice}:{r.stock_code.strip()}" for r in ssub})[:EXAMPLES]))
    spell = defaultdict(set)
    for r in rows:
        spell[r.stock_code.strip().upper()].add(r.stock_code)
    variants = sorted(k for k, v in spell.items() if len(v) > 1)
    ph.append(phenomenon("stock_code_spelling_variants", "source",
                         "stock codes that occur in several spellings (case, e.g. 15056BL/15056bl, or trailing spaces); matched case-insensitively",
                         len(variants), variants))
    cc = defaultdict(set)
    for r in rows:
        if r.customer_id is not None:
            cc[r.customer_id].add(r.country)
    mc = sorted(c for c, v in cc.items() if len(v) > 1)
    ph.append(phenomenon("customer_with_several_countries", "source",
                         "customer ids that appear with more than one country", len(mc), mc,
                         in_selection=sum(1 for c in mc if f"B-{c}" in cust_country)))

    inv_sizes = [r["net_pence"] for r in invoice_records]
    line_counts = [r["line_count"] for r in invoice_records]
    with_cn = sum(1 for c in customer_records if c["credit_note_count"] > 0)
    window_cid_rows = [r for r in window_rows if r.customer_id is not None]
    return {
        "source": {
            "dataset": "Online Retail II (UCI Machine Learning Repository, id 502)",
            "page": SOURCE_PAGE,
            "download_url": SOURCE_URL,
            "doi": SOURCE_DOI,
            "license": SOURCE_LICENSE,
            "xlsx_sha256": sha,
            "rows_per_sheet": overlap["rows_per_sheet_in_source"],
            "rows_after_overlap_removal": len(rows),
            "sheet_overlap": overlap,
        },
        "selection": {
            "window_start": p.start.isoformat(),
            "window_end_inclusive": p.end.isoformat(),
            "top_n_by_net_revenue": p.top,
            "min_invoices_in_window": p.min_invoices,
            "rule": "customers with a Customer ID and >= min invoices (non-C documents) in the window, ranked by net revenue (all lines incl. credit notes) in the window, ties by id",
            **selection_info,
        },
        "window_context": {
            "rows": len(window_rows),
            "rows_with_customer_id": len(window_cid_rows),
            "documents": len({r.invoice for r in window_rows}),
            "documents_with_customer_id": len({r.invoice for r in window_cid_rows}),
            "net_value_pence_all_rows": sum(pence(Decimal(r.price) * r.quantity) for r in window_rows),
            "net_value_pence_with_customer_id": sum(pence(Decimal(r.price) * r.quantity) for r in window_cid_rows),
        },
        "counts": {
            "customers": len(customer_records),
            "invoices": len(invoice_records),
            "credit_notes": len(credit_records),
            "invoice_lines": sum(line_counts),
            "credit_note_lines": sum(r["line_count"] for r in credit_records),
            "lines_by_type": dict(sorted(Counter(ln.line_type for _, ln in sel_lines).items())),
            "credit_notes_linked": sum(1 for r in credit_records if r["linked_invoice_no"]),
            "credit_notes_linked_in_window": sum(1 for r in credit_records if r["linked_invoice_in_window"]),
            "credit_notes_by_reason_guess": dict(sorted(reasons.items())),
            "linked_confidence_bands": dict(sorted(conf_bands.items())),
            "customers_by_currency_guess": dict(sorted(Counter(cust_currency.values()).items())),
        },
        "totals": totals,
        "share_of_customers_with_credit_notes": ratio(with_cn, len(customer_records)),
        "customers_with_credit_notes": with_cn,
        "credit_to_invoice_value_ratio": ratio(totals["credit_notes_pence"], totals["invoices_net_pence"]),
        "per_country": per_country_sorted,
        "invoice_net_pence_percentiles": percentiles(inv_sizes),
        "invoice_net_pence_mean": int((Decimal(sum(inv_sizes)) / max(len(inv_sizes), 1)).quantize(ONE, rounding=ROUND_HALF_UP)),
        "invoice_line_count_percentiles": percentiles(line_counts),
        "credit_note_amount_pence_percentiles": percentiles([r["amount_pence"] for r in credit_records]),
        "messy_phenomena": ph,
    }


def amount_of(credit_records: list[dict], numbers: list[str]) -> list[int]:
    wanted = set(numbers)
    return [r["amount_pence"] for r in credit_records if r["credit_no"] in wanted]


# --------------------------------------------------------------------------- CLI


def write_outputs(result: dict, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for name in ("customers", "invoices", "credit_notes"):
        path = out_dir / f"{name}.json"
        path.write_text(dumps_records(result[name]), encoding="utf-8")
        paths.append(path)
    path = out_dir / "stats.json"
    path.write_text(json.dumps(result["stats"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    paths.append(path)
    return paths


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX, help="path to online_retail_II.xlsx")
    ap.add_argument("--out", type=Path, default=DATA_DIR, help="output directory for the JSON files")
    ap.add_argument("--start", type=date.fromisoformat, default=DEFAULT_START, help="window start (inclusive)")
    ap.add_argument("--end", type=date.fromisoformat, default=DEFAULT_END, help="window end (inclusive)")
    ap.add_argument("--top", type=int, default=DEFAULT_TOP, help="number of customers to keep")
    ap.add_argument("--min-invoices", type=int, default=DEFAULT_MIN_INVOICES, help="minimum invoices in the window")
    ap.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR, help="where to keep the parsed-rows cache")
    ap.add_argument("--no-cache", action="store_true", help="always parse the xlsx (slow, ~40 s)")
    ap.add_argument("--allow-hash-mismatch", action="store_true", help="build even if the xlsx differs from the recorded SHA-256")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.xlsx.exists():
        print(f"missing {args.xlsx}; run tools/data_b/fetch_raw.sh first", file=sys.stderr)
        return 2
    rows, sha = load_rows(args.xlsx, None if args.no_cache else args.cache_dir)
    if sha != EXPECTED_XLSX_SHA256 and not args.allow_hash_mismatch:
        print(f"xlsx SHA-256 {sha} differs from the recorded {EXPECTED_XLSX_SHA256} (see PROVENANCE.md); "
              "pass --allow-hash-mismatch to build anyway", file=sys.stderr)
        return 3
    params = Params(args.start, args.end, args.top, args.min_invoices)
    result = build(rows, sha, params)
    for path in write_outputs(result, args.out):
        print(f"wrote {path}")
    c = result["stats"]["counts"]
    t = result["stats"]["totals"]
    print(f"{c['customers']} customers, {c['invoices']} invoices, {c['credit_notes']} credit notes; "
          f"invoiced GBP {t['invoices_net_pence'] / 100:,.2f}, credited GBP {t['credit_notes_pence'] / 100:,.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
