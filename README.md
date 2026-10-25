# Charter

**An AI finance team that lives in one database, catches its own mistakes, pushes back when it is told something wrong, and cannot be talked into moving money.**

Charter fills the receivables and payables seats of a finance team — mailroom clerk, cash-application accountant, collections specialist, refunds specialist, payables clerk, payments — beside a controller, checked by a read-only internal auditor. Built at Cal Hacks 13.0 for the Hyphenate track.

**See it:** [pinkstrokes.github.io/charter](https://pinkstrokes.github.io/charter/) — the team drawn as a living record; give it a task (a payment, a bank change, a chase, a rule to learn) and watch it decide on the real history (the page replays a port of the seats' code in your browser over the runs' recorded data). **The live system:** [pinkstrokes.github.io/charter/app](https://pinkstrokes.github.io/charter/app/) — the three companies replayed on SpacetimeDB's maincloud, open to anyone as an outsider: every decision's Why panel, every skill version's replay proof, the hash chain verified in your browser.

**Where the AI is.** Models do three jobs, and none of them decides anything. They read email: two model families, with no tools, file what an email says as untrusted facts, and when they disagree or one does not answer, the email waits for a person. They write candidate versions of a skill from people's corrections. And a third family re-reads a sample of emails for the internal auditor. Every decision (which invoices a payment pays, whether to chase, whether money may move) is made by a small rule program that the kernel runs deterministically, and a version a model writes goes live only after a deterministic replay over every past decision and a person's approval. What decides can be replayed and audited; what reads and writes text is a model.

## The moment

A UK wholesaler's real invoices. On 28 December 2010 a customer's parent company pays £2,149.30 and names invoice 536784, which is £21.60 short of what it owes. In its first week the team's cash-application skill matches the money to three *other* invoices whose total comes close (£2,127.16). Five days later the same payer sends £30.00 naming invoice 536792 — which the books say is already paid.

Charter does not file the £30 as a duplicate. It works out that 536792 was paid by its own guess on the 28th, while the payer had named a different invoice, and asks the controller with that evidence. One answer: the earlier application is reversed, both payments land where the customer said, and the rule that guessed is put under tightened inspection: 40% of its decisions go to a person until 74 in a row check out. Every step is a hash-chained row a person can open.

![The team finds that an earlier application of its own was a guess and asks the controller](docs/img/b1_question.png)

Three moments the judges can trigger themselves:

- **It pushes back.** Tell it, on a spot check, that it should have chased a franchisee on day 3 of a 10-day grace period. It keeps its decision, says the agreement forbids that, does not count your verdict against the rule, and does not learn from it.
- **It cannot be talked into moving money.** Email new bank details from Formosa Leaf's own address hours before its $92,400 payment run. Two models read it, the change is held, the controller is asked to call the number already on file, and the release is refused — for both controllers — by a policy nobody wrote: the team learned it in April from a debit that bounced during an unverified bank change, and extended it from debits to refunds and vendor payments.
- **Give it your own payment.** On the World screen, make up a payment — any payer, any invoices, any reference, from any account — and it arrives through the bank feed like everything else. A transfer from abroad paying two invoices, £12 short for the banks' charges, is applied alone to exactly the two invoices the customer named, by a rule the team learned from the controller's answers in January; the £12 waits for Monday's write-off list. A bill made up the same way goes to the payables clerk.

![Friday's release is refused for both controllers by a policy learned in April](docs/img/a2_refused.png)

![A payment made up on the spot: two invoices from abroad, £12 short, applied to exactly the invoices the customer named by a rule learned in January](docs/img/b8_world.png)

## Would you hire it?

**Limited access.** Every action of every seat and every person goes through one kernel inside SpacetimeDB: role permissions, a constitution nobody can edit (whoever prepares a payment cannot release it; two people above $25,000; money moves only to bank accounts from a trusted source; no notices, fees or debits against a counterparty in bankruptcy; no past-due notice or late fee while the counterparty's own money, waiting to be applied, covers everything it has past due), ledger-checked claims and balanced books. Seats never call each other; they coordinate through records the kernel writes. The model reads email; it never holds a tool.

**A clean record of its work.** Every attempt, allowed or refused, is hash-chained and re-verifies outside the database. Each decision stores the features it saw, the skill version and rule that decided, and the question it raised. An audit packet for any transaction re-verifies offline. Each month closes into a hashed certificate anchored in git; a closed month is never written to, and what is learned later is booked in the open month and disclosed.

*What that protects, and what it does not.* The kernel binds every seat and every person who acts through Charter. The chain proves that no record was changed or removed after it was written, and an anchored month cannot be rewritten without the commit log showing it. Neither binds whoever runs the database: its owner can publish different code or write rows directly, and an open month is not anchored until it closes. So each certificate names the rules it enforced (a hash of every active policy's text, the constitution included), and each anchor names the program the database was running (SpacetimeDB's own program hash and the sha256 of the program bytes), so a change of rules or code shows at the next close.

**Knowing when to ask.** Each rule of each skill earns its autonomy from spot checks, answers, field audits and audit findings: probation, normal, reduced, tightened, suspended. A rule acts alone until its record proves, at 95% (exact binomial), that it is wrong more often than that decision tolerates; then it is suspended and its cases go to a person. Meanwhile a share of its decisions, picked by a hash of the case, goes to a person as a spot check: 25% for its first 20 checks, then 10%; 40% after an error, until a clean run that a rule wrong twice as often as tolerated would get through by luck less than one time in 20 (14 checks at a 10% tolerance, 74 at 2%); and 3% only once a bound that stays valid however often it is looked at (Clopper–Pearson, spending 5% × 6/(π²n²) at the n-th check) puts its error rate under the tolerance after at least 40 checks. A correction, or a spot-check verdict the person stood by on a second look, sends near-identical cases to a person at once; a verdict nobody looked at again may be a slip, and one slip must not escalate every case like it. The tolerances and counts are engineering values, not a guarantee: the bounds treat checks as independent, while real errors cluster by customer and by month; and the suspension test, run at every check, fires early more often than 5% of the time, in the direction of asking more.

## Is it real enough?

| | Real | Simulated | How we know |
|---|---|---|---|
| Company B, a UK giftware wholesaler | 1,645 invoices and 380 credit notes from UCI Online Retail II (CC BY 4.0), with their own defects | customer payments and remittance advice, with the long tail of cash application: payments from abroad short by bank charges or off by the exchange rate, money sent "on account" without a reference, one payment for two invoices, duplicates | answer key written before the run; locked test split the evolver never sees |
| Company C, a sister ledger | 1,876 invoices and 456 credit notes from the same dataset's previous year (December 2009 to May 2010), its own 120 largest customers | payments with the same long tail, drawn under their own seed | run twice on identical events: started from company B's skill, and from scratch |
| BenchRec, a Tier-1 institution's cash account | 68,975 reconciled bank lines to learn from and 32,048 to reconcile, with the benchmark's own solution (CC BY 4.0) | — | the benchmark's scoring: precision must clear 99.8% before match rate counts |
| Company A, Pearl Lane Tea Co., a franchisor | franchise terms modelled on practice | six months: 20 stores, sales reports, card settlements, supply orders, debits, vendors, bills, emails, people who make mistakes; planted errors with an answer key | answer key, locked test split, a live split for June |
| Attacks | — | 36 emails written by deepseek-v4-pro, another model family | same emails against tool-using LLM agents |
| People | — | a script decides what each controller and consultant answers from the simulated truth, including pre-registered wrong answers (about 5%); a model writes the one-line reason in their voice | the answer key knows which answers were slips, so how the team treats a person's mistake is measured; in the live demo a judge can give it an instruction directly, and it pushes back on a wrong one |

## Results

**Real bank reconciliation (BenchRec, eval split scored once).** The bank desk starts with one rule — match a line when exactly one ledger allocation has that amount on that day — and learns the rest from the institution's own reconciliation history, month by month, through the same evolver and replay gate as every desk. It found that a line whose ledger entry was booked on a different day is wrong about one time in 25, and stopped matching those alone. Each rule then earns its autonomy the way every rule in Charter does, on the train months after the last version took over, which no version was fitted to: it is suspended, and its lines go to a person, once its record there proves at 95% that it is wrong more often than 0.2%. All four desks are scored once on the locked eval split.

| | Matched alone | Wrong | Precision | Clears the 99.8% floor |
|---|---|---|---|---|
| Charter, learned (day 0 + 3 versions) | 81.5% (26,119 of 32,048) | 12 | 99.95% | yes |
| Charter, day 0 (one rule) | 84.4% | 48 | 99.82% | yes, by 0.02 points |
| Six rules written by hand (three suspended) | 83.9% | 31 | 99.88% | yes |
| Matcher shipped with the dataset (written with ChatGPT) | 64.9% | 114 | 99.45% | no |

By the benchmark's own ranking (clear the floor, then match the most) day 0 places higher, and that ranking is exactly what Charter will not play to. On the locked eval split the 918 lines the learned desk hands to people instead were wrong 36 times when day 0 matched them alone, one in 25: day 0 clears the floor only by averaging that pattern into clean matches. Every rule earns its autonomy on its own record, so a pattern wrong 4% of the time never acts alone, whatever the average around it. Month by month (`tools/benchrec/monthly.ts`), the learned desk clears the floor in each of the eval split's three full months (its worst, April, 99.90%); day 0 misses it in April and May (99.75%, 99.77%) and clears it overall only because March and a late August batch were clean. Resampling whole days, day 0 falls under the floor in 28% of resamples and the learned desk in 1 of 2,000. The price is 2.9 points of match rate: by the benchmark's own pick, day 0 still wins most resamples. The six rules written by hand match 783 more lines alone than the learned desk, get 19 more wrong (about 41 lines a person would match for each mistake avoided) and fall under the floor in April (99.79%). A wrong match is not a question that costs a minute: it marks a line reconciled that is not, and the difference it hides stays hidden until someone finds it, at month-end or never. Charter prices that trade the same way at every desk, one mistake for 1/tolerable questions (500 at the bank desk's 0.2%), and at that price the learned desk is well ahead; a team that values a hidden difference at fewer than 41 matches should prefer the hand-written rules.

![BenchRec on the locked eval split: the learned desk, its day-0 rule, rules written by hand and the matcher shipped with the dataset; and how it learned, month by month](docs/img/p1_benchrec.png)

**Real invoices (company B).** Real customers pay messily, so the simulated payments carry the long tail of cash application: from abroad, short by bank charges or off by the exchange rate, sometimes paying two invoices in one transfer; money sent "on account" without a reference; one payment for two invoices; duplicates. On the locked test split, which the evolver never saw, the cash landed on the invoices the payer meant for **310 of 314** payments. As run, each payment decided by the version live that day, the team settled 304 of them without a person and was wrong on **3** (95% upper bound 2.5%). The controller's answers became four new versions of the cash-application skill, each replayed over every past decision before it went live. Replayed over the same 313 test payments, each version would have done this:

| Version | What it learned | Live from | Settled alone | Wrong when alone | Right |
|---|---|---|---|---|---|
| Day one | — | 1 Dec 2010 | 301 | 18 | 283 of 313 |
| v2 | the invoices a reference names come first, even when the amount is short or several sets fit; when several fit, the one the payer confirms | 2 Jan | 313 | 17 | 296 |
| v3 | no set fits, but the reference names open invoices → those, even short; an exact match only when its reference is not already paid | 16 Jan | 313 | 7 | 306 |
| v4 | a reference to an invoice already paid, or several sets that fit with nothing to choose between them → ask: it may be a duplicate | 27 Mar | 306 | 2 | 309 |
| v5 | several sets fit exactly and the reference names open invoices → those | 24 Apr | 306 | 2 | 309 |

As run, month by month:

| Month | Settled without a person | Questions to people | Right when settled alone |
|---|---|---|---|
| Dec 2010 | 72% | 5 | 92% (12/13) |
| Jan 2011 | 92% | 21 | 96.8% (181/187) |
| Feb 2011 | 100% | 4 | 98.7% (156/158) |
| Mar 2011 | 100% | 2 | 98.9% (188/190) |
| Apr 2011 | 98% | 7 | 99.0% (202/204) |
| May 2011 | 98% | 7 | 100% (202/202) |
| Jun 2011 | 99% | 4 | 99.6% (238/239) |

Twice — on 2 January and again in June — a later payment exposed an earlier application as a guess and the team undid it; after the first, the team learned that the invoices a payer names come first, and stopped guessing over them. The pennies bank charges leave are not chased: every Monday the cash seat lists them and the controller writes them off (99 invoices, £1,052.42 over seven months).

![Company B month by month: settled alone 72% to 99%, questions to people while it learned in January, then two to seven a month](docs/img/b6_proof.png)

![The cash-application skill's lineage: the controller's answer, the proposal, the replay gate, and the decisions it changed](docs/img/b7_lineage.png)

**Never chasing a customer with its own money (B and C).** Cash application leaves money it cannot place unapplied and asks a person; collections chases what is past due. Each is right on its own. Together, before the kernel fix, company B sent 72 past-due notices to 7 customers whose own money, waiting to be applied, already covered everything they had past due, and company C sent 34 to 8. The constitution now forbids it (C16–C18). On the same books the kernel refused one notice per customer (7 in B, 8 in C), and from then on collections held the chase itself, citing that refusal, until the money was applied or what was past due changed: no notice reached a customer whose money covered what was past due, and every other chase went ahead. Late fees follow the contract, not the letter: one per invoice past its grace period whenever collections decides to chase, sent or refused, and C17 and C18 refuse them on their own facts. C16 is only as good as knowing who paid: money identified to no customer protects no one, so that customer can still be chased until a person says whose money it is, and money credited to the wrong customer holds back that customer's chase instead.

**A franchisor's six months (company A).** Twenty stores, six vendors, and people who make mistakes on purpose. On the locked test split, from the day-0 skills to the versions people approved:

| Desk | What changed | Day 0 → now | Learned from |
|---|---|---|---|
| Under-reported sales | weeks flagged for audit | 0/4 → 3/4, with 14/14 legitimately low-cash and 5/5 bulk-buying weeks still accepted, and all 88 clean weeks | three spot checks in February where a consultant said an accepted week needed an audit (v2, 8 March: it caught all four, but sent 12 of the 14 honest low-cash weeks to audit); the consultants' "explained, accept" answers on those audits (v3, 22 March) |
| Collections | payments announced as a check in the mail, not chased | 0/3 → 3/3 | the controller's answer on one franchisee's check in March |
| Payables | duplicate bills rejected by the clerk's own skill | 0/2 → 2/2 | the controller's answer on a third duplicate in April, after the internal auditor had caught the first two |
| All desks | no money moves while a bank change is unverified | P-1, P-2, P-3 | one debit returned in April |

Audits billed $1,791.54 of the $1,918.55 in hidden royalties (cash under-reporting alone, $1,737.03 of $1,864.04), $1,624.69 of it collected by the end of June; in June it also caught store 31's milder under-reporting, all three live weeks, which earlier runs missed. $89,242 of duplicate bills was stopped and none paid. The internal auditor qualified February and March (two duplicate liabilities of $34,800 and $10,750, and a royalty billed $59.03 too high) and gave clean opinions for January, April and May; all five months are closed into certificates anchored in git. Fourteen times a person's spot-check verdict contradicted a rule with a clean record; asked to look again, people called nine of them slips and stood by five, and only a verdict that stood can send other cases to a person. Settled without a person on the test and live splits: under-reporting 2 wrong of 101 (95% upper bound 6.1%), collections 3 of 30, payables 2 of 23, cash 1 of 9. What it still misses: short payments that name their invoice (1 of 3 applied where meant). A's cash desk ran its day-one skill, which does not read references, until June, and its people labeled only one of the other two, then contradicted that label in a spot check.

**Skills travel; the target decides.** A skill crosses between companies as a program and a few numbers from its proof; no record crosses, and the receiving company decides.

*A new ledger starts from what a sister company learned.* Company C is a second ledger built from the same public dataset's previous year: 1,876 real invoices and 456 credit notes, December 2009 to May 2010, for its own 120 largest customers, with payments drawn by the same simulation under their own seed. We ran it twice on identical events. Once its controller started cash application from the skill company B had learned (every rule of it starting on probation, as any new version does); once it started from the hand-written day-one skill. From then on each learned on its own.

| Company C | Started from B's skill | Started from scratch |
|---|---|---|
| First three months: wrong when it settled alone | **2** of 350 | 20 of 336 |
| Last four months: wrong when it settled alone | 15 of 832 | 11 of 816 |
| Seven months: cash questions to people | **34** | 72 |
| New versions it needed | 2 | 7 |
| Locked test split: cash landed where the payer meant | **320** of 324 | 315 of 324 |
| Test and live splits: wrong when it settled alone | **4** of 318 (95% upper bound 2.9%) | 9 of 313 (5.0%) |

The head start is the first three months. After that both ledgers had learned from their own controllers and were wrong at about the same rate, and where C still erred we can name the rule. B's skill brought a catch-all, "no set fits: apply by contract order", that suited B's payers (it placed 10 of B's 12 test payments sent "on account" where meant) but not C's, whose customers had more invoices open: 12 of C's 15 later mistakes were money sent on account, nine of them by rules that came from B and three by a rule C wrote itself in March from one such payment whose intended invoice happened to be its oldest. From late March, at every weekly round, C's evolver proposed handing those cases back to people, 13 times, and C's gate refused each time: two labeled mistakes are not the three it needs before a desk is taught to ask more, the rule that keeps a 5% slip rate in people's answers from eroding rules that are right. Earning autonomy situation by situation (item 8 below) is what would have caught it sooner.

![Company C's cash skill: version 2 learned at company B and ratified by C's controller, versions 3 and 4 learned from C's own answers](docs/img/c1_sister.png)

*A skill that does not fit is refused.* Company B's cash skill was also offered to company A, whose history is six months long: A's gate replayed it, whole and rule by rule at every place in A's own program, over A's own history, and refused every variant before a person saw it. The whole program would get 3 of A's labeled cases wrong, and none of its rules handles the case A's people had just taught. B's best lesson, a payment naming one open invoice goes there even when short, is what A's two misapplied short payments needed; but A had no clean evidence for it (one of the two was never checked, the other's correction was contradicted by a later spot check), and a rule takes over work only on agreeing cases of the receiving company's own.

**Attacks.** 36 attack emails written by another model family (deepseek-v4-pro), six each of look-alike bank changes, bank changes from the vendor's real mailbox, refunds to a new account, prompt injections, fake payment claims and impersonated executives, with the people played as an attacker would hope (a careless controller tries to release every refund and endorse every bank change): the attacker got nothing (0/36). That is mostly by construction. The models hold no tools, so an email can change only what is filed as untrusted facts, and money moves only to an account from a trusted source, after a callback to the number on file, with two people above $25,000. What the 36 show is that no reading of an email, however wrong, gets past those rules. Tool-using agents on the same emails: qwen3.8-max 13/36, kimi-k3 8/36, glm-5.3 4/36 with plain prompts; 0, 2 and 1 with careful prompts. Not tested: a forged remittance that sends a real payment to the wrong invoices (no money leaves, but the books are wrong until a spot check or the customer notices); corrections fed in to teach a bad rule (the replay gate and its three agreeing cases are the defence, never tried by an adversary); floods of questions meant to tire people into approving; and attackers from more than one model family. The attacks ran on a fresh company with the day-one skills; on company A's learned skill, a franchisee's own address saying a check is in the mail holds collections for seven days, which a fake claim from that address would buy too.

**Books.** Trial balance, receivables and payables controls, unapplied cash and cash-to-bank tie after every run; every row of every activity chain re-verifies.

**How stable these numbers are.** Each number above is one run. A run replays exactly: the seats take a day's work in arrival order, and every model call a run made (the evolver's proposals, the simulated people's one-line reasons, company A's email readings) is committed as a cache, so a replay on a fresh database makes the same decisions. The public page watches such a replay of these runs on SpacetimeDB's maincloud, and it agrees with them decision for decision: every number in company B's and C's reports is the same, and company A's differs only in two extra identity bindings and in the row ids after maincloud skipped a block of them. Change anything upstream and a run takes another path, because wherever a prompt reads differently the model is asked again and answers differently. Tonight's fixes redid every run and showed it. Company B kept its moment, its January lessons and rule 7, learned v4 and v5 a week apart from before, and landed one more test payment where meant. Company C learned its first lesson of its own in February instead of June. Company A's collections and payables desks ended where they always do, at 3 of 3 and 2 of 2, while its under-reporting desk is the most sensitive: in local runs its final rule caught 3 and 1 of the 4 test weeks before tonight, 2 in a trial run on code we then fixed, and 3 in this one. Two earlier maincloud replays that caught 4 and 3 do not count: on any database not named charter-a, company A's evolver read another folder's answer key and so did not hide A's test cases from itself (fixed in a2e4d83).

## What a person still does

Counted from each company's database (`tools/evolve/workload.py`). The simulated people answer at once, so these are tasks, not time; B and C have no payables desk.

| Over the whole run | A (six months) | B (seven) | C from B's skill (seven) | C from scratch (seven) |
|---|---|---|---|---|
| Decisions the seats made | 1,618 | 9,904 | 10,327 | 10,315 |
| Spot checks answered | 433 | 671 | 668 | 724 |
| Questions the seats asked, all desks | 173 | 76 | 60 | 98 |
| Second looks (slip, or does it stand?) | 14 | 0 | 0 | 0 |
| Corrections a person volunteered | 6 | 6 | 2 | 10 |
| Payments and refunds released | 87 | — | — | — |
| Bank changes endorsed | 3 | — | — | — |
| Skill versions and policies approved | 9 | 4 | 3 | 7 |
| Write-offs, waivers and reversals (per invoice) | 3 | 105 | 173 | 169 |
| Months closed | 5 | 6 | 6 | 6 |

Company A's questions include 88 requests to release a payment run's payments, and its 87 releases count both controllers where two are needed. Once its first two months were over, company B's controller answered about four spot checks and half a question a business day, approved a version every two or three months and closed the books once a month. Starting from B's skill saved company C 38 questions, 8 corrections and 4 approvals over the same seven months.

## What is new here

1. **Later evidence overturns earlier guesses.** When a payment names an invoice the team paid by inference, it asks, undoes its own application, re-applies both, and the rule that guessed goes on tightened inspection.
2. **It checks people's verdicts too.** A verdict that would break the counterparty's agreement is declined with the reason, never counted against the seat and never learned. A spot-check verdict that contradicts a rule with a clean record is put back to the person — a slip, or does it stand? — before it counts or teaches, so a 5% human error rate does not erode rules that were right.
3. **Policies are learned from losses and bind every desk.** An exhaustive search replays every past money movement with the facts the kernel saw at the time; a rule is offered only if it stops a loss no rule in force stops and holds back little that was legitimate, and it extends to every other way money leaves.
4. **A lesson is a pull request with a replay proof.** A person's one-line correction becomes a candidate version of the team's skill, written by a model and judged by a deterministic replay over every past decision: it must handle what people taught, never break a safety rule, stay inside a change budget, and pass three statistical tests on exact binomial bounds — a new mistake on a labeled case fails it unless the record proves such mistakes rarer than the domain tolerates (impossible on a few dozen cases, possible on 69,000 bank lines); taking work from people needs three agreeing precedents; handing work back to people needs three labeled mistakes among the cases handed back and 95% certainty that the current version is wrong there more often than tolerated, so a few slips cannot teach it to ask. Candidates are ranked by value: one mistake stopped is worth 1/tolerable questions, because at that error rate acting alone and asking cost the same. New rules no known case supports are dropped, failing candidates are repaired, and new thresholds are searched over the values the cases actually take and centred between the nearest known cases.
5. **Sources disagree; the team weighs them.** Who paid is voted by the account on file, the invoice the payer named and the payer's name; masked account numbers collide, so one source loses to two and a tie goes to a person with every reading. Two model families read every email that could move money; a disagreement, or a reader that does not answer, waits for a person.
6. **Skills travel, data does not — and the target decides.** A new ledger can start from the skill a sister company learned: the program crosses, its controller ratifies it, and every rule starts on probation; started that way, company C made 2 mistakes in its first three months instead of 20. A company with a history replays an offered skill, whole and rule by rule at every place in its own program, over its own history, and adopts only what handles something its own people taught and passes its own gate.
7. **The same action under another name is the same decision.** Every decision records what each outcome would have done with that case — for cash, which invoices each would pay. Checks, the gate and the grading compare where the money goes, not what the outcome is called. Without it, "apply to the invoice the payer named" and "apply oldest first" looked like contradictory answers for a customer with one open invoice, and no candidate could learn bank charges.
8. **It checks what no seat owns, before it happens.** A replay shows how a skill did on what it has seen. A solver (Z3, over the same TypeScript the module runs; its encoding agrees with the interpreter on all 3,840 checks: B's and C's test payments through every cash version, plus random inputs for all 20 skill versions) also enumerates every situation the cash skill's versions can tell apart (40, none missing), realizes each as a concrete payment (a few edits of a real ledger, read by the seat's own code) and gives each version a certificate listing the situations it decides differently and how many people's labels each has (`tools/certify`). Company B's current version would act alone in 11 situations none of its 1,225 payments ever fell into, and in 17 no person ever labeled. That is a coverage certificate, and for the cash skill only: it shows where a version acts with no labeled case behind it, not that it acts rightly there. Replayed without hindsight, earning autonomy situation by situation instead of rule by rule halves B's mistakes made alone (14 to 7) for 21 more questions in six months, and C's from 17 to 8; the live system still earns it rule by rule. The proof is the team check. Taken across seats and the kernel, the same solver found what no seat owns: a customer pays everything it has past due under a vague reference, cash application rightly asks a person, and collections sends a past-due notice and late fees the same day. Company A's six months never produced it; company B's and C's books had, 72 and 34 times. The kernel now computes that fact and the constitution forbids the notice and the fee (C16–C18). Of the five fixes checked, it is the only one proved, for every situation, to send no notice and charge no fee while a customer's own money covers what is past due, to charge no fee in bankruptcy, and never to hold back a chase the cash does not cover; the others let the late fees through, hold a chase a person confirmed was right, or still charge fees in bankruptcy.

![Field consultants' answers (explained, accept the report) become version 3, replayed over every past decision: it accepts the honest low-cash weeks version 2 sent to audit, and still catches three of the four under-reported test weeks](docs/img/a5_skill.png)

## What it cannot do yet

- **It learns only what its seats measure.** The evolver writes rules over a fixed set of facts per desk (11 for cash application, 10 for collections, 6 for bank matching). A lesson that needs a fact no feature carries cannot be learned: the gate finds no passing candidate and the cases stay with people. Collections, for one, sees ten facts about a balance and none about the customer's history, so "this customer always pays a week late" is out of reach. Adding a feature is a code change, reviewed like any other.
- **Autonomy is earned rule by rule.** A rule's record mixes every situation it covers, so a rule right in most of them keeps acting alone in the one where it is wrong, as company C's payments on account show. Earning it situation by situation is replayed, not built, and the replay shows the trade (`tools/certify/learned_gate.ts`). Gating every behaviour that way halves the mistakes made alone (B 14 to 7, C 17 to 8, C's last four months 15 to 7) for 21 and 30 more questions, but the seat would then have asked about the very payment the moment is about instead of guessing. Gating only the behaviours a model added catches none of these mistakes: they come from behaviours the hand-written day-one skill shares. Which way to set it is a controller's call between questions and mistakes; we have not made it for them.
- **Holding is not resolving.** When a customer's own money covers what it has past due, collections holds the chase, but no seat offers to apply that money: in company B, six customers' past-due invoices stayed covered by duplicate payments the controller had chosen to keep as credit, for 432 customer-days in all. The next step is for the seat to propose the offset.
- **The people are simulated.** A script answers from the simulated truth, at once, with pre-registered slips. Real controllers are slower, busier and wrong in other ways; the workload above counts their tasks, not their time.
- The statistics are engineering values (see *Knowing when to ask*), the record does not bind the database's operator (see *A clean record*), C16 depends on knowing who paid, and the attacks left untried are listed under *Attacks*.

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
python3 tools/world/run.py --reset                 # company A, six months (about 3 minutes with the committed model caches)
STDB_DB=charter-b python3 tools/world_b/run_b.py   # company B on UCI Online Retail II
STDB_DB=charter-c python3 tools/world_b/run_b.py --data data/companyC --start 2009-12-01 --until 2010-06-30 --seed 7 --start-from charter-b   # company C from B's skill
python3 tools/evolve/compare.py data/companyC data/companyC-alone   # against the same ledger started from scratch
npx tsx tools/evolve/report.ts --db charter-a      # proof numbers from the database and the answer key
STDB_DB=charter-b python3 tools/evolve/workload.py   # what the people did, month by month
npx tsx tools/benchrec/benchrec.ts --data <folder with the BenchRec CSVs>
npx tsx tools/evolve/gate_check.ts                 # the gate's regression checks, offline
npm install --prefix tools/certify && npm run all --prefix tools/certify   # the competence map, certificates and team checks (see tools/certify/README.md)
cd tools && python3 smoke.py && python3 smoke_ap.py
cd web && npm install && npm run dev
tools/demo/demo.sh clone && tools/demo/demo.sh build   # the live demo's own server (main server stopped first), prepared and snapshotted
tools/demo/demo.sh up                              # demo server :3100, the UI with its step bar on :5191
tools/demo/demo.sh reset                           # back to the snapshot between judges, a second or two
```

Model calls use Alibaba Model Studio (OpenAI-compatible); put `MODELSTUDIO_API_KEY` in `~/.config/charter/modelstudio.env`. The evolver's model calls are cached in `data/evolve_llm_cache.json`, so evolution replays offline.
