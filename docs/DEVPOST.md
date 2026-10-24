# Charter — Devpost

## Elevator pitch

An AI finance team that lives in one database: it catches and undoes its own mistakes when later evidence contradicts them, pushes back when a person's verdict would break an agreement, learns binding policies from its losses, and cannot move a cent outside a kernel the AI cannot change.

## Seats it fills

Cash-application accountant, collections specialist and refunds specialist (receivables); payables clerk and payments (payables); mailroom clerk; internal auditor. People: two controllers and field consultants.

## Inspiration

Hyphenate asks what it takes to hire an AI seat: limited access, a clean record, knowing when to ask, and catching what others missed. Finance already answers that for humans with the three lines of defence. We built the AI version, and asked what an AI team must do that a rules engine with a memory of corrections does not: notice when something it decided weeks ago was wrong, say no to a person who is wrong, and turn a loss into a rule that binds every desk.

## What it does

- **Catches its own mistakes.** When a payment names an invoice the team already paid by inference, it works out that its earlier application was a guess, asks the controller with the evidence, reverses it, re-applies both payments and takes autonomy away from the rule that guessed.
- **Defends the agreement.** A spot check or correction that would chase a counterparty inside its contractual grace period is declined with the reason, never counted against the seat and never learned.
- **Learns policies from losses.** After a debit bounced during an unverified bank change, an exhaustive replay of every past money movement found the one rule that would have stopped it without holding back anything legitimate; the controller ratified it and it now also stops refunds and vendor payments — for the controller too.
- **Shares what it learns.** A new company can start from the skill a sister company learned, ratified by its own controller; a company with a history replays an offered skill through its own gate and refuses what does not fit.
- **Learns skills from one sentence, safely.** A correction becomes a candidate version of the team's skill, written by a model and judged by a deterministic replay over every past decision. Unsupported rules are dropped, failing candidates repaired, new thresholds centred between the nearest known cases; a person approves.
- **Earns autonomy rule by rule.** Spot checks, answers, field audits and audit findings move each rule between probation, normal, reduced, tightened and suspended on exact binomial bounds.
- **Weighs sources.** Who paid is voted by the account on file, the invoice named and the payer's name; two model families read every email that could move money.
- **Audits itself.** A read-only auditor on another model family tests every control and re-performs a monetary-unit sample each month; the controller closes the month into a hashed certificate anchored in git.

## How we built it

SpacetimeDB holds everything: the kernel and the seats are a TypeScript module (reducers for every command, procedures for the seats that call models), so the ledger, the record and the live UI share one transactional state. Models are quarantined readers through Alibaba Model Studio (Qwen and Kimi as the two readers, Qwen-Max as the skill writer, DeepSeek as the attacker and the auditor's re-reader). The evolver, the auditor, the benchmark harness and the simulated worlds are Node and Python tools that reuse the module's own interpreter, so what is proven offline is what runs online. React and the SpacetimeDB client for the UI.

## Proof

- **BenchRec (a Tier-1 institution's real cash account, eval split scored once):** the bank desk started from one rule and learned the rest from 68,975 lines of the institution's reconciliation history, month by month, through the same evolver and gate as every desk. It found that a line booked in the ledger on a different day is wrong about one time in 25 and stopped matching those alone: 81.5% of 32,048 bank lines matched at 99.95% precision (12 wrong), against its day-0 rule's 84.4% at 99.82% (48 wrong) and six rules written by hand at 83.9% / 99.89%; the matcher shipped with the dataset matches 64.9% at 99.45%, below the 99.8% floor. Each rule earns its autonomy on train months no version was fitted to. By the benchmark's ranking day 0 places higher, but on the eval split the 918 lines the learned desk hands to people were wrong 36 times when day 0 matched them alone (one in 25): day 0 clears the floor only by averaging that pattern into clean matches, and Charter will not, since every rule earns its autonomy on its own record.
- **Company B (real UCI Online Retail II invoices and credit notes; simulated payments with the long tail: bank charges and exchange differences on payments from abroad, money on account without a reference, one payment for two invoices, duplicates):** on the locked test split the cash landed where the payer meant for 312 of 317 payments, and the team was wrong on 4 of the 300 it settled alone (95% upper bound 3.0%). The day-one skill was wrong on 18 of the 300 test payments it settled alone; the controller's answers became four replay-gated versions (a payment naming one open invoice goes there even when short; a reference to an invoice already paid is a duplicate), and the current one is wrong on 4 of 306. After January it settled 97–99% of payments alone each month; eleven times a later payment exposed an earlier guess and the team undid it; £1,188 of bank-charge pennies was listed weekly and written off by the controller instead of chased.
- **Company A (simulated franchisor, six months, planted errors and people who make mistakes):** on the locked test split under-reported weeks caught 0/4 → 3/4 with every low-cash and bulk-buying week still accepted, cheques in the mail no longer chased 0/3 → 3/3, duplicate bills rejected 0/2 → 2/2; $89,242 of duplicate bills stopped and none paid; one returned debit became three binding policies; the internal auditor qualified two months for duplicate liabilities and a misbilled royalty; seven of people's verdicts were put back to them for a second look (four were slips). Still missed: one store's milder under-reporting in June, and short payments sent without an invoice number. Company B's skill, offered to company A whole and rule by rule at every position, was refused by A's own gate: the whole program would break four of A's labeled cases, and none of B's rules handles anything A's people taught (A's franchisees do not put invoice numbers in their references).
- **Skills travel (company C, a sister ledger of real 2009–10 invoices from the same dataset, run twice on identical events):** started from the cash skill company B learned (only the program crossed; C's controller ratified it; every rule started on probation), C was wrong 3 times in its first three months when it settled alone instead of 22, asked people 12 times instead of 33, and needed 2 new versions instead of 6; on its locked test split the cash landed where meant for 325 of 329 payments instead of 318.
- **Red team:** 36 attack emails by another model family; Charter 0/36 with a careless controller; tool-using LLM agents 13, 8 and 4 of 36 with plain prompts.

## Challenges

Our own evaluator kept catching us. The evolver overfit one example until we chose candidates by robustness; masked bank-account numbers collided and sent a customer's payments to another customer until payer identity became a vote between sources; simulated people's slips asked for notices inside the grace period until the team learned to push back. Making the payments messy broke learning outright: with bank charges in the data no candidate could pass, because "apply to the invoice the payer named" and "apply oldest first" looked like contradictory answers for a customer with one open invoice. Decisions now record what each outcome would do, and everything compares that. Then a reviewer we asked to attack the gate showed that our first statistical version could pass a candidate wrong on 51 of its 52 new decisions, that an outcome unable to act could sneak past the hand-back test, and that the bank desk's autonomy was measured on the very months it had learned from; all three are fixed, and the bank desk now earns autonomy only on months after it last changed.

## What's next

More packs on the same kernel (bank reconciliation in the database, expenses, revenue recognition), and live connectors to a bank sandbox and an ERP.
