# Charter

**An AI finance team that lives in one database, catches its own mistakes, pushes back when it is told something wrong, and cannot be talked into moving money.**

Charter fills the receivables and payables seats of a finance team — mailroom clerk, cash-application accountant, collections specialist, refunds specialist, payables clerk, payments — beside a controller, checked by a read-only internal auditor. Built at Cal Hacks 13.0 for the Hyphenate track.

## The moment

A UK wholesaler's real invoices. On 28 December 2010 a customer's parent company pays £2,149.30 and names invoice 536784, which is £21.60 short of what it owes. In its first week the team's cash-application skill matches the money to three *other* invoices whose total comes close (£2,127.16). Five days later the same payer sends £30.00 naming invoice 536792 — which the books say is already paid.

Charter does not file the £30 as a duplicate. It works out that 536792 was paid by its own guess on the 28th, while the payer had named a different invoice, and asks the controller with that evidence. One answer: the earlier application is reversed, both payments land where the customer said, and the rule that guessed loses its autonomy until it proves itself again. Every step is a hash-chained row a person can open.

![The team finds that an earlier application of its own was a guess and asks the controller](docs/img/b1_question.png)

Two other moments the judges can trigger themselves:

- **It pushes back.** Tell it, on a spot check, that it should have chased a franchisee on day 5 of a 10-day grace period. It keeps its decision, says the agreement forbids that, does not count your verdict against the rule, and does not learn from it.
- **It cannot be talked into moving money.** Email new bank details for Formosa Leaf the day before its $92,400 payment run. Two models read it, the change is held, the controller is asked to call the number already on file, and on Friday the release is refused — for the controller too — by a policy nobody wrote: the team learned it in April from a debit that bounced during an unverified bank change, and extended it from debits to refunds and vendor payments.

![Friday's release is refused for both controllers by a policy learned in April](docs/img/a2_refused.png)

## Would you hire it?

**Limited access.** Every action of every seat and every person goes through one kernel inside SpacetimeDB: role permissions, a constitution nobody can edit (whoever prepares a payment cannot release it; two people above $25,000; money moves only to bank accounts from a trusted source; no notices or debits against a counterparty in bankruptcy), ledger-checked claims and balanced books. Seats never call each other; they coordinate through records the kernel writes. The model reads email; it never holds a tool.

**A clean record of its work.** Every attempt, allowed or refused, is hash-chained and re-verifies outside the database. Each decision stores the features it saw, the skill version and rule that decided, and the question it raised. An audit packet for any transaction re-verifies offline. Each month closes into a hashed certificate anchored in git; a closed month is never written to, and what is learned later is booked in the open month and disclosed.

**Knowing when to ask.** Each rule of each skill earns its autonomy from spot checks, answers, field audits and audit findings — probation, normal, reduced, tightened, suspended — on exact binomial bounds. A rule acts alone only while we are 95% sure its error rate is under what that decision tolerates. A person's correction sends near-identical cases to a person at once.

## Is it real enough?

| | Real | Simulated | How we know |
|---|---|---|---|
| Company B, a UK giftware wholesaler | 1,645 invoices and 380 credit notes from UCI Online Retail II (CC BY 4.0), with their own defects | customer payments and remittance advice, with the long tail of cash application: payments from abroad short by bank charges or off by the exchange rate, money sent "on account" without a reference, one payment for two invoices, duplicates | answer key written before the run; locked test split the evolver never sees |
| BenchRec, a Tier-1 institution's cash account | 68,975 reconciled bank lines to learn from and 32,048 to reconcile, with the benchmark's own solution (CC BY 4.0) | — | the benchmark's scoring: precision must clear 99.8% before match rate counts |
| Company A, Pearl Lane Tea Co., a franchisor | franchise terms modelled on practice | six months: 20 stores, sales reports, card settlements, supply orders, debits, vendors, bills, emails, people who make mistakes; planted errors with an answer key | answer key, locked test split, a live split for June |
| Attacks | — | 36 emails written by deepseek-v4-pro, another model family | same emails against tool-using LLM agents |
| People | — | a script decides what each controller and consultant answers from the simulated truth, including pre-registered wrong answers (about 5%); a model writes the one-line reason in their voice | the answer key knows which answers were slips; in the live demo the judges play the people |

## Results

**Real bank reconciliation (BenchRec, eval split scored once).** The bank desk starts with one rule — match a line when exactly one ledger allocation has that amount on that day — and learns the rest from the institution's own reconciliation history, month by month, through the same evolver and replay gate as every desk. It found that a line whose ledger entry was booked on a different day is wrong about one time in 25, and stopped matching those alone. Each rule then earns its autonomy the way every rule in Charter does, on the train months after the last version took over, which no version was fitted to: it is suspended, and its lines go to a person, once its record there proves at 95% that it is wrong more often than 0.2%. All four desks are scored once on the locked eval split.

| | Matched alone | Wrong | Precision | Clears the 99.8% floor |
|---|---|---|---|---|
| Charter, learned (4 versions) | 81.5% (26,119 of 32,048) | 12 | 99.95% | yes |
| Charter, day 0 (one rule) | 84.4% | 48 | 99.82% | yes, by 0.02 points |
| Six rules written by hand (three suspended) | 83.9% | 31 | 99.89% | yes |
| Matcher shipped with the dataset (written with ChatGPT) | 64.9% | 114 | 99.45% | no |

By the benchmark's own ranking (clear the floor, then match the most) day 0 places higher: on average it is precise enough, while letting through a pattern that is wrong one time in 25. Charter's standard is stricter by design: every rule earns its autonomy on its own record.

**Real invoices (company B).** Real customers pay messily, so the simulated payments carry the long tail of cash application: from abroad, short by bank charges or off by the exchange rate; money sent "on account" without a reference; one payment for two invoices; duplicates. On the locked test split, which the evolver never saw, the cash landed on the invoices the payer meant for **312 of 317** payments, and the team was wrong on **4 of the 300** it settled without a person (95% upper bound 3.0%). The controller's answers became four new versions of the cash-application skill, each replayed over every past decision before it went live. On the same test payments:

| Version | What it learned | Live from | Settled alone | Wrong when alone | Right |
|---|---|---|---|---|---|
| Day one | — | 1 Dec 2010 | 300 | 18 | 282 of 313 |
| v2 | several sets fit and the reference names one for exactly its amount → that one | 2 Jan | 305 | 17 | 288 |
| v3 | no set fits, but the reference names one open invoice → that invoice, even short | 16 Jan | 305 | 8 | 297 |
| v4 | no set fits and the reference names an invoice already paid → a duplicate: ask | 3 Apr | 301 | 4 | 301 |
| v5 | several sets fit and the remittance agrees with one → that one | 8 May | 306 | 4 | 306 |

| Month | Settled without a person | Questions to people | Right when settled alone |
|---|---|---|---|
| Dec 2010 | 72% | 5 | 92% (12/13) |
| Jan 2011 | 94% | 31 | 95.7% (178/186) |
| Feb 2011 | 99% | 5 | 99.4% (156/157) |
| Mar 2011 | 99% | 4 | 98.9% (187/189) |
| Apr 2011 | 98% | 10 | 98.5% (203/206) |
| May 2011 | 97% | 10 | 99.5% (200/201) |
| Jun 2011 | 99% | 4 | 99.6% (244/245) |

Eleven times, nine of them in January, a later payment exposed an earlier application as a guess and the team undid it. The pennies bank charges leave are not chased: every Monday the cash seat lists them and the controller writes them off (112 invoices, £1,188.21 over seven months).

![Company B month by month: settled alone 72% to 99%, questions to people while it learned in January, then four to ten a month](docs/img/b6_proof.png)

![The cash-application skill's lineage: the controller's answer, the proposal, the replay gate, and the decisions it changed](docs/img/b7_lineage.png)

**A franchisor's six months (company A).** Twenty stores, six vendors, and people who make mistakes on purpose. On the locked test split, from the day-0 skills to the versions people approved:

| Desk | What changed | Day 0 → now | Learned from |
|---|---|---|---|
| Under-reported sales | weeks flagged for audit | 0/4 → 3/4, with 14/14 legitimately low-cash and 5/5 bulk-buying weeks still accepted and 87 of 88 clean weeks (one goes to a consultant) | two field audits and a consultant's answer in March |
| Collections | payments announced as a check in the mail, not chased | 0/3 → 3/3 | the controller's answer on one franchisee's check in March |
| Payables | duplicate bills rejected by the clerk's own skill | 0/2 → 2/2 | the controller's answer on a third duplicate in April, after the internal auditor had caught the first two |
| All desks | no money moves while a bank change is unverified | P-1, P-2, P-3 | one debit returned in April |

Audits recovered $1,120.40 of $1,864.04 in hidden royalties; $89,242 of duplicate bills was stopped and none paid. The internal auditor qualified February and March (two duplicate liabilities of $34,800 and $10,750, and a royalty billed $59.03 too high) and gave clean opinions for January, April and May; all five months are closed into certificates anchored in git. Seven times a person's spot-check verdict contradicted a rule with a clean record; asked to look again, people called four of them slips and stood by three, and a later run of slips no longer teaches a desk to ask more. Settled without a person on the test and live splits: under-reporting 6 wrong of 111 (95% upper bound 10%), collections 3 of 30, payables 2 of 23, cash 1 of 9. What it still misses: store 31's milder under-reporting in June (0 of 3 live weeks: its cash share ran 11–13 points under its own history, while every week people taught it ran 20 or more under), and short payments, which A's franchisees pay without an invoice number in the reference (none of 3 applied where meant).

**Skills travel; the target decides.** Company B's cash-application skill was offered to company A as a program, whole and rule by rule at every place in A's own program. A's gate replayed every variant over A's history and refused them all before a person saw them: B's whole program would get 4 of A's labeled cases wrong, and none of its rules handles a case A's people taught. A's franchisees do not write invoice numbers in their payment references, so B's best lesson, "a payment naming one open invoice goes there even when short", never fires at A.

**Attacks.** 36 attack emails: Charter gave the attacker nothing (0/36), with the people played as an attacker would hope — a careless controller tries to release every refund and endorse every bank change. Tool-using agents on the same emails: qwen3.8-max 13/36, kimi-k3 8/36, glm-5.3 4/36 with plain prompts; 0, 2 and 1 with careful prompts.

**Books.** Trial balance, receivables and payables controls, unapplied cash and cash-to-bank tie after every run; every row of every activity chain re-verifies.

## What is new here

1. **Later evidence overturns earlier guesses.** When a payment names an invoice the team paid by inference, it asks, undoes its own application, re-applies both, and the rule that guessed loses autonomy.
2. **It checks people's verdicts too.** A verdict that would break the counterparty's agreement is declined with the reason, never counted against the seat and never learned. A spot-check verdict that contradicts a rule with a clean record is put back to the person — a slip, or does it stand? — before it counts or teaches, so a 5% human error rate does not erode rules that were right.
3. **Policies are learned from losses and bind every desk.** An exhaustive search replays every past money movement with the facts the kernel saw at the time; a rule is offered only if it stops a loss no rule in force stops and holds back little that was legitimate, and it extends to every other way money leaves.
4. **A lesson is a pull request with a replay proof.** A person's one-line correction becomes a candidate version of the team's skill, written by a model and judged by a deterministic replay over every past decision: it must handle what people taught, never break a safety rule, stay inside a change budget, and pass three statistical tests that use the same arithmetic as earned autonomy — a new mistake on a labeled case fails it unless the record proves such mistakes rarer than the domain tolerates (impossible on a few dozen cases, possible on 69,000 bank lines); taking work from people needs three agreeing precedents; handing work back to people needs the evidence that would suspend a rule, so a few slips cannot teach it to ask. Candidates are ranked by value: one mistake stopped is worth 1/tolerable questions, because at that error rate acting alone and asking cost the same. New rules no known case supports are dropped, failing candidates are repaired, and new thresholds are searched over the values the cases actually take and centred between the nearest known cases.
5. **Sources disagree; the team weighs them.** Who paid is voted by the account on file, the invoice the payer named and the payer's name; masked account numbers collide, so one source loses to two and a tie goes to a person with every reading. Two model families read every email that could move money; a disagreement waits for a person.
6. **Skills travel, data does not — and the target decides.** A skill learned at one company is offered to another as a program; the target replays it, whole and rule by rule at every place in its own program, over its own history, and adopts only what handles something its own people taught and passes its own gate.
7. **The same action under another name is the same decision.** Every decision records what each outcome would have done with that case — for cash, which invoices each would pay. Checks, the gate and the grading compare where the money goes, not what the outcome is called. Without it, "apply to the invoice the payer named" and "apply oldest first" looked like contradictory answers for a customer with one open invoice, and no candidate could learn bank charges.

![One consultant's answer becomes a new version, replayed over every past decision, that catches weeks the old one accepted](docs/img/a5_skill.png)

## How it works

| Line | Who | Can | Can never |
|---|---|---|---|
| First | Mailroom (two model families read each money-relevant email) | file what it read as untrusted facts | touch a tool |
| First | Cash application, collections, refunds (receivables pack) | bill, apply cash, debit, chase, prepare refunds | approve, release money, change bank details |
| First | Payables clerk, payments (payables pack) | match bills to orders and receipts, prepare payment runs | release a payment |
| Second | Kernel + controllers | release money, endorse verified bank changes, ratify skills and policies, close the books | override the constitution |
| Third | Internal auditor (another model family) | read everything, file findings and an opinion | change anything |
| — | Evolver | propose skill versions and policies | activate anything |

Four feedback loops at four time scales: every action (kernel, precedent), every day (earned autonomy), every lesson (evolver → replay gate → a person), every month (internal audit → close certificate → git anchor).

Finance desks plug in as packs that declare observation kinds, records, decision domains, seats, actions and invariants: receivables (`module/spacetimedb/src/seats.ts`), payables (`module/spacetimedb/src/packs/payables.ts`), and a bank-reconciliation skill measured on BenchRec (`tools/benchrec/benchrec.ts`). See `docs/PACKS.md`.

## Run it

```bash
spacetime start                                    # local SpacetimeDB on 127.0.0.1:3000
spacetime publish charter-a --server local --module-path module/spacetimedb --yes
python3 tools/world/run.py --reset                 # company A, six months (~30 min)
STDB_DB=charter-b python3 tools/world_b/run_b.py   # company B on UCI Online Retail II
npx tsx tools/evolve/report.ts --db charter-a      # proof numbers from the database and the answer key
npx tsx tools/benchrec/benchrec.ts --data <folder with the BenchRec CSVs>
npx tsx tools/evolve/gate_check.ts                 # the gate's regression checks, offline
cd tools && python3 smoke.py && python3 smoke_ap.py
cd web && npm install && npm run dev
```

Model calls use Alibaba Model Studio (OpenAI-compatible); put `MODELSTUDIO_API_KEY` in `~/.config/charter/modelstudio.env`. The evolver's model calls are cached in `data/evolve_llm_cache.json`, so evolution replays offline.
