"""Checks for the company-B world. Run from tools/data_b:  uv run pytest

The output checks read data/companyB/*.json; the raw-total and reproducibility checks
also need data/companyB/raw/online_retail_II.xlsx (run fetch_raw.sh) and are skipped without it.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import pytest

import build_company_b as b

OUTPUTS = ("customers", "invoices", "credit_notes", "stats")
NULLABLE_PENCE = {"linked_invoice_net_pence"}


@pytest.fixture(scope="module")
def world() -> dict:
    missing = [n for n in OUTPUTS if not (b.DATA_DIR / f"{n}.json").exists()]
    if missing:
        pytest.fail(f"missing outputs {missing}: run `uv run python build_company_b.py` first")
    return {n: json.loads((b.DATA_DIR / f"{n}.json").read_text(encoding="utf-8")) for n in OUTPUTS}


def _params(world: dict) -> b.Params:
    sel = world["stats"]["selection"]
    return b.Params(date.fromisoformat(sel["window_start"]), date.fromisoformat(sel["window_end_inclusive"]),
                    sel["top_n_by_net_revenue"], sel["min_invoices_in_window"])


def _pence_fields(obj, path="$"):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.endswith("_pence"):
                yield f"{path}.{k}", k, v
            if k.endswith("_pence_percentiles") or k.endswith("_pence_mean"):
                for pk, pv in (v.items() if isinstance(v, dict) else [("value", v)]):
                    yield f"{path}.{k}.{pk}", k, pv
            yield from _pence_fields(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _pence_fields(v, f"{path}[{i}]")


# --------------------------------------------------------------------------- output checks


def test_amounts_are_integer_pence(world):
    seen = 0
    for name in OUTPUTS:
        for path, key, value in _pence_fields(world[name], name):
            if value is None and key in NULLABLE_PENCE:
                continue
            if isinstance(value, dict):  # e.g. special_lines: its members are checked on their own
                continue
            assert isinstance(value, int) and not isinstance(value, bool), f"{path} = {value!r} is not an integer"
            seen += 1
    n_lines = sum(len(d["lines"]) for d in world["invoices"] + world["credit_notes"])
    assert seen >= 2 * n_lines  # every line carries unit_price_pence and line_total_pence


def test_credit_notes_refer_to_existing_customers(world):
    customers = {c["customer_code"]: c for c in world["customers"]}
    invoices = {i["invoice_no"]: i for i in world["invoices"]}
    assert len(customers) == len(world["customers"])
    assert len(invoices) == len(world["invoices"])
    for inv in world["invoices"]:
        assert inv["customer_code"] in customers
    for cn in world["credit_notes"]:
        assert cn["customer_code"] in customers, cn["credit_no"]
        assert cn["credit_no"].startswith("C")
        assert cn["amount_pence"] > 0
        assert 0.0 <= cn["link_confidence"] <= 1.0
        assert cn["reason_guess"] in {"cancellation", "return", "manual_adjustment"}
        if cn["linked_invoice_no"] is None:
            assert cn["link_confidence"] == 0.0
            continue
        assert cn["linked_invoice_date"] <= cn["date"], "an original must not be later than its credit note"
        if cn["linked_invoice_in_window"]:
            inv = invoices[cn["linked_invoice_no"]]
            assert inv["customer_code"] == cn["customer_code"]
            assert cn["credit_no"] in inv["credit_note_nos"]
        else:
            assert cn["linked_invoice_no"] not in invoices


def test_invoice_net_matches_raw_window_totals(world):
    """Independent of the build code: re-read the xlsx with pandas and sum Quantity * Price."""
    if not b.DEFAULT_XLSX.exists():
        pytest.skip("raw xlsx not downloaded (tools/data_b/fetch_raw.sh)")
    import pandas as pd

    p = _params(world)
    sheets = [b.SHEETS[1]] if p.start >= date(2010, 12, 1) else list(b.SHEETS)
    frames = pd.read_excel(b.DEFAULT_XLSX, sheet_name=sheets, engine="openpyxl")
    if len(sheets) == 2:  # sheet 1 repeats 2010-12-01..09; keep sheet 2's copy
        s1 = frames[b.SHEETS[0]]
        frames[b.SHEETS[0]] = s1[s1["InvoiceDate"] < pd.Timestamp("2010-12-01")]
    df = pd.concat(frames.values(), ignore_index=True)
    ids = {c["source_customer_id"] for c in world["customers"]}
    df = df[df["Customer ID"].isin(ids)]
    df = df[(df["InvoiceDate"] >= pd.Timestamp(p.t0)) & (df["InvoiceDate"] < pd.Timestamp(p.t1))]
    is_credit = df["Invoice"].astype(str).str.startswith("C")
    amount = df["Quantity"] * df["Price"] * 100

    inv_raw, cn_raw = float(amount[~is_credit].sum()), float(-amount[is_credit].sum())
    inv_out = sum(i["net_pence"] for i in world["invoices"])
    cn_out = sum(c["amount_pence"] for c in world["credit_notes"])
    # rounding each line to whole pence moves a sub-penny line by at most half a penny;
    # whole-penny lines are exact, so allow 1p of float noise on top
    sub_penny = (amount.round(6) % 1) != 0
    assert abs(inv_out - inv_raw) <= 0.5 * int((sub_penny & ~is_credit).sum()) + 1.0
    assert abs(cn_out - cn_raw) <= 0.5 * int((sub_penny & is_credit).sum()) + 1.0
    assert sum(i["line_count"] for i in world["invoices"]) == int((~is_credit).sum())
    assert sum(c["line_count"] for c in world["credit_notes"]) == int(is_credit.sum())
    assert len(world["invoices"]) == df.loc[~is_credit, "Invoice"].nunique()
    assert len(world["credit_notes"]) == df.loc[is_credit, "Invoice"].nunique()


def test_internal_consistency(world):
    for inv in world["invoices"]:
        assert inv["net_pence"] == inv["gross_pence"] + sum(inv["special_lines"].values())
        assert inv["net_pence"] == sum(ln["line_total_pence"] for ln in inv["lines"])
        assert inv["line_count"] == len(inv["lines"])
        assert set(inv["special_lines"]) == {"postage_pence", "manual_pence", "fees_pence"}
    for cn in world["credit_notes"]:
        assert cn["amount_pence"] == -sum(ln["line_total_pence"] for ln in cn["lines"])
        assert cn["amount_pence"] == cn["goods_pence"] + sum(cn["special_lines"].values())
    by_code = {c["customer_code"]: c for c in world["customers"]}
    for code, c in by_code.items():
        invs = [i for i in world["invoices"] if i["customer_code"] == code]
        cns = [n for n in world["credit_notes"] if n["customer_code"] == code]
        assert c["invoice_count"] == len(invs) >= world["stats"]["selection"]["min_invoices_in_window"]
        assert c["invoiced_pence"] == sum(i["net_pence"] for i in invs)
        assert c["credited_pence"] == sum(n["amount_pence"] for n in cns)
        assert c["net_revenue_pence"] == c["invoiced_pence"] - c["credited_pence"]
        assert c["first_invoice_date"] == min(i["invoice_date"] for i in invs)[:10]
        assert c["currency_guess"] in {"GBP", "EUR"}
    ranks = [c["net_revenue_pence"] for c in world["customers"]]
    assert ranks == sorted(ranks, reverse=True)
    totals = world["stats"]["totals"]
    assert totals["net_revenue_pence"] == sum(ranks)
    assert world["stats"]["counts"]["invoices"] == len(world["invoices"])


def test_outputs_are_reproducible(world, tmp_path):
    if not b.DEFAULT_XLSX.exists():
        pytest.skip("raw xlsx not downloaded (tools/data_b/fetch_raw.sh)")
    rows, sha = b.load_rows(b.DEFAULT_XLSX)
    assert sha == b.EXPECTED_XLSX_SHA256 == world["stats"]["source"]["xlsx_sha256"]
    b.write_outputs(b.build(rows, sha, _params(world)), tmp_path)
    for name in OUTPUTS:
        assert (tmp_path / f"{name}.json").read_bytes() == (b.DATA_DIR / f"{name}.json").read_bytes(), name


# --------------------------------------------------------------------------- unit checks (synthetic rows)

T0 = datetime(2011, 1, 3, 10, 0)


def _rows(spec):
    """spec: (invoice, stock_code, quantity, price, minutes after T0[, customer])."""
    out = []
    for n, (inv, code, qty, price, minutes, *cust) in enumerate(spec, start=2):
        out.append(b.Row(b.SHEETS[1], n, inv, code, f"item {code}", qty, T0 + timedelta(minutes=minutes),
                         price, cust[0] if cust else 1, "United Kingdom"))
    return out


def _link(spec, cn_no):
    docs = b.build_docs(_rows(spec))
    cn = docs[cn_no]
    invoices = sorted((d for d in docs.values() if d.kind == "invoice"), key=lambda d: (d.ts, d.number))
    return b.link_credit_note(cn, [d for d in invoices if d.ts <= cn.ts],
                              [d for d in invoices if cn.ts < d.ts <= cn.ts + b.LATER_MATCH_WINDOW])


def test_full_reversal_is_a_confident_cancellation():
    lk = _link([
        ("100", "11111", 10, "2.55", 0), ("100", "22222", 5, "1.25", 0),
        ("101", "11111", 10, "2.55", 7 * 1440),             # later re-order of one of the items
        ("C102", "11111", -10, "2.55", 7 * 1440 + 30), ("C102", "22222", -5, "1.25", 7 * 1440 + 30),
    ], "C102")
    assert lk.invoice.number == "100" and lk.reason == "cancellation" and lk.confidence > 0.8


def test_matching_price_beats_a_more_recent_invoice():
    lk = _link([
        ("200", "33333", 12, "1.65", 0),
        ("201", "33333", 12, "1.45", 31 * 1440),            # same item, newer price
        ("C202", "33333", -2, "1.65", 35 * 1440),
    ], "C202")
    assert lk.invoice.number == "200" and lk.reason == "return"


def test_manual_credit_reversing_a_manual_invoice():
    lk = _link([("300", "M", 1, "100", 0), ("C301", "M", -1, "100", 5)], "C301")
    assert lk.invoice.number == "300" and lk.reason == "manual_adjustment" and lk.confidence > 0.9


def test_unbought_item_is_unlinked_and_later_invoices_are_never_originals():
    lk = _link([("C400", "44444", -3, "2.10", 0), ("401", "44444", 3, "2.10", 60)], "C400")
    assert lk.invoice is None and lk.confidence == 0.0 and lk.reason == "return"
    assert lk.later_match is not None and lk.later_match.number == "401"


def test_line_types_and_pence_rounding():
    assert [b.line_type_of(c) for c in ("POST", "DOT", "C2", "m", "D", "BANK CHARGES", "AMAZONFEE", "85123A", "gift_0001_20")] == \
        ["postage", "postage", "postage", "manual", "discount", "bank_charges", "fee", "product", "gift_voucher"]
    from decimal import Decimal
    assert b.pence(Decimal("0.001") * 1) == 0 and b.pence(Decimal("0.001") * 5) == 1 and b.pence(Decimal("-0.005")) == -1
    assert b.pence(Decimal("2.55") * 6) == 1530


def test_sheet_overlap_must_be_an_exact_copy():
    s1 = [b.Row(b.SHEETS[0], 2, "1", "X", None, 1, datetime(2010, 11, 30, 9), "1", 1, "UK"),
          b.Row(b.SHEETS[0], 3, "2", "X", None, 1, datetime(2010, 12, 1, 9), "1", 1, "UK")]
    s2 = [b.Row(b.SHEETS[1], 2, "2", "X", None, 1, datetime(2010, 12, 1, 9), "1", 1, "UK")]
    kept, info = b.drop_sheet_overlap(s1 + s2)
    assert [r.invoice for r in kept] == ["1", "2"] and info["duplicate_rows_removed"] == 1
    with pytest.raises(ValueError):
        b.drop_sheet_overlap(s1 + [s2[0]._replace(quantity=2)])
