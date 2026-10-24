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
- **Learns skills from one sentence, safely.** A correction becomes a candidate version of the team's skill, written by a model and judged by a deterministic replay over every past decision. Unsupported rules are dropped, failing candidates repaired, new thresholds centred between the nearest known cases; a person approves.
- **Earns autonomy rule by rule.** Spot checks, answers, field audits and audit findings move each rule between probation, normal, reduced, tightened and suspended on exact binomial bounds.
- **Weighs sources.** Who paid is voted by the account on file, the invoice named and the payer's name; two model families read every email that could move money.
- **Audits itself.** A read-only auditor on another model family tests every control and re-performs a monetary-unit sample each month; the controller closes the month into a hashed certificate anchored in git.

## How we built it

SpacetimeDB holds everything: the kernel and the seats are a TypeScript module (reducers for every command, procedures for the seats that call models), so the ledger, the record and the live UI share one transactional state. Models are quarantined readers through Alibaba Model Studio (Qwen and Kimi as the two readers, Qwen-Max as the skill writer, DeepSeek as the attacker and the auditor's re-reader). The evolver, the auditor, the benchmark harness and the simulated worlds are Node and Python tools that reuse the module's own interpreter, so what is proven offline is what runs online. React and the SpacetimeDB client for the UI.

## Proof

- **BenchRec (a Tier-1 institution's real cash account, eval split scored once):** 83.9% of 32,048 bank lines matched alone at 99.90% precision, clearing the benchmark's 99.8% floor; the matcher shipped with the dataset matches 64.9% at 99.45%. Two of six day-0 rules earned autonomy on the train split; the rest go to people.
- **Company B (real UCI Online Retail II invoices and credit notes; simulated payments):** on the locked test split the cash landed where the payer meant for 310 of 310 payments, and the team was wrong on 0 of the 299 it settled alone (95% upper bound 1.0%); month by month it settled 68% → 100% alone and asked people 6 → 0 times a month, with four replay-gated versions of its skill; twice in January a later payment exposed an earlier guess and the team undid it.
- **Company A (simulated franchisor, six months, planted errors and people who make mistakes):** on the locked test split under-reported weeks caught 0/4 → 3/4 with every clean, low-cash and bulk-buying week still accepted, cheques in the mail no longer chased 0/3 → 3/3, duplicate bills rejected 0/2 → 2/2; $89,242 of duplicate bills stopped and none paid; one returned debit became three binding policies; the internal auditor qualified two months for duplicate liabilities and a misbilled royalty; seven of people's verdicts were put back to them for a second look (four were slips). Company B's skill was refused at company A by A's own gate: it would have broken three of A's labeled cases.
- **Red team:** 36 attack emails by another model family; Charter 0/36 with a careless controller; tool-using LLM agents 13, 8 and 4 of 36 with plain prompts.

## Challenges

Our own evaluator kept catching us. The evolver overfit one example until we chose candidates by robustness; a tempting payables rule would have rejected a price increase a person had approved; a skill fitted to March's stores missed June's milder under-reporting until thresholds were centred between known cases; masked bank-account numbers collided and sent a customer's payments to another customer until payer identity became a vote between sources; and simulated people who make mistakes kept collections from learning anything — their slips asked for notices inside the grace period, which no candidate could honour — until the team learned to push back.

## What's next

More packs on the same kernel (bank reconciliation in the database, expenses, revenue recognition), and live connectors to a bank sandbox and an ERP.
