# tools/certify: competence maps and certificates

A replay tells you how a skill did on the payments it has seen. These tools ask the other question: what will it do in the situations it has not seen, and is anything it can do forbidden?

```
npm install --prefix tools/certify
npx tsx tools/certify/check_encoding.ts      # the Z3 encoding decides exactly what dsl.ts decides
python3 tools/certify/export_decisions.py    # read-only: every B, C and C-from-scratch cash decision, with labels
npx tsx tools/certify/certify.ts             # the cash skill's competence map and a certificate per version
npx tsx tools/certify/timeline.ts B          # autonomy earned by situation, replayed on B's timeline (and C)
npx tsx tools/certify/team.ts                # the team invariant across collections, cash application and the kernel
npx tsx tools/certify/site.ts                # the compact payload the public page shows
```

Outputs are in `out/`: `allocation-map.md` and `.json`, `timeline-b.md`, `timeline-c.md`, `team.md`, and `certify-site.json`.

## What each step proves, and how

- **The encoding is the interpreter.** `encode.ts` turns a skill (a first-match rule list in Charter's DSL) into a Z3 formula, case by case after `dsl.ts`'s evaluator, including its corners: a non-boolean in a boolean position is false, `div` by zero is 0. `check_encoding.ts` runs 3,840 decisions through both (every B and C test payment, plus random feature maps for all 20 skill versions of every domain): 0 disagreements.
- **The map is complete.** A situation is an assignment of true or false to the skill's vocabulary, which is every condition any of its versions ever tested. Inside one situation every version's decision is fixed. `map.ts` enumerates every satisfiable situation under the consistency axioms of `axioms.ts`, read off `processReceipt` (for example, an exact match leaves nothing over, and a reference whose invoices are all paid names none that is open). Each axiom is checked against the record before it is used. The cash skill has 40 situations, and all 3,625 recorded B and C decisions fall into one of them.
- **The map is real.** `worlds.ts` realizes each situation as a concrete payment. It starts from B-15061's real ledger and payment of 28 Dec 2010 and finds the fewest edits that land in the situation: a different amount, a reference, a remittance, an invoice already paid, a second invoice of the same amount. Every world is read by `seat.ts`, which is `processReceipt`'s reading on top of `matching.ts` itself. 40 of 40 are realized.
- **Certificates.** For each version change, `certify.ts` lists the situations it decides differently, with what the record says and how many people's labels each situation has. B's current version settles alone in 16 situations that none of B's 1,225 payments ever fell into, and in 20 that no person ever labeled. B's and C's current versions disagree in 5 situations neither company has seen. One of them, S5, is a reference and a remittance that name different invoices.
- **Autonomy by situation.** `timeline.ts` replays every decision in order with the run's own versions and dates, and asks what happens if the seat acts alone in a situation only once a person has confirmed what it does there and nobody has said otherwise. Situations are told apart only by conditions of versions live on the day, so there is no hindsight. B goes from 14 mistakes made alone to 7, with 21 more questions in six months; with three confirmations it goes to 3, with 43 more questions. C goes from 18 to 11. The first question in each situation can be asked before any payment waits for it.
- **Team invariants.** `team.ts` checks a property no single seat owns: never chase a counterparty with its own money. It covers the collections skill, the kernel (`policy.ts` `evaluate` over all 256 combinations of its facts) and the grace guard (`labels.ts`), for every situation, and plays each case out on company A's real ledger.
  - As it is, the invariant fails. Patel Brews pays its three June invoices, $9,611.20, with the reference "JUNE SUPPLIES". Cash application rightly asks a person where it goes, and the same day collections sends a notice and charges $300 of late fees.
  - A policy against notices while cash is unapplied stops the notice but not the fees. A second policy against fees cannot work: a fee reaches the kernel through `createInvoice`, which passes no facts.
  - Two fixes are proved: the policies with the fee request carrying the kernel's facts, or a collections rule to hold while unapplied cash covers the balance.

## What it does not do

It certifies decisions, not learning: the versions and their dates are the run's. People's answers in the replay come from the answer key, as in the runs, and a label counts from the day of the decision it labels. The remaining mistakes under autonomy by situation are in situations where the same evidence points both ways. The skill cannot tell those payments apart with what it reads, so they need a new feature, not more questions.
