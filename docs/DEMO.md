# Demo: three minutes, then the judges' own scenario

Three databases on the projector: `charter-b` (company B, real UCI invoices, finished), `charter-c` (company C, the sister ledger started from B's skill, finished) and `charter-a` (company A after six months, prepared for a payment run). UI at `http://127.0.0.1:5190/?db=charter-a` (switch with `?db=charter-b` or `?db=charter-c`). The evolver runs live: `npx tsx tools/evolve/evolve.ts --db charter-a --watch`.

## Before judging

The local database `charter-a` is ready: six months run, the Formosa Leaf attack rehearsed (its Friday 3 July release refused by P-3 for both controllers), the business date Friday 3 July, seats on autopilot. Pacific Cup's and Golden Tapioca's payments of 3 July are prepared and not yet released, so a judge can attack either and then try to release it.

```bash
spacetime start                                        # if it is not running
npx tsx tools/evolve/evolve.ts --db charter-a --watch  # the evolver, live: every answer teaches
cd web && npm run dev                                  # http://127.0.0.1:5190/?db=charter-a
```

From scratch instead (about 30 minutes): `spacetime publish charter-a --server local --module-path module/spacetimedb --delete-data=always --yes`, `python3 -u tools/world/run.py --reset`, `STDB_DB=charter-a python3 tools/demo_prep.py`, then send the bank-change email and run `STDB_DB=charter-a python3 tools/demo_prep.py --friday`.

## The three minutes

| Time | Show | Say |
|---|---|---|
| 0:00 | charter-b, Why panel of the "cash applied to the wrong invoice?" question | "Real invoices from a UK wholesaler. On 28 December a customer pays £2,149 and names invoice 536784. Our day-one skill matched it to three other invoices that came close. Five days later the customer pays £30 naming 536792 — which our books say is paid." |
| 0:20 | Why panel of the reversal, then Knowledge → Autonomy | "Charter doesn't call it a duplicate. It sees 536792 was paid by its own guess, asks the controller, reverses its earlier application, puts both payments where the customer said — and the rule that guessed is inspected four times as often until it proves itself again." |
| 0:45 | Proof → company B trend | "Real customers pay messily: bank charges, exchange differences, money on account. The day-one skill was wrong on 18 of the 300 test payments it settled alone; the controller's answers became four replay-gated versions, and the current one is wrong on 4 of 306. The pennies bank charges leave are listed every Monday and written off by the controller, never chased." |
| 0:55 | charter-c, Knowledge → Applying receipts → Versions | "Skills travel. A sister ledger, the same wholesaler's previous year, started from the skill this team learned; its controller ratified it and every rule started on probation. First three months: 3 mistakes instead of 22, 12 questions instead of 33." |
| 1:10 | charter-a, Security → send the bank-change email from Formosa Leaf's own address | "Now try to steal from us: new bank details hours before a $92,400 payment run." |
| 1:15 | Inbox: the callback question | "Two models read it; the change is held; the controller is asked to call the number we already had." |
| 1:25 | Payables → the Formosa Leaf run (or, after a judge's attack, Pacific Cup's) → release | "Friday. The controller presses release — refused, for the controller too, by P-3." |
| 1:40 | Knowledge → Policies → P-1, P-2, P-3 | "Nobody wrote P-3. A debit bounced in April during a bank change nobody verified; Charter replayed every past money movement, found the one rule that would have stopped it without holding back anything legitimate, and extended it to refunds and vendor payments." |
| 2:05 | Any hold decision inside a grace period → "This was wrong" → chase | "Tell it to chase a franchisee inside the grace period: it keeps its decision and says the agreement forbids it. That verdict is never counted against the rule and never learned." |
| 2:20 | Proof → BenchRec | "On a real bank's reconciliation history the bank desk started from one rule and learned month by month which matches are risky: 81.5% matched alone at 99.95% precision, a quarter of the day-0 rule's errors; the matcher shipped with the dataset misses the 99.8% floor." |
| 2:40 | Floor | "Limited access, a clean record, knows when to ask — and when to say no. That's what you need before you hire one." |

## Judges' turn

- **Correct anything.** Open any decision, "This was wrong", one line of why. The evolver (watch mode) proposes a new version with its replay proof within a minute — or explains why one answer is not enough evidence. Activate it as the controller; it starts on probation with spot checks.
- **Attack it.** Security → compose any email (Formosa Leaf was attacked in rehearsal; Golden Tapioca and Pacific Cup have bills in next Friday's run): look-alike domains, prompt injection in a remittance, a refund to a new account, an authority impersonation. Two readers, the sender check and the kernel decide; every refusal is on the record.
- **Ask why.** Every row opens a Why panel: who, what it asked for, the policies the kernel checked, the facts the check saw, the evidence it used, and the row's place in the hash chain.
- **Close a month.** Proof → Audit: the auditor's opinion with its 95% upper misstatement limit; `close_period` produces a hashed certificate; `python3 tools/anchor.py data/companyA` anchors it in git.

## Questions to expect

- **Does knowledge transfer?** Where the work is the same, yes: company C started from company B's skill and made 3 mistakes in its first three months instead of 22. Where it differs, the target refuses: B's skill offered to company A failed A's own gate, because A's franchisees do not write invoice numbers in their references.
- **What is real?** Company B's invoices and credit notes (UCI Online Retail II) and BenchRec's bank and ledger lines are real; company B's payments and company A are simulated, with answer keys the system never sees when choosing.
- **Why rules and not the model deciding?** The model reads email and writes candidate skills; the kernel decides what may happen; skills are small programs we can replay, bound and audit.
- **What does a person still do?** Answer questions, release money, endorse bank changes, approve skill versions and policies, close the books — and get pushed back on when they are wrong.
