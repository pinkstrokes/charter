// npx tsx tools/certify/site.ts  ->  out/certify-site.json
// The compact payload the public page shows and replays: the map's situations, the certificates, the
// timeline tables, the team check, and the kernel's own rule templates so the page can evaluate them.

import { readFileSync, writeFileSync } from 'node:fs';
import { CONSTITUTION, ROLE_MATRIX, FACT_LIBRARY } from '../../module/spacetimedb/src/core/policy';

const read = (f: string) => JSON.parse(readFileSync(new URL(`./out/${f}`, import.meta.url), 'utf8'));
const map = read('allocation-map.json'), tb = read('timeline-b.json'), tc = read('timeline-c.json'), team = read('team.json');
const A = JSON.parse(readFileSync(new URL('./data/a-f02.json', import.meta.url), 'utf8'));
const site = {
  generated: new Date().toISOString().slice(0, 16),
  map: {
    vocabulary: map.vocabulary, axioms: map.axioms.length, situations: map.map.map((s: any) => ({
      id: s.id, says: s.says, decide: s.decide, witness: s.world.features, edits: s.world.edits, payment: s.world.payment, lands: s.world.lands,
      B: s.history.B, C: s.history.C, test: { cases: s.record.all.cases, families: s.record.all.families },
    })),
    certificates: map.certificates.map((c: any) => ({ company: c.company, from: c.from, to: c.to, liveFrom: c.liveFrom, changes: c.changes.length, fixed: c.fixedOnRecord, newlyWrongAlone: c.newlyWrongAlone, handedBack: c.handedBack, noLabel: c.changesWithNoEvidence, aloneNeverDecided: c.actsAloneWhereUnseen.length, aloneNeverLabeled: c.actsAloneWhereUnlabeled.length, changed: c.changes.map((x: any) => ({ id: x.situation, from: x.from, to: x.to, decided: x.everDecided, labeled: x.labeledByPeople })) })),
  },
  timeline: Object.fromEntries([['B', tb], ['C', tc]].map(([k, t]: any) => [k, { decisions: t.decisions, from: t.from, to: t.to, asRun: t.asRun, byDay: [1, 2, 3].map(m => t[`noHindsight_${m}`]), mistakesAlone: t.mistakesAlone, inUnlabeled: t.mistakesInUnlabeledSituations, flags: t.flags }])),
  team: {
    invariant: team.invariant, axiomsCheckedOn: team.axiomsCheckedOn, properties: team.properties, realBooks: team.realBooks,
    variants: team.results.map((r: any) => ({ name: r.variant, adopted: r.adopted, proved: Object.fromEntries(Object.entries(r.versions).map(([k, x]: any) => [k, Object.fromEntries(Object.entries(x).map(([p, y]: any) => [p, y.holds]))])), world: r.world, legit: r.legit })),
    legitCase: team.results[0].legit,
    ledger: { party: A.party, name: A.name, contract: A.contract, terms: A.terms, open: A.open.map((i: any) => ({ id: i.id, kind: i.kind, amountCents: i.amount_cents, openCents: i.open_cents, dueDate: i.due_at })) },
    rules: [...CONSTITUTION, ...ROLE_MATRIX].filter(r => r.tpl.t === 'role_can' ? (r.tpl as any).actions.some((a: string) => a === 'send_notice' || a === 'assess_fee') : ['send_notice', 'assess_fee'].includes((r.tpl as any).action)),
    learned: A.policies.map((p: any) => ({ id: p.id, version: 1, constitutional: false, tpl: p.template, text: p.text })),
    facts: Object.keys(FACT_LIBRARY),
  },
};
writeFileSync(new URL('./out/certify-site.json', import.meta.url), JSON.stringify(site));
console.log('certify-site.json', Math.round(JSON.stringify(site).length / 1024), 'KB;', site.map.situations.length, 'situations;', site.team.rules.length, 'kernel rules on notices and fees');
