// The competence map of a skill: every situation its versions can tell apart, found by the
// solver (none missed), each with what every version decides there and what the record says
// about it. A situation is an assignment of true/false to the skill's vocabulary, the atoms
// any of its versions ever tested; inside one, every version's decision is fixed.

import { DOMAINS, run, settlesAlone, type Expr, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { Encoder, vocabulary } from './encode';
import type { Axiom } from './axioms';

export interface Case { id: string; family?: string; f: Record<string, any>; t?: Record<string, string>; truth?: string[]; at?: string }
export interface Cell {
  id: string;
  literals: { atom: number; value: boolean }[];
  witness: Record<string, any>; // a feature map the solver built for this situation
  decide: Record<string, string>; // version key -> outcome
  cases: string[]; // recorded cases that fall here
}
export interface CompetenceMap { domain: string; vocab: Expr[]; cells: Cell[]; axioms: string[]; unsatisfiedByRecord: string[] }

const truthLanding = (c: Case) => (c.truth && c.truth.length ? [...c.truth].sort().join(' + ') : 'ask');
// Right: the money lands where the payer meant, or a person is asked when no outcome would put it there.
export function grade(outcome: string, c: Case): { right: boolean; alone: boolean } {
  const t = c.t ?? {}, truth = truthLanding(c);
  const right = t[outcome] === (Object.values(t).includes(truth) ? truth : 'ask');
  return { right, alone: settlesAlone('allocation', outcome, c.t) };
}
function holds(atom: Expr, f: Record<string, any>): boolean {
  return run({ domain: 'allocation', rules: [{ when: atom, then: { decide: 'yes' } }], otherwise: { decide: 'no' } } as any, f).outcome.decide === 'yes';
}

export async function competenceMap(Z3: any, domain: keyof typeof DOMAINS, versions: Record<string, SkillProgram>, axioms: Axiom[], record: Case[], limit = 5000): Promise<CompetenceMap> {
  const enc = new Encoder(Z3, domain);
  const vocab = vocabulary(Object.values(versions));
  const lits = vocab.map(a => enc.cond(a));
  const s = new Z3.Solver();
  s.add(...enc.ranges());
  const broken = axioms.filter(ax => record.some(c => !ax.holds(c.f))).map(ax => ax.id);
  for (const ax of axioms) if (!broken.includes(ax.id)) s.add(ax.f(enc));
  const cells: Cell[] = [];
  while (cells.length < limit && (await s.check()) === 'sat') {
    const m = s.model();
    const values = lits.map((l: any) => m.eval(l, true).toString() === 'true');
    const witness = enc.features(m);
    const decide: Record<string, string> = {};
    for (const [k, p] of Object.entries(versions)) decide[k] = run(p, witness).outcome.decide;
    cells.push({ id: 'S' + (cells.length + 1), literals: values.map((value, atom) => ({ atom, value })), witness, decide, cases: [] });
    s.add(Z3.Or(...lits.map((l: any, i: number) => (values[i] ? Z3.Not(l) : l))));
  }
  const key = (vals: boolean[]) => vals.map(v => (v ? '1' : '0')).join('');
  const byKey = new Map(cells.map(c => [key(c.literals.map(l => l.value)), c]));
  const orphans: string[] = [];
  for (const c of record) {
    const cell = byKey.get(key(vocab.map(a => holds(a, c.f))));
    if (cell) cell.cases.push(c.id); else orphans.push(c.id);
  }
  if (orphans.length) throw new Error(`${orphans.length} recorded cases fall in no situation the solver found (first ${orphans[0]}): the map is not complete`);
  return { domain, vocab, cells, axioms: axioms.filter(a => !broken.includes(a.id)).map(a => a.id), unsatisfiedByRecord: broken };
}
