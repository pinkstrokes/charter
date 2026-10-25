# tools/certify: competence maps and certificates

A replay tells you how a skill did on the payments it has seen. These tools ask the other question: what will it do in the situations it has not seen, and is anything it can do forbidden?

```
npm install --prefix tools/certify
npm run all --prefix tools/certify          # every step below except the two exports, in order
npx tsx tools/certify/check_encoding.ts      # the Z3 encoding decides exactly what dsl.ts decides
python3 tools/certify/export_decisions.py    # read-only: every B, C and C-from-scratch cash decision, with labels
npx tsx tools/certify/certify.ts             # the cash skill's competence map and a certificate per version
npx tsx tools/certify/timeline.ts B          # autonomy earned by situation, replayed on B's timeline (and C)
npx tsx tools/certify/team.ts                # the team invariant across collections, cash application and the kernel
npx tsx tools/certify/site.ts                # the compact payload the public page shows
```

Outputs are in `out/`: `allocation-map.md` and `.json`, `timeline-b.md`, `timeline-c.md`, `team.md`, and `certify-site.json`.

## What each step proves, and how

- **The encoding is the interpreter.** `encode.ts` turns a skill (a first-match rule list in Charter's DSL) into a Z3 formula, case by case after `dsl.ts`'s evaluator, including its corners: a non-boolean in a boolean position is false, `div` by zero is 0. `check_encoding.ts` runs 3,540 decisions through both (B and C test payments, plus random feature maps for all 19 skill versions of every domain): 0 disagreements.
- **The map is complete.** A situation is an assignment of true or false to the skill's vocabulary, which is every condition any of its versions ever tested. Inside one situation every version's decision is fixed. `map.ts` enumerates every satisfiable situation under the consistency axioms of `axioms.ts`, read off `processReceipt` (for example, an exact match leaves nothing over, and a reference whose invoices are all paid names none that is open). Each axiom is checked against the record before it is used. The cash skill has 40 situations, and all 3,625 recorded B and C decisions fall into one of them.
- **The map is real.** `worlds.ts` realizes each situation as a concrete payment. It starts from B-15061's real ledger and payment of 28 Dec 2010 and finds the fewest edits that land in the situation: a different amount, a reference, a remittance, an invoice already paid, a second invoice of the same amount. Every world is read by `seat.ts`, which is `processReceipt`'s reading on top of `matching.ts` itself. 40 of 40 are realized.
- **Certificates.** For each version change, `certify.ts` lists the situations it decides differently, with what the record says and how many people's labels each situation has. B's current version settles alone in 16 situations that none of B's 1,225 payments ever fell into, and in 20 that no person ever labeled. B's and C's current versions disagree in 3 situations neither company has seen. One of them, S5, is a reference and a remittance that name different invoices.
- **Autonomy by situation.** `timeline.ts` replays every decision in order with the run's own versions and dates, and asks what happens if the seat acts alone in a situation only once a person has confirmed what it does there and nobody has said otherwise. Situations are told apart only by conditions of versions live on the day, so there is no hindsight. B goes from 15 mistakes made alone to 8, with 21 more questions in six months; with three confirmations it goes to 4, with 43 more questions. C goes from 18 to 11. The first question in each situation can be asked before any payment waits for it.
- **Team invariants.** `team.ts` checks a property no single seat owns: never chase a counterparty with its own money. It covers the collections skill, the kernel (`policy.ts` `evaluate` over all 512 combinations of its 9 facts) and the grace guard (`labels.ts`), for every situation. There are four properties: no notice and no late fee while the counterparty's unapplied cash covers what is past due, no late fee in bankruptcy, and no hold on a chase their cash does not cover. Each way of closing the gap is also played out on company A's real ledger.
  - Before 4b81c48 the invariant failed. Patel Brews pays its three June invoices, $9,611.20, with the reference "JUNE SUPPLIES". Cash application rightly asks a person where it goes, and the same day collections sends a notice and charges $300 of late fees. On the runs' own books it had happened: B sent 72 of its 1,024 notices while the customer's own unapplied cash covered what was past due (7 customers), C 34 of 1,086 (8 customers), C from scratch 45 of 1,110. A sent 0 of 5.
  - A policy against notices while cash is unapplied (P-4) stops the notice but not the fees. A second policy against fees (P-5) cannot fire, because a fee reached the kernel through `createInvoice` without facts. With the facts, the two are proved for notices and fees but hold legitimate chases. On 9 June Emerald City Tea had $25 unapplied against $2,767.81 past due on day 22, and a person confirmed the chase was right. Teaching collections to hold instead leaves fees in bankruptcy.
  - The constitution now (4b81c48):
    - C16 forbids the notice, and C17 the fee, while the counterparty's unapplied cash covers everything past due.
    - C18 forbids fees in bankruptcy.
    - Fees follow only a sent notice, and a fee request carries the kernel's facts.

    It is the only way of closing the gap that is proved on all four properties for both versions of the collections skill. Re-run with it over the same months, no such notice went out: B's kernel refused 439 attempts to send one, to 7 customers; C's 170, to 8; C from scratch, 254.

## What it does not do

It certifies decisions, not learning: the versions and their dates are the run's. People's answers in the replay come from the answer key, as in the runs, and a label counts from the day of the decision it labels. The remaining mistakes under autonomy by situation are in situations where the same evidence points both ways. The skill cannot tell those payments apart with what it reads, so they need a new feature, not more questions.
