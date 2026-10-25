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

const D = JSON.parse(readFileSync(new URL('./data/inputs.json', import.meta.url), 'utf8'));
const A = JSON.parse(readFileSync(new URL('./data/a-f02.json', import.meta.url), 'utf8'));
const record: any[] = JSON.parse(readFileSync(new URL('./data/decisions-a-prechase.json', import.meta.url), 'utf8'));
const { Context } = await init();
const Z3 = Context('main');

const COLL = { kind: 'seat' as const, id: 'seat:collections', role: 'collections' as const };
const FACTS = Object.keys(FACT_LIBRARY) as (keyof typeof FACT_LIBRARY)[];
const learned: PolicyRule[] = A.policies.map((p: any) => ({ id: p.id, version: 1, tpl: p.template, constitutional: false, text: p.text }));
// The constitution today, and as it was before 4b81c48 added C16-C18.
const rulesNow: PolicyRule[] = [...CONSTITUTION, ...ROLE_MATRIX, ...learned];
const rulesBefore: PolicyRule[] = rulesNow.filter(r => !['C16', 'C17', 'C18'].includes(r.id));
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

// feeFacts: a late-fee request carries the kernel's facts (4b81c48 world.ts); noticeGated: fees go out only with a
// notice the kernel let through (4b81c48 seats.ts). Before 4b81c48 neither held.
interface Variant { name: string; rules: PolicyRule[]; skill: (p: SkillProgram) => SkillProgram; feeFacts?: boolean; noticeGated?: boolean; adopted?: boolean }
const variants: Variant[] = [
  { name: 'before the fix', rules: rulesBefore, skill: p => p },
  { name: 'P-4: no notice while cash is unapplied', rules: [...rulesBefore, P4], skill: p => p },
  { name: 'P-4 and P-5: no notice, no fee while cash is unapplied', rules: [...rulesBefore, P4, P5], skill: p => p },
  { name: 'P-4 and P-5, and a late-fee request carries the kernel\'s facts', rules: [...rulesBefore, P4, P5], skill: p => p, feeFacts: true },
  { name: 'collections learns: hold while unapplied cash covers the balance', rules: rulesBefore, skill: withHold },
  { name: 'the constitution now: C16, C17, C18 (4b81c48)', rules: rulesNow, skill: p => p, feeFacts: true, noticeGated: true, adopted: true },
];
const base = variants[0];

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
  // kernel.ts factsFor computes past due from the same invoices preChaseFeatures counts (4b81c48).
  fact.unapplied_covers_past_due.eq(Z3.And(v('open_amount').ge(1), v('unapplied_amount').ge(v('open_amount')))),
  fact.open_dispute.eq(v('open_dispute')),
  fact.recent_return.eq(v('recent_return')),
  Z3.Not(fact.within_grace), // in the library, never computed by factsFor
];
const allows = (table: boolean[]) => Z3.Or(...table.flatMap((ok, mask) => (ok ? [Z3.And(...FACTS.map((f, i) => (mask & (1 << i) ? fact[f] : Z3.Not(fact[f]))))] : [])));
const covered = Z3.And(v('unapplied_amount').ge(v('open_amount')));

// What each seat does in a situation, as formulas: a notice goes out when the skill chases past grace and the kernel
// allows it; a late fee follows the chase (before 4b81c48) or only a notice that went out (now), through its own request.
function sends(variant: Variant, version: string) {
  const chase = enc.decision(variant.skill(preChase[version])).eq(['chase', 'hold', 'ask_consultant', 'escalate_controller'].indexOf('chase'));
  const pastGrace = v('days_past_due').gt(v('grace_days'));
  const notice = Z3.And(chase, pastGrace, allows(allowedTable(variant.rules, 'send_notice')));
  const fee = Z3.And(variant.noticeGated ? notice : Z3.And(chase, pastGrace), allows(allowedTable(variant.rules, 'assess_fee', variant.feeFacts)));
  return { notice, fee };
}
type Prop = 'notice' | 'fee' | 'bankruptcyFee' | 'overholds';
async function check(variant: Variant, version: string, prop: Prop) {
  const s = new Z3.Solver();
  s.add(...enc.ranges(), ...axioms.map(a => a.f), ...links);
  const x = sends(variant, version);
  if (prop === 'notice') s.add(covered, x.notice);
  if (prop === 'fee') s.add(covered, x.fee);
  if (prop === 'bankruptcyFee') s.add(fact.bankruptcy_flag, x.fee);
  // Holding a legitimate chase: their cash does not cover what is past due, the old kernel sent the notice, this one does not.
  if (prop === 'overholds') s.add(Z3.Not(covered), sends(base, version).notice, Z3.Not(x.notice));
  if ((await s.check()) === 'unsat') return { holds: true };
  const m = s.model();
  return { holds: false, counterexample: enc.features(m), facts: Object.fromEntries(FACTS.map(k => [k, m.eval(fact[k], true).toString() === 'true'])) };
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
  const facts = Object.fromEntries(FACTS.map(k => [k, k === 'payment_in_transit' ? unapplied > 0 : k === 'unapplied_covers_past_due' ? owed > 0 && unapplied >= owed : false]));
  const breach = labelBreach('pre_chase', f, collDecides);
  const notice = collDecides === 'chase' && !breach ? evaluate(variant.rules, { principal: COLL, action: 'send_notice', facts }) : null;
  const feesFor = collDecides === 'chase' && (!variant.noticeGated || notice?.allowed) ? pastDue.filter((i: any) => daysBetween(i.dueDate, today) > A.terms.graceDays) : [];
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

// A legitimate chase, from company A's record: Emerald City Tea (F12) on 9 June, $25 unapplied against $2,767.81
// past due on day 22 of a 15-day grace, which collections chased and a person later confirmed was right.
const f12 = record.find(r => r.subject === 'entity:F12:2026-06-09');
function playLegit(variant: Variant) {
  const f = { ...f12.f, notices_last_30d: 0 };
  const decides = run(variant.skill(preChase[f12.skill]), f).outcome.decide;
  const facts = Object.fromEntries(FACTS.map(k => [k, k === 'payment_in_transit' ? f.unapplied_amount > 0 : k === 'unapplied_covers_past_due' ? f.open_amount > 0 && f.unapplied_amount >= f.open_amount : false]));
  const notice = decides === 'chase' && !labelBreach('pre_chase', f, decides) ? evaluate(variant.rules, { principal: COLL, action: 'send_notice', facts }) : null;
  return { on: f12.at, party: 'F12', features: f, labeled: f12.label, decides, notice: notice ? { allowed: notice.allowed, refused: notice.reasons } : null };
}

const PROPS: [Prop, string][] = [['notice', 'no notice while their cash covers what is past due'], ['fee', 'no late fee while their cash covers what is past due'], ['bankruptcyFee', 'no late fee in bankruptcy'], ['overholds', 'never holds a chase their cash does not cover']];
const results: any[] = [];
for (const variant of variants) {
  const versions: any = {};
  for (const key of Object.keys(preChase)) {
    versions[key] = {};
    for (const [prop] of PROPS) versions[key][prop] = variant === base && prop === 'overholds' ? { holds: true } : await check(variant, key, prop);
  }
  results.push({ variant: variant.name, adopted: !!variant.adopted, versions, world: playOut(variant), legit: playLegit(variant) });
}
// Counted by the main session on the runs' own books before 4b81c48: notices sent while the counterparty's unapplied cash covered what was past due.
const realBooks = { source: 'the runs before 4b81c48', A: { sent: 5, covered: 0 }, B: { sent: 1024, covered: 72, customers: 7 }, C: { sent: 1086, covered: 34, customers: 8 }, C0: { sent: 1110, covered: 45 } };
writeFileSync(new URL('./out/team.json', import.meta.url), JSON.stringify({ invariant: 'Never chase a counterparty with its own money: no notice and no late fee while its unapplied cash covers what is past due; and no late fee in bankruptcy; without holding a chase its cash does not cover.', properties: PROPS, axiomsCheckedOn: record.length, realBooks, results }, null, 1));

const md: string[] = ['# Team invariant: never chase a counterparty with its own money', '', `Checked across the collections skill (each of company A's versions, as dsl.ts runs it), the kernel (policy.ts evaluate over all ${1 << FACTS.length} combinations of its ${FACTS.length} facts) and the grace guard (labels.ts), for every possible situation; the axioms on the collections features hold on all ${record.length} of company A's collections decisions. Four properties: ${PROPS.map(p => p[1]).join('; ')}.`, '', `On the runs' own books before the fix, notices went out while the counterparty's unapplied cash covered what was past due: company B ${realBooks.B.covered} of ${realBooks.B.sent} notices, to ${realBooks.B.customers} customers; C ${realBooks.C.covered} of ${realBooks.C.sent}, to ${realBooks.C.customers}; C from scratch ${realBooks.C0.covered} of ${realBooks.C0.sent}; A ${realBooks.A.covered} of ${realBooks.A.sent}.`, ''];
for (const r of results) {
  md.push(`## ${r.variant}${r.adopted ? ' (adopted)' : ''}`);
  for (const [key, x] of Object.entries(r.versions) as any) {
    const say = (y: any, w: string) => (y.holds ? `proved: ${w}` : `**fails** (${w}); smallest case: ${Object.entries(y.counterexample).filter(([k]) => ['days_past_due', 'grace_days', 'open_amount', 'unapplied_amount'].includes(k)).map(([k, val]) => `${k} = ${val}`).join(', ')}${y.facts?.bankruptcy_flag ? ', in bankruptcy' : ''}`);
    md.push(`- ${key}: ${PROPS.map(([p, w]) => say(x[p], w)).join('; ')}.`);
  }
  const w = r.world, l = r.legit;
  md.push('', `Patel Brews, ${w.today}: ${w.payment}. Cash application (${w.cash.skill}) **${w.cash.decides === 'leave_unapplied_ask' ? 'leaves it unapplied and asks a person' : w.cash.decides}**; collections (${w.collections.skill}) decides **${w.collections.decides}** on day ${w.collections.features.days_past_due} past due.` +
    (w.notice ? ` The notice is ${w.notice.allowed ? '**sent**' : 'refused (' + w.notice.refused.join('; ') + ')'}.` : '') +
    (w.fees ? ` ${w.fees.count} late fees, ${money(w.fees.total)}, are ${w.fees.allowed ? '**charged**' : 'refused'}.` : ' No late fee.'),
    `Emerald City Tea, ${l.on}: $25 unapplied against ${money(l.features.open_amount)} past due on day ${l.features.days_past_due}; collections decides ${l.decides}${l.notice ? `, and the notice is ${l.notice.allowed ? 'sent, as a person later confirmed was right' : '**held** (' + l.notice.refused.join('; ') + '), though a person confirmed the chase was right'}` : ''}.`, '');
}
writeFileSync(new URL('./out/team.md', import.meta.url), md.join('\n'));
for (const r of results) console.log((r.adopted ? '* ' : '  ') + r.variant.padEnd(64), Object.entries(r.versions).map(([k, x]: any) => `${k.replace('pre_chase@', 'v')}: ${PROPS.map(([p]) => (x[p].holds ? '✓' : '✗')).join('')}`).join(' '), '| Patel:', r.world.notice ? (r.world.notice.allowed ? 'notice' : 'no notice') : 'no chase', r.world.fees ? (r.world.fees.allowed ? money(r.world.fees.total) : 'fees refused') : 'no fees', '| F12:', r.legit.notice ? (r.legit.notice.allowed ? 'chased' : 'HELD') : r.legit.decides);
process.exit(0);
