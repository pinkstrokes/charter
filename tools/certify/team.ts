// npx tsx tools/certify/team.ts
//
// A team-level invariant: no seat may chase a counterparty, by notice or by late fee, while the
// counterparty's own unapplied cash covers what is past due. No single skill owns this: the money
// sits with cash application (which asked a person where it goes), the notice and the fee come from
// collections, and the kernel decides what is allowed. So the check takes all three together: the
// collections skill as written (dsl.ts), the kernel's rules as executed (policy.ts evaluate over every
// combination of the facts it computes), and the grace-period guard (labels.ts). For each way of
// closing the gap it either proves the invariant for every possible situation or returns one where it
// fails; then the failing situation is played out on company A's real ledger with the seats' own code.

import { init } from 'z3-solver';
import { readFileSync, writeFileSync } from 'node:fs';
import { run, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { CONSTITUTION, evaluate, FACT_LIBRARY, ROLE_MATRIX, type PolicyRule } from '../../module/spacetimedb/src/core/policy';
import { labelBreach } from '../../module/spacetimedb/src/core/labels';
import { Encoder } from './encode';
import { readPayment } from './seat';

const D = JSON.parse(readFileSync(`${process.env.HOME}/Developer/charter-showcase/data.json`, 'utf8'));
const A = JSON.parse(readFileSync(new URL('./data/a-f02.json', import.meta.url), 'utf8'));
const record: any[] = JSON.parse(readFileSync(new URL('./data/decisions-a-prechase.json', import.meta.url), 'utf8'));
const { Context } = await init();
const Z3 = Context('main');

const COLL = { kind: 'seat' as const, id: 'seat:collections', role: 'collections' as const };
const FACTS = Object.keys(FACT_LIBRARY) as (keyof typeof FACT_LIBRARY)[];
const learned: PolicyRule[] = A.policies.map((p: any) => ({ id: p.id, version: 1, tpl: p.template, constitutional: false, text: p.text }));
const rulesNow: PolicyRule[] = [...CONSTITUTION, ...ROLE_MATRIX, ...learned];
const P4: PolicyRule = { id: 'P-4', version: 1, constitutional: false, tpl: { t: 'forbid_when', action: 'send_notice', fact: 'payment_in_transit' }, text: 'No collection notice while money from the counterparty has arrived and is not yet applied.' };
const P5: PolicyRule = { id: 'P-5', version: 1, constitutional: false, tpl: { t: 'forbid_when', action: 'assess_fee', fact: 'payment_in_transit' }, text: 'No late fee while money from the counterparty has arrived and is not yet applied.' };
const preChase: Record<string, SkillProgram> = Object.fromEntries(D.a.skills.pre_chase.map((v: any) => [v.key, v.program]));
const current = D.a.skills.pre_chase.at(-1).key;
// A rule the collections skill could learn instead: hold while the counterparty's unapplied cash covers the balance.
const holdRule = { when: { op: 'cmp', c: 'ge', a: { op: 'feat', name: 'unapplied_amount' }, b: { op: 'feat', name: 'open_amount' } }, then: { decide: 'hold', note: 'their own unapplied cash covers what is past due' } } as any;
const withHold = (p: SkillProgram): SkillProgram => ({ ...p, rules: [holdRule, ...p.rules] });

// What each seat's request carries to the kernel: send_notice goes through exec with factsFor(entity);
// a late fee goes through createInvoice, whose exec call carries no facts at all.
function allowedTable(rules: PolicyRule[], action: 'send_notice' | 'assess_fee', feeFacts = false): boolean[] {
  const factsFor = { send_notice: true, assess_fee: feeFacts };
  const out: boolean[] = [];
  for (let mask = 0; mask < 1 << FACTS.length; mask++) {
    const facts = Object.fromEntries(FACTS.map((f, i) => [f, !!(mask & (1 << i))]));
    out.push(evaluate(rules, { principal: COLL, action, facts: factsFor[action] ? facts : undefined }).allowed);
  }
  return out;
}

interface Variant { name: string; rules: PolicyRule[]; skill: (p: SkillProgram) => SkillProgram; feeFacts?: boolean }
const variants: Variant[] = [
  { name: 'as it is', rules: rulesNow, skill: p => p },
  { name: 'P-4: no notice while cash is unapplied', rules: [...rulesNow, P4], skill: p => p },
  { name: 'P-4 and P-5: no notice, no fee while cash is unapplied', rules: [...rulesNow, P4, P5], skill: p => p },
  { name: 'P-4 and P-5, and a late-fee request carries the kernel\'s facts', rules: [...rulesNow, P4, P5], skill: p => p, feeFacts: true },
  { name: 'collections learns: hold while unapplied cash covers the balance', rules: rulesNow, skill: withHold },
];

const enc = new Encoder(Z3, 'pre_chase');
const v = (n: string) => enc.vars[n].t;
const fact = Object.fromEntries(FACTS.map(f => [f, Z3.Bool.const('fact_' + f)]));
// What every collections decision satisfies (checked against all of company A's below), and how the kernel's
// facts follow from the same ledger (kernel.ts factsFor, seats.ts preChaseFeatures).
const axioms = [
  { id: 'K1', says: 'something is past due', f: v('days_past_due').ge(1), holds: (x: any) => x.days_past_due >= 1 },
  { id: 'K2', says: 'the past-due balance is positive', f: v('open_amount').ge(1), holds: (x: any) => x.open_amount >= 1 },
  { id: 'K3', says: 'amounts and counts are not negative', f: Z3.And(v('grace_days').ge(0), v('unapplied_amount').ge(0), v('announced_payment').ge(0), v('open_credit_notes').ge(0), v('notices_last_30d').ge(0)), holds: (x: any) => x.grace_days >= 0 && x.unapplied_amount >= 0 && x.announced_payment >= 0 && x.open_credit_notes >= 0 && x.notices_last_30d >= 0 },
];
const broken = axioms.filter(a => record.some(r => !a.holds(r.f))).map(a => a.id);
if (broken.length) throw new Error(`axioms contradicted by company A's record: ${broken.join(', ')}`);
const links = [
  fact.payment_in_transit.eq(v('unapplied_amount').gt(0)),
  fact.open_dispute.eq(v('open_dispute')),
  fact.recent_return.eq(v('recent_return')),
  Z3.Not(fact.within_grace), // in the library, never computed by factsFor
];
const allows = (table: boolean[]) => Z3.Or(...table.flatMap((ok, mask) => (ok ? [Z3.And(...FACTS.map((f, i) => (mask & (1 << i) ? fact[f] : Z3.Not(fact[f]))))] : [])));
const covered = Z3.And(v('unapplied_amount').ge(v('open_amount')));

async function check(variant: Variant, version: string, what: 'notice' | 'fee') {
  const s = new Z3.Solver();
  s.add(...enc.ranges(), ...axioms.map(a => a.f), ...links, covered);
  const chase = enc.decision(variant.skill(preChase[version])).eq((['chase', 'hold', 'ask_consultant', 'escalate_controller']).indexOf('chase'));
  // seats.ts: a notice is sent when the skill says chase, the grace guard passes and the kernel allows it;
  // late fees follow the skill's chase decision for invoices past grace, through their own kernel request.
  const pastGrace = v('days_past_due').gt(v('grace_days'));
  s.add(chase, pastGrace, what === 'notice' ? allows(allowedTable(variant.rules, 'send_notice')) : allows(allowedTable(variant.rules, 'assess_fee', variant.feeFacts)));
  const r = await s.check();
  if (r === 'unsat') return { holds: true };
  const f = enc.features(s.model());
  return { holds: false, counterexample: f, facts: Object.fromEntries(FACTS.map(k => [k, s.model().eval(fact[k], true).toString() === 'true'])) };
}

// ---- the same situation on company A's real ledger ----
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const money = (c: number) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function playOut(variant: Variant) {
  const today = '2026-07-06';
  const ledger = { payer: A.name, asOf: today, invoices: A.open.map((i: any) => ({ id: i.id, kind: i.kind, amountCents: i.amount_cents, openCents: i.open_cents, dueDate: i.due_at })), order: A.terms.applicationOrder };
  const pastDue = ledger.invoices.filter((i: any) => i.dueDate < today);
  const owed = pastDue.reduce((s: number, i: any) => s + i.openCents, 0);
  const payment = { amount: owed, reference: 'JUNE SUPPLIES', remitRefs: [] as string[] };
  const cash = readPayment(ledger, payment);
  const cashSkill = D.a.skills.allocation.at(-1);
  const cashDecides = run(cashSkill.program, cash.features).outcome.decide;
  const unapplied = cashDecides === 'leave_unapplied_ask' ? owed : 0;
  const oldest = pastDue.map((i: any) => i.dueDate).sort()[0];
  const f = { days_past_due: daysBetween(oldest, today), grace_days: A.terms.graceDays, open_amount: owed, unapplied_amount: unapplied, announced_payment: 0, open_credit_notes: 0, open_dispute: false, recent_return: false, bank_change_recent: false, notices_last_30d: 0 };
  const collDecides = run(variant.skill(preChase[current]), f).outcome.decide;
  const facts = Object.fromEntries(FACTS.map(k => [k, k === 'payment_in_transit' ? unapplied > 0 : false]));
  const breach = labelBreach('pre_chase', f, collDecides);
  const notice = collDecides === 'chase' && !breach ? evaluate(variant.rules, { principal: COLL, action: 'send_notice', facts }) : null;
  const feesFor = collDecides === 'chase' ? pastDue.filter((i: any) => daysBetween(i.dueDate, today) > A.terms.graceDays) : [];
  const fee = feesFor.length ? evaluate(variant.rules, { principal: COLL, action: 'assess_fee', amountCents: A.terms.lateFeeCents, facts: variant.feeFacts ? facts : undefined }) : null;
  return {
    today, party: `${A.name} (${A.party}, ${A.contract}: ${A.terms.graceDays} days of grace, ${money(A.terms.lateFeeCents)} late fee per invoice)`,
    payment: `${money(owed)} arrives, reference "${payment.reference}": exactly the ${pastDue.length} invoices due ${oldest} (${pastDue.map((i: any) => i.id).join(', ')}); ${ledger.invoices.length - pastDue.length} more invoices are open, not yet due`,
    cash: { skill: cashSkill.key, features: cash.features, decides: cashDecides },
    collections: { skill: current, features: f, decides: collDecides },
    notice: notice ? { allowed: notice.allowed, by: notice.permittedBy, refused: notice.reasons } : null,
    fees: fee ? { allowed: fee.allowed, count: feesFor.length, total: feesFor.length * A.terms.lateFeeCents, refused: fee.reasons } : null,
  };
}

const results: any[] = [];
for (const variant of variants) {
  const versions: any = {};
  for (const key of Object.keys(preChase)) versions[key] = { notice: await check(variant, key, 'notice'), fee: await check(variant, key, 'fee') };
  results.push({ variant: variant.name, versions, world: playOut(variant) });
}
writeFileSync(new URL('./out/team.json', import.meta.url), JSON.stringify({ invariant: 'No notice and no late fee while the counterparty\'s unapplied cash covers what is past due.', axiomsCheckedOn: record.length, results }, null, 1));

const md: string[] = ['# Team invariant: never chase a counterparty with its own money', '', `No seat may send a notice or charge a late fee while the counterparty's unapplied cash covers what is past due. Checked across the collections skill (each of company A's versions, as dsl.ts runs it), the kernel (policy.ts evaluate over all ${1 << FACTS.length} combinations of its ${FACTS.length} facts) and the grace guard (labels.ts), for every possible situation; the axioms on the collections features hold on all ${record.length} of company A's collections decisions.`, ''];
for (const r of results) {
  md.push(`## ${r.variant}`);
  for (const [key, x] of Object.entries(r.versions) as any) {
    const say = (y: any, w: string) => (y.holds ? `**proved**: no ${w}` : `**fails**: a ${w} goes out, smallest case the solver finds: ${Object.entries(y.counterexample).filter(([k]) => ['days_past_due', 'grace_days', 'open_amount', 'unapplied_amount', 'announced_payment', 'open_dispute'].includes(k)).map(([k, val]) => `${k} = ${val}`).join(', ')}`);
    md.push(`- ${key}: ${say(x.notice, 'notice')}; ${say(x.fee, 'late fee')}.`);
  }
  const w = r.world;
  md.push('', `On company A's books, ${w.today}: ${w.party}. ${w.payment}. Cash application (${w.cash.skill}) **${w.cash.decides === 'leave_unapplied_ask' ? 'leaves it unapplied and asks a person' : w.cash.decides}**; collections (${w.collections.skill}) decides **${w.collections.decides}** on day ${w.collections.features.days_past_due} past due.` +
    (w.notice ? ` The notice is ${w.notice.allowed ? '**sent**' : 'refused (' + w.notice.refused.join('; ') + ')'}.` : '') +
    (w.fees ? ` ${w.fees.count} late fees, ${money(w.fees.total)}, are ${w.fees.allowed ? '**charged**' : 'refused'}.` : ' No late fee.'), '');
}
writeFileSync(new URL('./out/team.md', import.meta.url), md.join('\n'));
for (const r of results) console.log(r.variant.padEnd(66), Object.entries(r.versions).map(([k, x]: any) => `${k} notice ${x.notice.holds ? 'proved' : 'FAILS'} fee ${x.fee.holds ? 'proved' : 'FAILS'}`).join(' | '), '| A:', r.world.collections.decides, r.world.notice ? (r.world.notice.allowed ? 'notice sent' : 'notice refused') : 'no notice', r.world.fees ? (r.world.fees.allowed ? `fees ${money(r.world.fees.total)}` : 'fees refused') : 'no fees');
process.exit(0);
