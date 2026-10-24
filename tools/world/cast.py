"""Who is who at Pearl Lane Tea Co.: contracts, franchisees, stores, staff.

Stores carry the economics the generator needs (weekly sales level, card share,
supply waste); entities carry what the franchisor has on file. Everything here
is fiction: 555 phone numbers, invented companies and people.
"""
from __future__ import annotations

COMPANY = {"name": "Pearl Lane Tea Co.", "kind": "franchisor", "currency": "USD", "startDate": "2026-01-05"}
AR_INBOX = "ar@pearllanetea.com"

# Older agreements apply a payment to royalties before fees; newer ones take
# interest and fees first (the 2022 rewrite).
OLD_ORDER = ["royalty", "supply", "audit", "fee", "interest", "trade"]
NEW_ORDER = ["interest", "fee", "royalty", "audit", "supply", "trade"]


def _terms(version, royalty_bp, grace, late_fee, nsf, terms_days, order):
    return {"version": version, "royaltyBp": royalty_bp, "graceDays": grace, "lateFeeCents": late_fee, "interestBpPerMonth": 150,
            "nsfFeeCents": nsf, "auditThresholdBp": 200, "paymentTermsDays": terms_days, "applicationOrder": order}


CONTRACTS = {
    "FA-2019": _terms("FA-2019", 500, 15, 5_000, 2_500, 3, OLD_ORDER),
    "FA-2022": _terms("FA-2022", 600, 10, 7_500, 3_500, 2, NEW_ORDER),
    "FA-2025": _terms("FA-2025", 650, 5, 10_000, 3_500, 2, NEW_ORDER),
}

# code, legal name, owner, contact email (on file), phone on file, bank account on file, agreement
ENTITIES = [
    ("F01", "Golden Gate Tea House LLC", "Kevin Lau", "kevin@goldengateteahouse.com", "+1-415-555-0118", "****2207", "FA-2019"),
    ("F02", "Patel Brews Inc", "Raj Patel", "raj@patelbrews.com", "+1-408-555-0142", "****7310", "FA-2025"),
    ("F03", "Oakland Leaf & Pearl LLC", "Henry Tam", "henry@oaklandleafpearl.com", "+1-510-555-0163", "****5528", "FA-2019"),
    ("F04", "Telegraph Tea Co. LLC", "Sofia Ramirez", "sofia@telegraphtea.com", "+1-510-555-0177", "****0934", "FA-2022"),
    ("F05", "Chen Tea LLC", "Maya Chen", "maya@chentea.com", "+1-415-555-0101", "****4421", "FA-2025"),
    ("F06", "Peninsula Boba Partners LLC", "Grace Liu", "grace@peninsulaboba.com", "+1-650-555-0129", "****6612", "FA-2022"),
    ("F07", "Valley Pearl Holdings Inc", "Tommy Nguyen", "tommy@valleypearlholdings.com", "+1-916-555-0155", "****3385", "FA-2019"),
    ("F08", "Fremont Tea Works LLC", "Anita Desai", "anita@fremontteaworks.com", "+1-510-555-0190", "****8046", "FA-2025"),
    ("F09", "SoCal Sip Group LLC", "Jason Park", "jason@socalsip.com", "+1-213-555-0137", "****1793", "FA-2022"),
    ("F10", "Arroyo Tea LLC", "Carmen Ortiz", "carmen@arroyotea.com", "+1-626-555-0148", "****4459", "FA-2022"),
    ("F11", "Spectrum Boba Inc", "Linda Huang", "linda@spectrumboba.com", "+1-949-555-0112", "****9071", "FA-2025"),
    ("F12", "Emerald City Tea LLC", "Ben Okafor", "ben@emeraldcitytea.com", "+1-206-555-0166", "****2618", "FA-2019"),
    ("F13", "Lakeside Tea Co. LLC", "Emily Johansson", "emily@lakesideteaco.com", "+1-206-555-0184", "****2290", "FA-2025"),
    ("F14", "FiDi Pearl LLC", "Marcus Bell", "marcus@fidipearl.com", "+1-415-555-0173", "****5864", "FA-2022"),
]

# code, name, city, entity, consultant, weekly gross ($, before seasonality), card share, supply waste, day pattern
STORES = [
    ("S01", "Pearl Lane #1 Union Square", "San Francisco", "F01", "Lee", 13_600, 0.78, 1.03, "street"),
    ("S03", "Pearl Lane #3 Oakland Chinatown", "Oakland", "F03", "Lee", 9_800, 0.66, 1.04, "street"),
    ("S05", "Pearl Lane #5 Telegraph Ave", "Berkeley", "F04", "Lee", 11_200, 0.72, 1.02, "street"),
    ("S07", "Pearl Lane #7 Fremont Hub", "Fremont", "F08", "Lee", 10_100, 0.71, 1.05, "mall"),
    ("S09", "Pearl Lane #9 Serramonte", "Daly City", "F06", "Lee", 8_600, 0.70, 1.01, "mall"),
    ("S11", "Pearl Lane #11 Capitol Hill", "Seattle", "F12", "Priya", 9_500, 0.76, 1.03, "street"),
    ("S12", "Pearl Lane #12 Downtown San Mateo", "San Mateo", "F06", "Lee", 10_700, 0.73, 1.02, "street"),
    ("S14", "Pearl Lane #14 Mission", "San Francisco", "F05", "Lee", 11_800, 0.69, 1.03, "street"),
    ("S16", "Pearl Lane #16 Midtown", "Sacramento", "F07", "Priya", 8_400, 0.70, 1.04, "street"),
    ("S18", "Pearl Lane #18 Elk Grove", "Elk Grove", "F07", "Priya", 7_600, 0.68, 1.02, "mall"),
    ("S20", "Pearl Lane #20 Davis Downtown", "Davis", "F07", "Priya", 7_700, 0.69, 1.02, "street"),
    ("S22", "Pearl Lane #22 Koreatown", "Los Angeles", "F09", "Priya", 11_900, 0.67, 1.03, "street"),
    ("S23", "Pearl Lane #23 Financial District", "San Francisco", "F14", "Lee", 12_600, 0.93, 1.01, "office"),
    ("S26", "Pearl Lane #26 Old Pasadena", "Pasadena", "F10", "Priya", 10_400, 0.74, 1.03, "street"),
    ("S27", "Pearl Lane #27 Irvine Spectrum", "Irvine", "F11", "Priya", 12_100, 0.77, 1.02, "mall"),
    ("S29", "Pearl Lane #29 Cupertino Village", "Cupertino", "F02", "Lee", 12_900, 0.75, 1.03, "mall"),
    ("S31", "Pearl Lane #31 Santana Row", "San Jose", "F02", "Lee", 13_600, 0.76, 1.02, "street"),
    ("S34", "Pearl Lane #34 Castro Street", "Mountain View", "F02", "Lee", 12_600, 0.74, 1.03, "street"),
    ("S36", "Pearl Lane #36 South Lake Union", "Seattle", "F13", "Priya", 11_300, 0.925, 1.01, "office"),
    ("S38", "Pearl Lane #38 Sawtelle", "Los Angeles", "F09", "Priya", 9_200, 0.70, 1.04, "street"),
]

# Share of a week's sales by weekday (Mon..Sun). Office-district stores live on weekday lunch.
DAY_PATTERNS = {
    "street": [0.11, 0.11, 0.125, 0.13, 0.16, 0.195, 0.17],
    "mall": [0.10, 0.10, 0.115, 0.125, 0.165, 0.215, 0.18],
    "office": [0.175, 0.185, 0.19, 0.185, 0.165, 0.06, 0.04],
}

LOW_CASH_STORES = {"S23", "S36"}  # office districts, legitimately almost cashless

# Who sends each store's weekly report when it is not the owner on file.
REPORT_SENDERS = {
    "S29": ("Neha Kapoor", "ops@patelbrews.com"),
    "S31": ("Neha Kapoor", "ops@patelbrews.com"),
    "S34": ("Neha Kapoor", "ops@patelbrews.com"),
    "S22": ("Erin Cho", "erin@socalsip.com"),
    "S38": ("Erin Cho", "erin@socalsip.com"),
    "S12": ("Diego Flores", "sanmateo@peninsulaboba.com"),
}

# How each sender writes; used for the LLM-written notes and for format habits.
VOICES = {
    "kevin@goldengateteahouse.com": "Kevin Lau, 60s, old-school owner of the Union Square store since 2019; formal, short, signs 'K. Lau'",
    "raj@patelbrews.com": "Raj Patel, owner of three South Bay stores; polite, businesslike, uses bullet points",
    "ops@patelbrews.com": "Neha Kapoor, operations manager at Patel Brews; efficient, sends reports for three stores",
    "henry@oaklandleafpearl.com": "Henry Tam, owner of the Oakland Chinatown store; terse, often types numbers into the email body",
    "sofia@telegraphtea.com": "Sofia Ramirez, owner of the Berkeley store near campus; friendly, uses exclamation marks",
    "maya@chentea.com": "Maya Chen, owner of the Mission store in San Francisco; warm, busy, occasional typos, signs 'Maya'",
    "grace@peninsulaboba.com": "Grace Liu, owner of two Peninsula stores; organized, precise",
    "sanmateo@peninsulaboba.com": "Diego Flores, store manager at San Mateo; casual",
    "tommy@valleypearlholdings.com": "Tommy Nguyen, owner of three Sacramento-area stores; casual, brief, signs 'Tommy'",
    "anita@fremontteaworks.com": "Anita Desai, owner of the Fremont store; direct, a little defensive about money",
    "jason@socalsip.com": "Jason Park, owner of two LA stores; delegates paperwork to his bookkeeper",
    "erin@socalsip.com": "Erin Cho, bookkeeper at SoCal Sip Group; careful, formal",
    "carmen@arroyotea.com": "Carmen Ortiz, owner of the Old Pasadena store; apologetic, warm",
    "linda@spectrumboba.com": "Linda Huang, owner of the Irvine store; extremely organized, pays everything early",
    "ben@emeraldcitytea.com": "Ben Okafor, owner of the Capitol Hill store in Seattle; terse, sometimes types numbers in the body",
    "emily@lakesideteaco.com": "Emily Johansson, owner of the South Lake Union store in Seattle; direct, no-nonsense",
    "marcus@fidipearl.com": "Marcus Bell, owner of the Financial District store; corporate tone",
}

# Staff identities bound in the database (principal names) and how they write.
STAFF = {
    "Dana": {"role": "controller", "full": "Dana Whitfield", "voice": "Dana Whitfield, controller: precise and brisk, cites the agreement or the ledger, never more than one sentence"},
    "Sam": {"role": "controller", "full": "Sam Okoye", "voice": "Sam Okoye, assistant controller and second approver: cautious, plain, one sentence"},
    "Lee": {"role": "consultant", "full": "Lee Nakamura", "voice": "Lee Nakamura, field consultant for the Bay Area stores: friendly, knows the owners personally, practical"},
    "Priya": {"role": "consultant", "full": "Priya Raman", "voice": "Priya Raman, field consultant for Sacramento, LA and Seattle: methodical, data-driven"},
    "feeder": {"role": "world", "full": "world feeder"},
    "evolver": {"role": "evolver", "full": "evolution engine"},
}


def entity(code: str) -> dict:
    for c, name, owner, email, phone, bank, fa in ENTITIES:
        if c == code:
            return {"code": c, "name": name, "owner": owner, "email": email, "phone": phone, "bank": bank, "contract": fa}
    raise KeyError(code)


def store(code: str) -> dict:
    for c, name, city, ent, consultant, base, card, waste, pattern in STORES:
        if c == code:
            return {"code": c, "name": name, "city": city, "entity": ent, "consultant": consultant, "base": base, "card_share": card, "waste": waste, "pattern": pattern}
    raise KeyError(code)


def stores_of(entity_code: str) -> list[str]:
    return [s[0] for s in STORES if s[3] == entity_code]


def terms_for_store(code: str) -> dict:
    return CONTRACTS[entity(store(code)["entity"])["contract"]]


def terms_for_entity(code: str) -> dict:
    return CONTRACTS[entity(code)["contract"]]


def report_sender(store_code: str) -> tuple[str, str]:
    """(name, address) of whoever usually emails the store's weekly report."""
    if store_code in REPORT_SENDERS:
        return REPORT_SENDERS[store_code]
    e = entity(store(store_code)["entity"])
    return e["owner"], e["email"]


def company_file() -> dict:
    """Exactly the shape the load_company reducer reads."""
    return {
        "company": COMPANY,
        "contracts": [{"version": v, "terms": t} for v, t in CONTRACTS.items()],
        "entities": [
            {"code": c, "name": name, "kind": "franchisee", "contactEmail": email, "phoneOnFile": phone, "bankAccount": bank, "status": "active", "country": "US", "owner": owner}
            for c, name, owner, email, phone, bank, fa in ENTITIES
        ],
        "stores": [
            {"code": c, "entityCode": ent, "name": name, "city": city, "contractVersion": entity(ent)["contract"], "consultant": consultant}
            for c, name, city, ent, consultant, *_ in STORES
        ],
    }
