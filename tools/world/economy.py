"""The honest economy of Pearl Lane Tea Co.: what each store truly sells, what the
card processor settles, and what the stores buy from the franchisor's ERP.

The seats see only these trusted feeds plus what franchisees email, so this is
where the world's consistency lives: supply-implied sales are drinks x 650 cents
over supply invoices dated [week - 3 days, week + 4 days), exactly as seats.ts
computes them, and card sales reported honestly equal what the processor settled.
"""
from __future__ import annotations

import math

from cast import DAY_PATTERNS, LOW_CASH_STORES, STORES, store
from common import WEEKS, add_days, rng_for

AVG_TICKET_CENTS = 650
N_SUPPLY_WEEKS = len(WEEKS) + 1  # the ERP also invoices the week after the window (dated Fri Jun 26)

# Seasonality by week index: a January dip, then a steady climb into summer (+20-25%).
SEASON = [0.88, 0.86, 0.89, 0.92, 0.95, 0.97, 0.98, 0.97, 1.00, 1.01, 1.03, 1.04, 1.05,
          1.06, 1.08, 1.09, 1.10, 1.12, 1.14, 1.16, 1.18, 1.20, 1.22, 1.23, 1.24, 1.24]

# One-off demand events: (week index, stores or 'all', multiplier, why).
EVENTS = [
    (5, "all", 1.03, "Valentine's Day weekend"),
    (6, ["S03"], 1.18, "Lunar New Year in Chinatown"),
    (6, ["S29", "S14"], 1.08, "Lunar New Year"),
    (6, ["S22"], 1.07, "Seollal in Koreatown"),
    (2, ["S11", "S36"], 0.94, "atmospheric river in Seattle"),
    (19, "all", 1.04, "Memorial Day weekend"),
    (22, ["S03", "S07", "S20", "S26"], 1.06, "Summer Mango Fest promo"),
    (23, ["S03", "S07", "S20", "S26"], 1.05, "Summer Mango Fest promo"),
]

# Legitimate bulk buys: supply-implied sales jump 25-35% one week, then a light week.
# A naive "supplies exceed reported sales" rule would flag these honest stores.
BULK_BUYS = {
    19: (["S01", "S05", "S12", "S27", "S38"], "stocking up before Memorial Day"),
    22: (["S03", "S07", "S20", "S26"], "Summer Mango Fest promo stock"),
}

# Supply catalogue: SKU, description, unit price (cents), drinks one unit serves, share of drinks that use it.
CATALOGUE = [
    ("CUP-22OZ", "22 oz PP cups, case of 500", 6_120, 500, 1.00),
    ("SEAL-FILM", "Cup sealing film roll (3,000 seals)", 5_860, 3_000, 1.00),
    ("STRAW-BOBA", "Wide boba straws, case of 1,000", 3_570, 1_000, 1.00),
    ("PEARL-TAP", "Tapioca pearls, 3 kg bag", 1_940, 65, 0.72),
    ("TEA-BLACK", "Assam black tea leaves, 600 g", 2_350, 120, 0.45),
    ("TEA-JASMINE", "Jasmine green tea leaves, 600 g", 2_480, 120, 0.30),
    ("CREAMER-ND", "Non-dairy creamer, 1 kg", 1_560, 45, 0.50),
    ("SYRUP-FRU", "Fructose syrup, 2.5 kg", 1_850, 90, 0.90),
    ("JAM-FRUIT", "Fruit jam assortment, 2.5 kg", 4_500, 80, 0.25),
    ("MILK-OAT", "Oat milk, 1 L carton", 580, 5, 0.08),
    ("SYRUP-BSUG", "Brown sugar syrup, 2 kg", 3_190, 70, 0.18),
]
FUEL_SURCHARGE = ("FUEL-SURCH", "Freight fuel surcharge (FA schedule B)", 9_250)
FUEL_SURCHARGE_FROM = "2026-05-01"
FUEL_SURCHARGE_STORES = {"S22", "S26", "S27", "S38"}  # Southern California deliveries


def simulate_sales() -> dict[str, list[dict]]:
    """True weekly sales per store: gross, card, cash and the seven daily amounts."""
    out: dict[str, list[dict]] = {}
    for code, *_ in STORES:
        s = store(code)
        r = rng_for("sales", code)
        low_cash = code in LOW_CASH_STORES
        weeks = []
        for w in range(N_SUPPLY_WEEKS):
            m = SEASON[w] * (1 + r.gauss(0, 0.04))
            for wk, who, mult, _ in EVENTS:
                if wk == w and (who == "all" or code in who):
                    m *= mult
            gross = round(s["base"] * 100 * m)
            weights = [p * (1 + r.gauss(0, 0.07)) for p in DAY_PATTERNS[s["pattern"]]]
            daily = [round(gross * x / sum(weights)) for x in weights]
            daily[-1] += gross - sum(daily)
            jitter = 0.008 if low_cash else 0.012
            share = s["card_share"] + max(-2.5 * jitter, min(2.5 * jitter, r.gauss(0, jitter)))
            card_daily = [min(g, round(g * share * (1 + r.gauss(0, 0.02)))) for g in daily]
            card = sum(card_daily)
            weeks.append({"week": WEEKS[w] if w < len(WEEKS) else add_days(WEEKS[-1], 7), "gross": gross, "card": card, "cash": gross - card,
                          "daily": daily, "card_daily": card_daily})
        out[code] = weeks
    return out


def settlement_payload(code: str, day: str, card_cents: int) -> dict:
    fees = round(card_cents * 0.0265) + 10 * max(1, card_cents // 900)  # 2.65% + 10 cents a swipe
    return {"storeCode": code, "businessDate": day, "cardGrossCents": card_cents, "feesCents": fees, "netCents": card_cents - fees}


def supply_lines(drinks: int, r) -> list[dict]:
    lines = []
    for sku, _desc, unit, serves, use in CATALOGUE:
        qty = max(1, round(drinks * use * (1 + r.gauss(0, 0.04)) / serves))
        lines.append({"sku": sku, "qty": qty, "unitCents": unit})
    return lines


def make_supply_invoices(sales: dict[str, list[dict]], same_order: dict[tuple[str, int], str]) -> dict[str, list[dict]]:
    """Weekly ERP invoices per store, dated the Friday before the sales week, due ten days later.

    `same_order` maps (store, week index) -> another store whose order this one copies line
    for line that week (a multi-unit owner placing one combined order split evenly).
    """
    seq = 24_001
    out: dict[str, list[dict]] = {code: [] for code, *_ in STORES}
    order_cache: dict[tuple[str, int], tuple[int, list[dict]]] = {}
    for w in range(N_SUPPLY_WEEKS):
        for code, *_ in STORES:
            s = store(code)
            r = rng_for("supply", code, w)
            gross = sales[code][w]["gross"]
            factor, why = 1.0, ""
            for bw, (who, reason) in BULK_BUYS.items():
                if code in who and w == bw:
                    factor, why = 1.25 + r.random() * 0.10, reason
                elif code in who and w == bw + 1:
                    factor, why = 0.74 + r.random() * 0.06, "light week after a bulk buy"
            noise = max(-0.05, min(0.05, r.gauss(0, 0.025)))
            drinks = round(gross / AVG_TICKET_CENTS * s["waste"] * (1 + noise) * factor)
            lines = supply_lines(drinks, r)
            if (code, w) in same_order:
                drinks, lines = order_cache[(same_order[(code, w)], w)]
                lines = [dict(x) for x in lines]
            order_cache[(code, w)] = (drinks, lines)
            date = add_days(WEEKS[0], 7 * w - 3)
            if code in FUEL_SURCHARGE_STORES and date >= FUEL_SURCHARGE_FROM:
                lines = lines + [{"sku": FUEL_SURCHARGE[0], "qty": 1, "unitCents": FUEL_SURCHARGE[2]}]
            total = sum(x["qty"] * x["unitCents"] for x in lines)
            out[code].append({"invoiceNo": f"SUP-{seq}", "storeCode": code, "entityCode": s["entity"], "date": date, "dueDate": add_days(date, 10),
                              "lines": lines, "totalCents": total, "impliedDrinks": drinks, "week": w, "note": why})
            seq += 1
    return out


def implied_gross(supply_invoice: dict) -> int:
    return supply_invoice["impliedDrinks"] * AVG_TICKET_CENTS


def cash_cut_for_share(card: int, target_share: float) -> int:
    """Reported cash that makes cash / (card + cash) equal target_share."""
    return math.floor(card * target_share / (1 - target_share))
