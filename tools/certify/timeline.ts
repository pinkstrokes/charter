// npx tsx tools/certify/timeline.ts
//
// Replays company B's 1,225 cash decisions in the order they were made and asks what would have
// happened under three ways of deciding when the seat may act without a person:
//   as run      what Charter did: autonomy earned rule by rule;
//   situations  autonomy earned situation by situation on the competence map: the seat acts alone
//               in a situation only once a person has confirmed what it would do there and nobody
//               has contradicted it; otherwise it asks, and the answer becomes evidence;
// Under the second rule, the first question in each situation can be asked before any payment waits
// for it: the map knows the situation before the payment arrives. The replay counts those apart.
// People answer from the answer key, as they did in the runs. A label counts from the day of the
// decision it labels. Nothing here is learned again: the skill versions and their dates are the run's.

import { init } from 'z3-solver';
import { readFileSync, writeFileSync } from 'node:fs';
import { allocationAxioms } from './axioms';
import { competenceMap, type Case } from './map';
import { run, settlesAlone } from '../../module/spacetimedb/src/core/dsl';

const D = JSON.parse(readFileSync(`${process.env.HOME}/Developer/charter-showcase/data.json`, 'utf8'));
const co = (process.argv[2] ?? 'B').toUpperCase() as 'B' | 'C';
const decisions: any[] = JSON.parse(readFileSync(new URL(`./data/decisions-${co.toLowerCase()}.json`, import.meta.url), 'utf8'));
const { Context } = await init();
const Z3 = Context('main');
const versions: Record<string, any> = {};
for (const c of ['b', 'c']) for (const v of D[c].versions) versions[`${c.toUpperCase()}:${v.key}`] = v.program;
const all: Case[] = decisions.map(d => ({ id: String(d.id), f: d.f }));
const map = await competenceMap(Z3, 'allocation', versions, allocationAxioms(Z3, 2500), all);
const cellOf = new Map<string, string>();
for (const cell of map.cells) for (const id of cell.cases) cellOf.set(id, cell.id);
// Without hindsight: a situation as it could be told apart on the day, from the conditions of the
// versions live by then (a version's atoms are known from the day it goes live).
import { vocabulary } from './encode';
const liveOrder = [...new Set([...decisions].sort((x, y) => x.at.localeCompare(y.at) || x.id - y.id).map(d => d.skill.split('+')[0]))];
const vocabAt = new Map<string, any[]>();
liveOrder.forEach((k, i) => vocabAt.set(k, vocabulary(liveOrder.slice(0, i + 1).map(kk => (co === 'B' ? D.b : D.c).versions.find((v: any) => v.key === kk).program))));
const holdsAtom = (atom: any, f: any) => run({ domain: 'allocation', rules: [{ when: atom, then: { decide: 'y' } }], otherwise: { decide: 'n' } } as any, f).outcome.decide === 'y';
const keyAt = (d: any, version: string) => vocabAt.get(version)!.map(a => (holdsAtom(a, d.f) ? '1' : '0')).join('') + '@' + vocabAt.get(version)!.length;

const landing = (truth: string[]) => (truth.length ? [...truth].sort().join(' + ') : 'ask');
// The outcome a person would choose: the one that lands where the payer meant, or asking when none does.
const answerOf = (d: any) => Object.keys(d.t).find(o => o !== 'leave_unapplied_ask' && d.t[o] === landing(d.truth)) ?? 'leave_unapplied_ask';
const rightOf = (d: any, outcome: string) => d.t[outcome] === (Object.values(d.t).includes(landing(d.truth)) ? landing(d.truth) : 'ask');
const alone = (d: any, outcome: string) => settlesAlone('allocation', outcome, d.t);
const agrees = (d: any, a: string, b: string) => d.t[a] === d.t[b];
const ordered = [...decisions].sort((x, y) => x.at.localeCompare(y.at) || x.id - y.id);
// A decision made by a precedent on top of a version ('allocation@2+precedent#4179') is judged by that version.
const progOf = (key: string) => (co === 'B' ? D.b : D.c).versions.find((v: any) => v.key === key.split('+')[0]).program;

interface Tally { wrongAlone: number; asks: number; checks: number; rightAlone: number; firstAsks: number }
function simulate(mode: 'run' | 'situations', minAgree: number, hindsight = true) {
  const tally: Tally = { wrongAlone: 0, asks: 0, checks: 0, rightAlone: 0, firstAsks: 0 };
  const askedIn = new Set<string>();
  // Evidence per situation: what people said was right on cases there, kept with the case.
  const evidence = new Map<string, any[]>();
  const add = (cell: string, d: any, said: string) => { const e = evidence.get(cell) ?? []; e.push({ d, said }); evidence.set(cell, e); };
  for (const d of ordered) {
    const cell = hindsight ? cellOf.get(String(d.id))! : keyAt(d, d.skill.split('+')[0]);
    const outcome = d.outcome;
    if (mode === 'run') {
      if (alone(d, outcome)) { if (rightOf(d, outcome)) tally.rightAlone++; else tally.wrongAlone++; } else tally.asks++;
      if ((d.labelSource || '').startsWith('spot_check')) tally.checks++;
      continue;
    }
    // The seat acts alone only where people have confirmed what it would do and nobody has said otherwise.
    const ev = hindsight ? evidence.get(cell) ?? [] : [...evidence.values()].flat().filter(e => keyAt(e.d, d.skill.split('+')[0]) === cell);
    const agreeing = ev.filter(e => agrees(e.d, e.said, run(progOf(d.skill), e.d.f).outcome.decide)).length;
    const earned = agreeing >= minAgree && agreeing === ev.length;
    if (alone(d, outcome) && earned) {
      if (rightOf(d, outcome)) tally.rightAlone++; else tally.wrongAlone++;
      // Spot checks that happened in the run keep happening, on the same decisions.
      if (mode === 'situations' && (d.labelSource || '').startsWith('spot_check')) { tally.checks++; add(cell, d, answerOf(d)); }
    } else {
      tally.asks++;
      if (!askedIn.has(cell)) { askedIn.add(cell); tally.firstAsks++; }
      add(cell, d, answerOf(d));
    }
  }
  return tally;
}
const out: any = { company: co, decisions: ordered.length, from: ordered[0].at, to: ordered.at(-1).at, situations: map.cells.length };
out.asRun = simulate('run', 1);
for (const m of [1, 2, 3]) out[`situations_${m}`] = simulate('situations', m);
for (const m of [1, 2, 3]) out[`noHindsight_${m}`] = simulate('situations', m, false);
// Exposure: the mistakes made alone, and whether a person had ever labeled their situation when they were made.
const labeledBefore = (cell: string, at: string) => ordered.some(x => x.label && x.at < at && cellOf.get(String(x.id)) === cell);
const mistakes = ordered.filter(d => alone(d, d.outcome) && !rightOf(d, d.outcome));
out.mistakesAlone = mistakes.length;
out.mistakesInUnlabeledSituations = mistakes.filter(d => !labeledBefore(cellOf.get(String(d.id))!, d.at)).length;
out.mistakes = mistakes.map(d => ({ at: d.at, subject: d.subject, family: d.family, situation: cellOf.get(String(d.id)), skill: d.skill, outcome: d.outcome, labeledBefore: labeledBefore(cellOf.get(String(d.id))!, d.at) }));
// What each version's certificate flagged when it went live (situations where it settles alone and no person had
// labeled anything), and what then happened in those situations while it was live.
const vs = [...new Set(ordered.map(d => d.skill.split('+')[0]))];
out.flags = vs.map(key => {
  const mine = ordered.filter(d => d.skill.split('+')[0] === key), live = mine[0].at, p = progOf(key);
  const flagged = map.cells.filter(c => run(p, c.witness).outcome.decide !== 'leave_unapplied_ask' && !labeledBefore(c.id, live)).map(c => c.id);
  const inFlagged = mine.filter(d => flagged.includes(cellOf.get(String(d.id))!));
  const wrong = inFlagged.filter(d => alone(d, d.outcome) && !rightOf(d, d.outcome));
  return { version: key, live, decisions: mine.length, flagged: flagged.length, decisionsInFlagged: inFlagged.length, mistakesInFlagged: wrong.length, flaggedWithMistakes: [...new Set(wrong.map(d => cellOf.get(String(d.id))))] };
});
writeFileSync(new URL(`./out/timeline-${co.toLowerCase()}.json`, import.meta.url), JSON.stringify(out, null, 1));
const md: string[] = [`# ${co}: earning autonomy situation by situation`, '', `${out.decisions} cash decisions, ${out.from} to ${out.to}, replayed in order with the run's own skill versions and dates. People answer from the answer key, as in the run; a label counts from the day of the decision it labels.`, '', '| rule for acting alone | wrong with nobody asked | questions | of which first in their situation |', '|---|---|---|---|'];
md.push(`| as run (by rule) | ${out.asRun.wrongAlone} | ${out.asRun.asks} | — |`);
for (const m of [1, 2, 3]) md.push(`| by situation as known on the day, ${m} confirmation${m > 1 ? 's' : ''} and none against | ${out[`noHindsight_${m}`].wrongAlone} | ${out[`noHindsight_${m}`].asks} | ${out[`noHindsight_${m}`].firstAsks} |`);
for (const m of [1, 2, 3]) md.push(`| by situation on the final map (hindsight), ${m} confirmation${m > 1 ? 's' : ''} | ${out[`situations_${m}`].wrongAlone} | ${out[`situations_${m}`].asks} | ${out[`situations_${m}`].firstAsks} |`);
md.push('', `Of the ${out.mistakesAlone} mistakes made alone as run, ${out.mistakesInUnlabeledSituations} came in situations no person had ever labeled when they were made. The first question in a situation can be asked before any payment waits for it: the map lists the situation in advance.`, '', '| version | live from | decisions | situations flagged at go-live | decisions there | mistakes there |', '|---|---|---|---|---|---|');
for (const f of out.flags) md.push(`| ${f.version} | ${f.live} | ${f.decisions} | ${f.flagged} | ${f.decisionsInFlagged} | ${f.mistakesInFlagged}${f.flaggedWithMistakes.length ? ' (' + f.flaggedWithMistakes.join(', ') + ')' : ''} |`);
writeFileSync(new URL(`./out/timeline-${co.toLowerCase()}.md`, import.meta.url), md.join('\n') + '\n');
const row = (k: string, t: Tally) => console.log(k.padEnd(14), 'wrong alone', String(t.wrongAlone).padStart(3), ' asks', String(t.asks).padStart(4), ` (first in their situation ${t.firstAsks})`, ' checks', String(t.checks).padStart(4), ' right alone', String(t.rightAlone).padStart(5));
console.log(`${co}: ${out.decisions} decisions ${out.from} → ${out.to}, ${out.situations} situations`);
row('as run', out.asRun);
for (const m of [1, 2, 3]) row(`situations ${m}`, out[`situations_${m}`]);
for (const m of [1, 2, 3]) row(`on the day ${m}`, out[`noHindsight_${m}`]);
console.log(`mistakes made alone as run: ${out.mistakesAlone}; in situations no person had labeled when made: ${out.mistakesInUnlabeledSituations}`);
process.exit(0);
