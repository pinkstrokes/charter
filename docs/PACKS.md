# Finance packs

Charter's core — the kernel, skills and their evolution, earned autonomy, internal audit, the close, packets — knows nothing about receivables or payables. A finance function plugs in as a pack that declares seven things. Two packs run in the database (receivables, payables) and a bank-reconciliation skill is measured on a real bank's data (BenchRec: 83.9% of lines matched alone at 99.90% precision); the rest of this page shows how other desks map onto the same primitives.

## What a pack declares

1. **Observation kinds** it understands, registered in `INGESTORS` (`world.ts`): what arrives, from which source, trusted or not.
2. **Records** it keeps (tables or facts): bills, payments, invoices, receipts…
3. **Decision domains** (`core/dsl.ts`): the features a seat computes, the outcomes it may choose, which outcomes hand the case to a person, a safety rule a skill may never break, and the tolerable error rate that earned autonomy is measured against.
4. **Seats**: cycles that take work items, compute features, call `decide`, and act through `exec`.
5. **Actions** and who may take them (`core/policy.ts`), plus any constitutional rules the desk needs (who releases money, two-person limits).
6. **What people's answers mean**: how each question kind becomes a label for reliability and for the evolver.
7. **Accounts and invariants**: the journal lines each action posts and the control totals they must tie to.

Everything else comes for free: policies bind the new desk the moment it exists, spot checks start on probation, the auditor tests its controls, the close certifies it, packets explain it.

## Built

| Pack | Seats | Domains | Constitution added |
|---|---|---|---|
| Receivables (`seats.ts`) | mailroom, cash application, collections, refunds | underreport, allocation, pre_chase, routing_change | refunds released by someone else; two people above $5,000; only to verified accounts |
| Payables (`packs/payables.ts`) | payables clerk, payments | bill_match | payments released by someone else; two people above $25,000; only to verified accounts |
| Bank reconciliation (`tools/benchrec/benchrec.ts`, measured offline) | reconciliation clerk | bank_match: exact candidates on the value date, contested lines, booking gap, allocation sums, near dates → match / ask | none moves; a rule acts alone only when 95% sure of under 0.2% error |

## How other desks map

| Desk | Observations | Decision domain (features → outcomes) | Money / limits | Typical lesson the team would learn |
|---|---|---|---|---|
| Expense audit | receipts (OCR, untrusted), card feed (trusted), travel policy | approve an expense line: policy limit, receipt present, duplicate score, merchant category → approve / return to employee / escalate | reimbursement released by someone else | "hotel taxes are not an overage" |
| Revenue recognition (ASC 606) | contracts, invoices, delivery events | recognise a performance obligation: delivered, variable consideration, constraint → recognise / defer / ask | journal entries only; reversals need a person | "usage-based royalties are recognised when the sales occur" (already used for franchise royalties) |
| Payroll exceptions | timesheets, HR changes (untrusted when by email) | flag a pay line: hours vs schedule, rate change, new bank account → pay / hold / ask | bank changes verified by callback, as for vendors | the same rule as payables: no pay to an unverified account |
| Intercompany | entity ledgers, transfer agreements | net intercompany balances: mismatch, FX difference, timing → settle / ask | settlements released by someone else | "FX differences under 0.1% are booked to the rounding account" |
| Treasury cash positioning | bank balances, forecast payments, debit runs | sweep or fund: forecast gap, buffer, cut-off time → sweep / hold / ask | transfers two-person above a limit | "never sweep below the Friday payment run" |

Each row is a pack, not a new system: the same kernel would hold its limits, the same evolver would learn its lessons from its people, and the same auditor would test it.
