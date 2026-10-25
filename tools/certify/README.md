# tools/certify: a coverage map and a team proof

A replay tells you how a skill did on the payments it has seen. These tools add two things. For the cash skill, a coverage map: where each version acts with no person's label behind it. It says where nobody has checked, not whether the skill is right there. Across seats and the kernel, a proof: collections cannot chase a customer with the customer's own money (the team check, C16 to C18).

```
npm install --prefix tools/certify
npm run all --prefix tools/certify          # every step below except the two exports, in order
npx tsx tools/certify/check_encoding.ts      # the Z3 encoding decides exactly what dsl.ts decides
python3 tools/certify/export_decisions.py    # read-only: every B, C and C-from-scratch cash decision, with labels
npx tsx tools/certify/certify.ts             # the cash skill's coverage map, and what each version change covers
npx tsx tools/certify/timeline.ts B          # a replay: autonomy earned by situation on B's recorded decisions (and C)
npx tsx tools/certify/team.ts                # the team invariant across collections, cash application and the kernel
npx tsx tools/certify/site.ts                # the compact payload the public page shows
```

Outputs are in `out/`: `allocation-map.md` and `.json`, `timeline-b.md`, `timeline-c.md`, `team.md`, and `certify-site.json`.

Everything the steps read is committed in `data/`, so `npm run all` reproduces `out/` from a fresh clone, with no database. The decisions come from `export_decisions.py`. `data/inputs.json` holds the rest: A's skill versions, B's and C's cash versions with their test payments, and the ledger of the moment the worlds are built from. It is cut from the public page's export; after new runs and a new export, refresh it with:

```
python3 -c "import json; d = json.load(open('$HOME/Developer/charter-showcase/data.json')); json.dump({'a': {'skills': d['a']['skills']}, 'b': {k: d['b'][k] for k in ('versions', 'cases')}, 'c': {k: d['c'][k] for k in ('versions', 'cases')}, 'sandbox': d['sandbox']}, open('tools/certify/data/inputs.json', 'w'), separators=(',', ':'))"
```

Z3 may pick a different smallest counterexample from run to run where several are equally small, so `team.md` can word one differently; whether each property is proved or refuted does not change.

## What each step proves, and how

- **The encoding is the interpreter.** `encode.ts` turns a skill (a first-match rule list in Charter's DSL) into a Z3 formula, case by case after `dsl.ts`'s evaluator, including its corners: a non-boolean in a boolean position is false, `div` by zero is 0. `check_encoding.ts` runs 3,840 checks through both (B and C test payments, plus random feature maps for all 20 skill versions of every domain): 0 disagreements.
- **The map covers every combination.** A situation is an assignment of true or false to the skill's vocabulary, which is every condition any of its versions ever tested. Inside one situation every version's decision is fixed. `map.ts` enumerates every satisfiable situation under the consistency axioms of `axioms.ts`, read off `processReceipt` (for example, an exact match leaves nothing over, and a reference whose invoices are all paid names none that is open). Each axiom is checked against the record before it is used. The cash skill has 40 situations, and all 3,627 recorded B and C decisions fall into one of them. Complete means complete over that vocabulary: a condition no version tests is invisible to the map, and the axioms are checked on the record, not proved.
- **The map is real.** `worlds.ts` realizes each situation as a concrete payment. It starts from B-15061's real ledger and payment of 28 Dec 2010 and finds the fewest edits that land in the situation: a different amount, a reference, a remittance, an invoice already paid, a second invoice of the same amount. Every world is read by `seat.ts`, which is `processReceipt`'s reading on top of `matching.ts` itself. 40 of 40 are realized.
- **Coverage per version.** For each version change, `certify.ts` lists the situations it decides differently, with what the record says and how many people's labels each situation has. This is coverage: where a version acts with nothing checked behind it, not whether it is right there. B's current version settles alone in 11 situations that none of B's 1,225 payments ever fell into, and in 17 that no person ever labeled. B's and C's current versions decide alike in every situation neither company has seen.
- **Autonomy by situation, in a replay.** The live system earns autonomy rule by rule. `timeline.ts` replays every recorded decision in order with the run's own versions and dates, and asks what happens if the seat acts alone in a situation only once a person has confirmed what it does there and nobody has said otherwise. Situations are told apart only by conditions of versions live on the day, so there is no hindsight. B goes from 14 mistakes made alone to 7, with 21 more questions in six months; with three confirmations it goes to 3, with 43 more questions. C goes from 17 to 8. The first question in each situation can be asked before any payment waits for it.
- **Team invariants.** `team.ts` checks a property no single seat owns: never chase a counterparty with its own money. It covers the collections skill, the kernel (`policy.ts` `evaluate` over all 512 combinations of its 9 facts) and the grace guard (`labels.ts`), for every situation. There are four properties: no notice and no late fee while the counterparty's unapplied cash covers what is past due, no late fee in bankruptcy, and no hold on a chase their cash does not cover. Each way of closing the gap is also played out on company A's real ledger.
  - Before 4b81c48 the invariant failed. Patel Brews pays everything it has past due, $9,778.05 (three June supply invoices and an audit invoice), with the reference "JUNE SUPPLIES". Cash application rightly asks a person where it goes, and the same day collections sends a notice and charges $400 of late fees. On the runs' own books it had happened: B sent 72 of its 1,024 notices while the customer's own unapplied cash covered what was past due (7 customers), C 34 of 1,086 (8 customers), C from scratch 45 of 1,110. A sent 0 of 5.
  - A policy against notices while cash is unapplied (P-4) stops the notice but not the fees. A second policy against fees (P-5) cannot fire, because a fee reached the kernel through `createInvoice` without facts. With the facts, the two are proved for notices and fees but hold legitimate chases. On 9 June Emerald City Tea had $25 unapplied against $2,767.81 past due on day 22, and a person confirmed the chase was right. Teaching collections to hold instead leaves fees in bankruptcy.
  - The constitution now (4b81c48):
    - C16 forbids the notice, and C17 the fee, while the counterparty's unapplied cash covers everything past due.
    - C18 forbids fees in bankruptcy.
    - A fee request carries the kernel's facts. Late fees follow the chase decision, as the contract does (794fb5e), so C17 and C18 alone stop them; the team check proves the constitution with fees ungated.

    It is the only way of closing the gap that is proved on all four properties for both versions of the collections skill. Re-run with it over the same months, no such notice went out. B's kernel refused one for each of 7 customers, and collections, which reads its own refusals, held 432 times instead of asking again; C's kernel refused 8 (239 holds), and C from scratch's 7 (248 holds).

## What it does not do

The map is a coverage certificate for the cash skill only: it says where a version acts with no person's label behind it, not that it acts rightly. The timeline is a replay of recorded decisions, not a live run. The one proof is the team check. None of it certifies learning: the versions and their dates are the run's. People's answers in the replay come from the answer key, as in the runs, and a label counts from the day of the decision it labels. The remaining mistakes under autonomy by situation are in situations where the same evidence points both ways. The skill cannot tell those payments apart with what it reads, so they need a new feature, not more questions.
