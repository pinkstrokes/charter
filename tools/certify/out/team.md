# Team invariant: never chase a counterparty with its own money

No seat may send a notice or charge a late fee while the counterparty's unapplied cash covers what is past due. Checked across the collections skill (each of company A's versions, as dsl.ts runs it), the kernel (policy.ts evaluate over all 256 combinations of its 8 facts) and the grace guard (labels.ts), for every possible situation; the axioms on the collections features hold on all 946 of company A's collections decisions.

## as it is
- pre_chase@1: **fails**: a notice goes out, smallest case the solver finds: days_past_due = 1, grace_days = 0, open_amount = 1, unapplied_amount = 1, announced_payment = 0, open_dispute = false; **fails**: a late fee goes out, smallest case the solver finds: days_past_due = 1, grace_days = 0, open_amount = 1, unapplied_amount = 1, announced_payment = 0, open_dispute = false.
- pre_chase@2: **fails**: a notice goes out, smallest case the solver finds: days_past_due = 1, grace_days = 0, open_amount = 1, unapplied_amount = 1, announced_payment = 0, open_dispute = false; **fails**: a late fee goes out, smallest case the solver finds: days_past_due = 1, grace_days = 0, open_amount = 1, unapplied_amount = 1, announced_payment = 0, open_dispute = false.

On company A's books, 2026-07-06: Patel Brews Inc (F02, FA-2025: 5 days of grace, $100.00 late fee per invoice). $9,611.20 arrives, reference "JUNE SUPPLIES": exactly the 3 invoices due 2026-06-29 (SUP-24496, SUP-24497, SUP-24498); 3 more invoices are open, not yet due. Cash application (allocation@2) **leaves it unapplied and asks a person**; collections (pre_chase@2) decides **chase** on day 7 past due. The notice is **sent**. 3 late fees, $300.00, are **charged**.

## P-4: no notice while cash is unapplied
- pre_chase@1: **proved**: no notice; **fails**: a late fee goes out, smallest case the solver finds: days_past_due = 1, grace_days = 0, open_amount = 1, unapplied_amount = 1, announced_payment = 0, open_dispute = false.
- pre_chase@2: **proved**: no notice; **fails**: a late fee goes out, smallest case the solver finds: days_past_due = 1, grace_days = 0, open_amount = 1, unapplied_amount = 1, announced_payment = 0, open_dispute = false.

On company A's books, 2026-07-06: Patel Brews Inc (F02, FA-2025: 5 days of grace, $100.00 late fee per invoice). $9,611.20 arrives, reference "JUNE SUPPLIES": exactly the 3 invoices due 2026-06-29 (SUP-24496, SUP-24497, SUP-24498); 3 more invoices are open, not yet due. Cash application (allocation@2) **leaves it unapplied and asks a person**; collections (pre_chase@2) decides **chase** on day 7 past due. The notice is refused (P-4: forbidden while payment_in_transit). 3 late fees, $300.00, are **charged**.

## P-4 and P-5: no notice, no fee while cash is unapplied
- pre_chase@1: **proved**: no notice; **fails**: a late fee goes out, smallest case the solver finds: days_past_due = 1, grace_days = 0, open_amount = 1, unapplied_amount = 1, announced_payment = 0, open_dispute = false.
- pre_chase@2: **proved**: no notice; **fails**: a late fee goes out, smallest case the solver finds: days_past_due = 1, grace_days = 0, open_amount = 1, unapplied_amount = 1, announced_payment = 0, open_dispute = false.

On company A's books, 2026-07-06: Patel Brews Inc (F02, FA-2025: 5 days of grace, $100.00 late fee per invoice). $9,611.20 arrives, reference "JUNE SUPPLIES": exactly the 3 invoices due 2026-06-29 (SUP-24496, SUP-24497, SUP-24498); 3 more invoices are open, not yet due. Cash application (allocation@2) **leaves it unapplied and asks a person**; collections (pre_chase@2) decides **chase** on day 7 past due. The notice is refused (P-4: forbidden while payment_in_transit). 3 late fees, $300.00, are **charged**.

## P-4 and P-5, and a late-fee request carries the kernel's facts
- pre_chase@1: **proved**: no notice; **proved**: no late fee.
- pre_chase@2: **proved**: no notice; **proved**: no late fee.

On company A's books, 2026-07-06: Patel Brews Inc (F02, FA-2025: 5 days of grace, $100.00 late fee per invoice). $9,611.20 arrives, reference "JUNE SUPPLIES": exactly the 3 invoices due 2026-06-29 (SUP-24496, SUP-24497, SUP-24498); 3 more invoices are open, not yet due. Cash application (allocation@2) **leaves it unapplied and asks a person**; collections (pre_chase@2) decides **chase** on day 7 past due. The notice is refused (P-4: forbidden while payment_in_transit). 3 late fees, $300.00, are refused.

## collections learns: hold while unapplied cash covers the balance
- pre_chase@1: **proved**: no notice; **proved**: no late fee.
- pre_chase@2: **proved**: no notice; **proved**: no late fee.

On company A's books, 2026-07-06: Patel Brews Inc (F02, FA-2025: 5 days of grace, $100.00 late fee per invoice). $9,611.20 arrives, reference "JUNE SUPPLIES": exactly the 3 invoices due 2026-06-29 (SUP-24496, SUP-24497, SUP-24498); 3 more invoices are open, not yet due. Cash application (allocation@2) **leaves it unapplied and asks a person**; collections (pre_chase@2) decides **hold** on day 7 past due. No late fee.
