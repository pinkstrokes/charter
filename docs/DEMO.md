# Demo: two minutes at the table, then the judges' own scenario

The presenter is the controller, Dana, on a copy of the finished runs that resets in a second or two between tables: company B on its real invoices, company A on the Friday of a payment run nobody has attacked yet. A step bar at the bottom of the page opens each beat; a judge's own scenario goes in on the World screen.

```bash
tools/demo/demo.sh up        # demo server :3100, the evolver watching A and B, the UI
open http://127.0.0.1:5191   # step 1 is company B's moment
tools/demo/demo.sh reset     # between tables (or Reset on the step bar)
```

Once, after the final runs: stop the main server, `tools/demo/demo.sh clone`, start the main server again, `tools/demo/demo.sh build`. The demo server is a separate SpacetimeDB on port 3100; its snapshot and the evolvers' working copy of `data/` live in `~/Developer/charter-demo-stdb`, so nothing done at the table reaches the runs or the repository.

## The two minutes

| Step | Do | Say |
|---|---|---|
| — | | "Charter is a finance team's back office — receivables, collections, payables — run by seats that act only through a kernel, and that learn as a team from every correction, but only after replaying it over everything that came before." |
| 1 The moment (B) | The Why panel opens on "cash applied to the wrong invoice?" | "Real invoices from a UK wholesaler. On 28 December a customer pays £2,149 and names invoice 536784. Our day-one skill matched three other invoices that came close. Five days later £30 arrives naming one of those three. Charter sees that its own guess paid it, asks the controller, and undoes it. That lesson is now the team's: the invoices a payer names come first." |
| 2 Your payment (B) | "Give it a payment — anything." Type the judge's idea; or the chip *Two invoices from abroad, less charges*. *Send to the bank feed*. Then *Why* on the Cash application line, and scroll the panel to the highlighted rule. | Applied alone: "Exactly the two invoices the customer named; the £12 the banks kept stays open for Monday's write-off list. Why: rule 7 — learned in January from the controller's answers, 'the customer named the invoice; the difference is the banks' charges', and replayed over every past payment before it went live." If it asks instead (a customer with many open invoices, several sets add up): "It has seen only a handful of these, so it asks, and offers the customer's own invoices first. Answer it, and that answer is evidence for the next version." |
| 3 Push back (A) | The Why panel of a collections hold opens. *This was wrong* → *Chase* → "they're always late" → *Record*. | "I'm the controller and I say chase them. It refuses: a notice on day 4 breaks the 10-day grace period in the agreement. It keeps its decision, and my answer is never learned." |
| 4 Try to steal (A) | Security: the preset *Vendor's own address, new bank* is filled in. *Send to ar@ as an outsider*. About ten seconds later the right side shows *Bank change held* and *Callback asked of the controller*. | While it reads: "Formosa Leaf's real mailbox asks us to pay today's $92,400 to a new account. Two models read it, and neither has any tools." Then: "The change is held, and the controller is asked to call the number we already had — not one in the email." |
| 5 Release it (A) | Payables: *Release as Dana* on Formosa Leaf's $92,400 (refused: C14 wants a second controller, and P-3). Switch to Sam at the top (or press 2), *Release as Sam*. | "Two controllers agree — still refused, by P-3. Nobody wrote P-3: a debit bounced in April during a bank change nobody verified; Charter replayed every past money movement, found the one rule that would have stopped it without holding anything legitimate, and put it in front of refunds and vendor payments." |
| 6 Proof (B) | Proof. | "On 314 test payments it never trained on, the cash landed where the payer meant 309 times. The day-one skill was wrong on 19 of the 301 it settled alone; the controller's answers made four versions, and now it is wrong on 3 of 306. A sister ledger started from this skill made one mistake in its first three months instead of 21. On a real bank's reconciliation it matched 81.5% alone at 99.95% precision, and cleared the 99.8% floor every month. And a solver checks the seats together: on these books collections had chased customers with their own money, waiting to be applied, 72 times. Three lines of constitution now stop it, proved for every situation." |

## The judges' turn

- **Make something up.** World: a payment (any payer, any invoices, any reference, from any account) or a bill (any vendor, any number, with or without an order). It goes in through the same door as everything the simulation delivered; follow it to the seat's decision and its Why, or to the question it asked.
- **Correct anything.** Open any decision's Why panel, *This was wrong*, one line of why. The evolver is watching: it proposes a new version with its replay proof, or says why one answer is not enough evidence. Activate it as the controller; it starts on probation.
- **Attack it.** Security: any email from any address — look-alike domains, prompt injection in a remittance, a refund to a new account, someone claiming to be the CEO. Two readers, the sender check and the kernel decide; every refusal is on the record.
- **Ask why.** Every row opens a Why panel: who, what it asked for, the policies the kernel checked, the facts it saw, the evidence it used, and the row's place in the hash chain.

## Questions to expect

- **Does knowledge transfer?** Where the work is the same, yes: company C started from company B's skill and made one mistake in its first three months instead of 21, and asked people 96 times in seven months instead of 173. Where it differs, the target refuses: B's skill offered to company A failed A's own gate. It handles none of the cases A's people had just taught and would get three of A's labeled cases wrong; the lesson that would have fixed A's short payments had no clean evidence at A, and a rule takes over work only on agreeing cases of the receiving company's own.
- **What is real?** Company B's and C's invoices and credit notes (UCI Online Retail II) and BenchRec's bank and ledger lines are real; their payments and all of company A are simulated, with answer keys the system never sees when choosing.
- **Why rules and not the model deciding?** The model reads email and writes candidate skills; the kernel decides what may happen; skills are small programs we can replay, bound and audit.
- **Can seats each be right and still be wrong together?** Yes, and a solver found it before any run did on company A. Cash application rightly leaves a payment it cannot place unapplied and asks; collections rightly chases what is past due; together they chased customers whose own money was waiting to be applied, 72 times on company B's books and 34 on C's. The kernel now computes that fact and the constitution forbids the notice and the fee (C16–C18), proved for every situation and both collections versions. The obvious policy, no chase while any cash is unapplied, would also have held a chase a person confirmed was right.
- **What does a person still do?** Answer questions, release money, endorse bank changes, approve skill versions and policies, close the books — and get pushed back on when they are wrong.
