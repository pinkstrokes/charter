// npx tsx tools/certify/certify.ts [--data path/to/showcase/data.json] [--out dir]
//
// The cash-application skill's competence map and a certificate for every version it went through.
// The map lists every situation the skill's versions can tell apart (the solver proves none is
// missing), realizes each as a concrete payment on a real ledger (so none is impossible), and says
// what every version decides there and what the locked test payments say about it. A certificate
// for a new version lists exactly the situations where it decides differently, with the record
// for each, and the ones where it would act alone on no evidence at all.

import { init } from 'z3-solver';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { allocationAxioms } from './axioms';
import { competenceMap, grade, type Case, type Cell } from './map';
import { realize, type World } from './worlds';
import type { Expr } from '../../module/spacetimedb/src/core/dsl';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DATA = arg('--data', new URL('./data/inputs.json', import.meta.url).pathname);
const OUT = arg('--out', new URL('./out', import.meta.url).pathname);
const D = JSON.parse(readFileSync(DATA, 'utf8'));
const { Context } = await init();
const Z3 = Context('main');

// ---- words for the situations ----
const UNUSED_SAY: Record<string, [string, string]> = {
  '{"op":"cmp","c":"eq","a":{"op":"feat","name":"solution_count"},"b":{"op":"num","v":1}}': ['one set of open invoices adds up', ''],
  '{"op":"cmp","c":"eq","a":{"op":"feat","name":"solution_count"},"b":{"op":"num","v":0}}': ['no set of open invoices adds up within £25', ''],
  '{"op":"cmp","c":"gt","a":{"op":"feat","name":"solution_count"},"b":{"op":"num","v":1}}': ['several sets add up', ''],
  '{"op":"feat","name":"exact_match"}': ['exactly', 'within £25, not exactly'],
  '{"op":"feat","name":"reference_names_open"}': ['the reference names an open invoice', 'the reference names no open invoice'],
  '{"op":"feat","name":"reference_matches_open"}': ['one it names is for the amount, give or take £1', ''],
  '{"op":"feat","name":"reference_paid"}': ['what the reference names is already paid', ''],
  '{"op":"feat","name":"remittance_consistent"}': ['a remittance lists invoices that add up', ''],
  '{"op":"cmp","c":"eq","a":{"op":"feat","name":"residual_cents"},"b":{"op":"num","v":0}}': ['', ''],
};
const formula = (e: Expr): string => (e.op === 'feat' ? e.name : e.op === 'num' ? String(e.v) : e.op === 'cmp' ? `${formula(e.a)} ${{ eq: '=', ne: '≠', gt: '>', ge: '≥', lt: '<', le: '≤' }[e.c]} ${formula(e.b)}` : JSON.stringify(e));
function describe(vocab: Expr[], cell: Cell): string {
  const at = (sig: string) => vocab.findIndex(a => JSON.stringify(a) === sig);
  const is = (sig: string) => { const i = at(sig); return i >= 0 ? cell.literals[i].value : undefined; };
  const k = (name: string) => `{"op":"feat","name":"${name}"}`, sc = (c: string, v: number) => `{"op":"cmp","c":"${c}","a":{"op":"feat","name":"solution_count"},"b":{"op":"num","v":${v}}}`;
  const parts: string[] = [];
  // How the amount is explained: no set, one set or several, exactly or within the £25 tolerance.
  const exact = is(k('exact_match'));
  if (is(sc('eq', 0))) parts.push('no set of open invoices adds up within £25');
  else if (is(sc('eq', 1))) parts.push(exact ? 'one set of open invoices adds up exactly' : 'one set adds up within £25, not exactly');
  else if (is(sc('gt', 1))) parts.push(exact ? 'several sets add up exactly' : 'several sets add up within £25');
  // What the payer said.
  if (is(k('reference_names_open'))) parts.push('the reference names an open invoice' + (is(k('reference_matches_open')) ? ', one of them for the amount (±£1)' : ''));
  else parts.push(is(k('reference_paid')) ? 'what the reference names is already paid' : 'the reference names no open invoice');
  if (is(k('remittance_consistent'))) parts.push('a remittance lists invoices that add up');
  // Any condition the words above do not cover is shown as written.
  const covered = new Set([k('exact_match'), sc('eq', 0), sc('eq', 1), sc('gt', 1), k('reference_names_open'), k('reference_matches_open'), k('reference_paid'), k('remittance_consistent'), '{"op":"cmp","c":"eq","a":{"op":"feat","name":"residual_cents"},"b":{"op":"num","v":0}}']);
  vocab.forEach((a, i) => { if (!covered.has(JSON.stringify(a))) parts.push(`${cell.literals[i].value ? '' : 'not '}${formula(a)}`); });
  return parts.join('; ');
}
const DO: Record<string, string> = { apply_unique: 'applies the set', apply_to_reference: 'applies to the invoices it names', apply_by_terms: 'applies oldest first', leave_unapplied_ask: 'asks a person' };
const money = (c: number) => '£' + (c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- the map ----
const companies = [['B', D.b], ['C', D.c]] as const;
const versions: Record<string, any> = {};
for (const [co, d] of companies) for (const v of d.versions) versions[`${co}:${v.key}`] = v.program;
const record: Case[] = companies.flatMap(([co, d]) => d.cases.map((c: any) => ({ ...c, id: `${co}:${c.id}` })));
const byId = new Map(record.map(c => [c.id, c]));
// Everything each company ever decided, and which of those a person labeled.
const decisions: Record<string, any[]> = { B: JSON.parse(readFileSync(new URL('./data/decisions-b.json', import.meta.url), 'utf8')), C: JSON.parse(readFileSync(new URL('./data/decisions-c.json', import.meta.url), 'utf8')) };
const everything: Case[] = Object.entries(decisions).flatMap(([co, ds]) => ds.map(d => ({ id: `${co}#${d.id}`, f: d.f, t: d.t, truth: d.truth, family: d.family, at: d.at })));
const map = await competenceMap(Z3, 'allocation', versions, allocationAxioms(Z3, 2500), [...record, ...everything]);
const sb = D.sandbox;
const base = { payer: sb.payer, asOf: sb.asOf, invoices: sb.items.map((i: any) => ({ ...i })), order: sb.order };
const worlds = realize(base, { amount: 214930, reference: '536784', remitRefs: [] }, map.vocab);
const keyOf = (c: Cell) => c.literals.map(l => (l.value ? '1' : '0')).join('');
const unrealized = map.cells.filter(c => !worlds.has(keyOf(c))).map(c => c.id);

interface Seen { cases: number; families: string[]; byVersion: Record<string, { right: number; alone: number; wrongAlone: number }> }
const labeled = new Set(Object.entries(decisions).flatMap(([co, ds]) => ds.filter(d => d.label).map(d => `${co}#${d.id}`)));
// How often a company ever decided in a situation, and how often a person told it what was right there.
function history(cell: Cell, co: string) {
  const ids = cell.cases.filter(id => id.startsWith(co + '#'));
  return { decided: ids.length, labeled: ids.filter(id => labeled.has(id)).length, first: ids.map(id => everything.find(e => e.id === id)!.at).sort()[0] ?? null };
}
function seen(cell: Cell, co?: string): Seen {
  const ids = cell.cases.filter(id => id.includes(':') && (!co || id.startsWith(co + ':')));
  const byVersion: Seen['byVersion'] = {};
  for (const vk of Object.keys(versions)) {
    let right = 0, alone = 0, wrongAlone = 0;
    for (const id of ids) { const g = grade(cell.decide[vk], byId.get(id)!); right += g.right ? 1 : 0; if (g.alone) { alone++; if (!g.right) wrongAlone++; } }
    byVersion[vk] = { right, alone, wrongAlone };
  }
  return { cases: ids.length, families: [...new Set(ids.map(id => byId.get(id)!.family ?? ''))].filter(Boolean), byVersion };
}
const situations = map.cells.map(cell => {
  const w = worlds.get(keyOf(cell)) as World;
  return {
    id: cell.id, says: describe(map.vocab, cell), literals: cell.literals.map(l => ({ atom: formula(map.vocab[l.atom]), value: l.value })),
    world: w && { starts: `${sb.payer}'s real ledger on ${sb.asOf} and the payment of ${money(214930)} naming 536784`, edits: w.edits.map(e => e.says), payment: w.payment, features: w.features, lands: w.treatments },
    decide: cell.decide, record: { all: seen(cell), B: seen(cell, 'B'), C: seen(cell, 'C') }, history: { B: history(cell, 'B'), C: history(cell, 'C') }, caseIds: cell.cases.filter(id => id.includes(':')),
  };
});

// ---- certificates: what each new version changes ----
const certificates = companies.flatMap(([co, d]) => d.versions.slice(1).map((v: any, i: number) => {
  const from = `${co}:${d.versions[i].key}`, to = `${co}:${v.key}`;
  const changed = situations.filter(s => s.decide[from] !== s.decide[to]).map(s => {
    const r = s.record[co as 'B' | 'C'];
    const hst = s.history[co as 'B' | 'C'];
    // Per recorded payment: newly right, newly wrong with nobody asked, or handed back to a person.
    let fixed = 0, newlyWrongAlone = 0, handedBack = 0;
    for (const id of situations.find(x => x.id === s.id)!.caseIds.filter((x: string) => x.startsWith(co + ':'))) {
      const c = byId.get(id)!, b = grade(s.decide[from], c), a = grade(s.decide[to], c);
      if (!b.right && a.right) fixed++;
      if (a.alone && !a.right && !(b.alone && !b.right)) newlyWrongAlone++;
      if (b.right && !a.alone) handedBack++;
    }
    return { situation: s.id, says: s.says, from: s.decide[from], to: s.decide[to], recorded: r.cases, rightBefore: r.byVersion[from].right, rightAfter: r.byVersion[to].right, fixed, newlyWrongAlone, handedBack, everDecided: hst.decided, labeledByPeople: hst.labeled, actsAloneOnNoEvidence: hst.labeled === 0 && s.decide[to] !== 'leave_unapplied_ask' };
  });
  const aloneUnseen = situations.filter(s => s.history[co as 'B' | 'C'].decided === 0 && s.decide[to] !== 'leave_unapplied_ask').map(s => s.id);
  const aloneUnlabeled = situations.filter(s => s.history[co as 'B' | 'C'].labeled === 0 && s.decide[to] !== 'leave_unapplied_ask').map(s => s.id);
  return { company: co, from: d.versions[i].key, to: v.key, liveFrom: v.liveFrom, changes: changed, fixedOnRecord: changed.reduce((x, c) => x + c.fixed, 0), newlyWrongAlone: changed.reduce((x, c) => x + c.newlyWrongAlone, 0), handedBack: changed.reduce((x, c) => x + c.handedBack, 0), brokenOnRecord: changed.reduce((x, c) => x + Math.max(0, c.rightBefore - c.rightAfter), 0), changesWithNoEvidence: changed.filter(c => c.labeledByPeople === 0).length, actsAloneWhereUnseen: aloneUnseen, actsAloneWhereUnlabeled: aloneUnlabeled };
}));

mkdirSync(OUT, { recursive: true });
const result = {
  skill: 'allocation (cash application)', companies: ['B', 'C'], record: `the locked test payments: ${D.b.cases.length} in B, ${D.c.cases.length} in C`,
  vocabulary: map.vocab.map(formula), axioms: map.axioms, situations: situations.length, realized: situations.length - unrealized.length, unrealized,
  map: situations, certificates,
};
writeFileSync(`${OUT}/allocation-map.json`, JSON.stringify(result, null, 1));

// ---- the readable report ----
const lines: string[] = [];
lines.push(`# Competence map: cash application (companies B and C)`, '');
lines.push(`Every situation the ${Object.keys(versions).length} versions of the skill can tell apart, from the ${map.vocab.length} conditions they ever tested: **${situations.length} situations**, none missed (Z3, under ${map.axioms.length} consistency axioms that every recorded payment satisfies), each realized as a concrete payment on ${sb.payer}'s real ledger of ${sb.asOf} (${situations.length - unrealized.length} of ${situations.length}). The record is ${result.record}.`, '');
const vkLast = (co: string) => `${co}:${(co === 'B' ? D.b : D.c).versions.slice(-1)[0].key}`;
for (const co of ['B', 'C']) {
  const last = vkLast(co);
  const h = (s: any) => s.history[co as 'B' | 'C'];
  const never = situations.filter(s => h(s).decided === 0 && s.decide[last] !== 'leave_unapplied_ask');
  const unlabeled = situations.filter(s => h(s).labeled === 0 && s.decide[last] !== 'leave_unapplied_ask');
  lines.push(`- ${co}'s current version (${last.split(':')[1]}) settles alone in **${never.length}** situations that none of ${co}'s ${decisions[co].length} payments ever fell into (${never.map(s => s.id).join(', ')}), and in **${unlabeled.length}** where no person ever told it what was right.`);
}
const disagree = situations.filter(s => s.history.B.decided === 0 && s.history.C.decided === 0 && s.decide[vkLast('B')] !== s.decide[vkLast('C')]);
lines.push(`- Where neither company has a single recorded payment, their current versions disagree in **${disagree.length}** situations: ${disagree.map(s => `${s.id} (B ${DO[s.decide[vkLast('B')]]}, C ${DO[s.decide[vkLast('C')]]})`).join('; ')}.`, '');
lines.push('## Certificates', '');
for (const c of certificates) {
  lines.push(`### ${c.company}: ${c.from} → ${c.to}${c.liveFrom ? ` (live ${c.liveFrom})` : ''}`);
  lines.push(`Changes ${c.changes.length} situations. On the locked test payments: ${c.fixedOnRecord} newly right, ${c.newlyWrongAlone} newly wrong with nobody asked, ${c.handedBack} right ones handed back to a person. ${c.changesWithNoEvidence} of its changes are in situations no person ever labeled.`, '');
  for (const ch of c.changes) lines.push(`- ${ch.situation} — ${ch.says}: ${DO[ch.from]} → **${DO[ch.to]}**. ${ch.everDecided ? `${ch.everDecided} decided in all, ${ch.labeledByPeople} labeled by people` : 'Never decided'}${ch.recorded ? `; test payments right ${ch.rightBefore} → ${ch.rightAfter} of ${ch.recorded}` : ''}.`);
  lines.push('');
}
lines.push('## Situations', '');
for (const s of situations) {
  const r = s.record.all;
  lines.push(`**${s.id}** — ${s.says}. B decided ${s.history.B.decided} (${s.history.B.labeled} labeled), C ${s.history.C.decided} (${s.history.C.labeled} labeled)${r.cases ? `; test payments: ${r.cases} (${r.families.join(', ')})` : ''}.`);
  if (s.world) lines.push(`  World: ${s.world.edits.length ? s.world.edits.join('; ') : 'the real moment itself'} → ${money(s.world.payment.amount)}${s.world.payment.reference ? ` naming ${s.world.payment.reference}` : ''}.`);
  lines.push(`  Decides: ${[...new Set(Object.values(s.decide))].map(o => `${DO[o]} (${Object.keys(s.decide).filter(k => s.decide[k] === o).map(k => k.replace(':allocation@', ' v')).join(', ')})`).join('; ')}.`, '');
}
writeFileSync(`${OUT}/allocation-map.md`, lines.join('\n'));
console.log(`map: ${situations.length} situations (${situations.length - unrealized.length} realized), vocabulary ${map.vocab.length}; certificates: ${certificates.length}; written to ${OUT}`);
for (const c of certificates) console.log(`${c.company} ${c.from} → ${c.to}: ${c.changes.length} changes, fixes ${c.fixedOnRecord}, newly wrong alone ${c.newlyWrongAlone}, handed back ${c.handedBack}, changes with no label ${c.changesWithNoEvidence}, alone where never decided ${c.actsAloneWhereUnseen.length}, alone where never labeled ${c.actsAloneWhereUnlabeled.length}`);
process.exit(unrealized.length ? 1 : 0);
