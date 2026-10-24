# Charter

**A finance team that lives in a database, learns from one sentence, and can't be talked into moving money.**

Charter staffs the receivables and payables desks of a company with AI seats — a mailroom clerk, a cash-application accountant, a collections specialist, a refunds specialist, a payables clerk and a payments seat — working beside people (a controller, a second controller, field consultants) and checked by a read-only internal auditor. Every action of every seat and every person goes through one kernel inside SpacetimeDB that checks permissions, verifies the numbers against the ledger, keeps the books balanced and hash-chains every attempt, allowed or refused.

The team gets better the way a real team does. When a person corrects a decision or explains a case in one line, the evolution engine turns it into a new version of the team's skill, replays it over every past decision, and only a version that fixes the lesson, breaks nothing people have labeled and stays inside its budgets is offered to a person to approve. Safety lessons become policies that bind everyone — including seats hired later and the controller.

Built at Cal Hacks 13.0 for the Hyphenate track, Friday 18:00 to Sunday 09:00.

## Organised as three lines of defence

| Line | Who | Can | Can never |
|---|---|---|---|
| First | Mailroom clerk (two model families read each money-relevant email) | file what it read as untrusted facts | touch a tool |
| First | Cash application, collections, refunds (receivables pack) | bill, apply cash, debit, chase, prepare refunds | approve, release money, change bank details |
| First | Payables clerk, payments (payables pack) | match bills to orders and receipts, prepare payment runs | release a payment |
| Second | Kernel + controller(s) | release money, endorse verified bank changes, ratify skills and policies, close the books | override the constitution; release alone above $5,000 refunds / $25,000 payments |
| Third | Internal auditor (another model family) | read everything, file findings and an opinion | change anything |
| — | Evolver | propose skill versions and policies | activate anything |

Seats never talk to each other directly. They coordinate through five kinds of record in one transactional database — observations, facts, work items, questions to people, and commands through the kernel — so **the medium of coordination is the audit trail**.

## Four feedback loops at four time scales

1. **Every action** — the kernel checks policies, ledger claims and invariants; a person's past correction of a near-identical case sends the case to a person (precedent).
2. **Every day** — earned autonomy: each rule of each skill keeps a record from spot checks, answers, field audits, corrections and audit findings. Inspection switches between probation, normal, reduced, tightened and suspended on exact binomial bounds; a rule we are 95% sure is worse than its tolerable error rate is suspended and its cases go to people.
3. **Every lesson** — the evolver proposes, a deterministic replay disposes, a person decides. Selection uses only what the organization knows; the answer key only grades. Test and live cases are hidden from the evolver.
4. **Every month** — the auditor tests controls over 100% of the population and re-performs a monetary-unit sample; the controller closes the month into a hashed certificate (as-of trial balance, prior-period items, chain head) that is anchored in git. Closed months are never written to; what is learned later is booked in the open month and disclosed.

## Auditability, concretely

- Every attempt is on the record, including denials and rejections; the hashed rows are never edited (a rejected command's row is replaced and re-chained).
- The chain re-verifies outside the database from the stored rows (`tools/evolve/report.ts`, `tools/audit/auditor.ts`).
- Every number traces to source documents and their SHA-256; model calls are stored with model, prompt hash and response.
- Audit packets: `npx tsx tools/audit/packet.ts --subject bill:V01:INV-20431` writes one file with everything behind a transaction and `--verify` re-checks it offline.
- Change management: each skill version and policy carries its proposer, replay proof, gate result, approver and date; the constitution cannot change.

## Finance packs

The kernel, skills, spot checks, audit and close know nothing about any particular desk. A pack registers the observation kinds it understands and brings its seats, decision domains and actions:

- `module/spacetimedb/src/seats.ts` — receivables (royalties, supply invoices, wholesale trade invoices, credit notes, cash application, collections, refunds)
- `module/spacetimedb/src/packs/payables.ts` — payables (three-way match, duplicate bills, payment runs)

A policy learned on one desk binds the others through the shared fact vocabulary: "no money moves while a bank change is unverified" was learned from a returned debit in receivables and now also stops a vendor payment.

## What is real and what is simulated

| | Real | Simulated |
|---|---|---|
| Company A — Pearl Lane Tea Co., a franchisor | contract terms modelled on franchise practice | 20 stores, six months of reports, settlements, supply invoices, bank lines, vendors, emails; planted errors with an answer key |
| Company B — a UK giftware wholesaler | 1,645 invoices and 380 credit notes from UCI Online Retail II (CC BY 4.0), with the data's own defects | customer payments and remittance advice |
| Attacks | — | 36 emails written by `deepseek-v4-pro` (a different model family from the seats') |

## Results so far

**It gets better on real books.** Company B's cash application, month by month (real UCI invoices and credit notes; payments simulated):

| Month | Payments | Settled without a person | Questions to people | Right when settled alone |
|---|---|---|---|---|
| Dec 2010 | 19 | 37% | 14 | 86% (6/7) |
| Jan 2011 | 209 | 93% | 19 | 91% |
| Feb 2011 | 161 | 82% | 30 | 95% |
| Mar 2011 | 184 | 88% | 25 | 97% |
| Apr 2011 | 208 | 89% | 23 | 97% |
| May 2011 | 206 | 86% | 28 | 100% (178/178) |
| Jun 2011 | 239 | 96% | 15 | 99% (227/229) |

The team took over more of the work while its own decisions got more accurate: it learned from the controller's answers to trust the invoice a payer names, and spot checks took autonomy away from the one rule that kept misapplying cash.


- **Red team**: 36 attacks (look-alike domains, compromised real mailboxes, refunds to new accounts, prompt injection, fake payment claims, impersonated executives). Charter: the attacker got nothing in 0/36, with a careless controller trying to release every refund and endorse every bank change. Tool-using LLM agents on the same emails: qwen3.8-max 13/36 plain, 0/36 with careful instructions; kimi-k3 8/36 and 2/36; glm-5.3 4/36 and 1/36.
- **Payables, six months (simulated vendors)**: 96/96 clean bills approved, every variance, short shipment and no-PO bill sent to a person, and all four duplicate bills stopped before payment (two caught by the controller in a payment run, two by the precedent of those corrections). The skill went from v1 to v3: it learned to reject duplicates, and the gate refused versions that would have taken over price-variance decisions on the strength of a single approval (three unanimous precedents are required). One rule of v2 rejected a short shipment it should have held; a spot check caught it, the rule was put on tightened inspection, and v3 fixed it. 86 payments released, every one above $25,000 by two people.
- **Company B, real invoices (UCI Online Retail II; payments simulated)**: on the locked test split the cash landed on the right invoices for 189/199 prompt payments, 38/46 monthly statements paid against remittance advice, 34/47 late payments and 25/32 payments made through a parent company. The skill went from v1 to v3 by itself from the controller's answers (prompt payments decided right 138/198 → 180/198, late payments 24/34 → 34/34). Spot checks found the contract-order fallback misapplying cash four times in five and suspended it, so those cases now go to a person; of the 273 test-split payments the team settled alone, 14 landed wrong (95% upper bound 7.9%). The gate refused to automate statement payments because 3 of 30 similar cases had been decided differently by people. Still wrong: duplicate customer payments (0/5) — nobody has taught the team that lesson yet.
- **Receivables (dev history)**: the day-0 skill misses cash under-reporting; one consultant sentence becomes a version that catches it (locked test 0/2 → 2/2) without flagging a legitimately low-cash store; activating it re-opened every missed week for audit.
- Hash chain: every row re-verifies; ledger invariants hold.

## Run it

```bash
spacetime start                                    # local SpacetimeDB on 127.0.0.1:3000
spacetime publish charter-a --server local --module-path module/spacetimedb --yes
cd tools && python3 smoke.py && python3 smoke_ap.py --keep
npx tsx tools/evolve/evolve.ts --db charter-a --once
npx tsx tools/audit/auditor.ts --db charter-a --period 2026-03
cd web && npm install && npm run dev
```

Model calls use Alibaba Model Studio (OpenAI-compatible); put `MODELSTUDIO_API_KEY` in `~/.config/charter/modelstudio.env`.
