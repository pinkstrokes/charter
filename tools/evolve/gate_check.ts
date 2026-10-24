// The replay gate's promises, checked on small made-up histories, offline: no
// database, no model. Each check is a way the gate was once fooled or could be.
//   npx tsx tools/evolve/gate_check.ts
import { outcomeFor, run, settlesAlone, type Expr, type FeatureMap, type SkillProgram, type Treatments } from '../../module/spacetimedb/src/core/dsl';
import { agrees, cleanestFirst, evaluate, splitLessons, type Domain, type Example, type History } from './skills';

const feat = (name: string): Expr => ({ op: 'feat', name });
const num = (v: number): Expr => ({ op: 'num', v });
const cmp = (c: 'eq' | 'gt' | 'le', a: Expr, b: Expr): Expr => ({ op: 'cmp', c, a, b });

let failed = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `  [${detail}]` : ''}`);
}

// Labeled cases and the history the gate replays them from.
function world(domain: Domain, cases: { features: FeatureMap; label: string; treatments?: Treatments }[]): { examples: Example[]; h: History } {
  const examples = cases.map((c, i) => ({ subject: `case:${i}`, features: c.features, label: c.label, treatments: c.treatments, source: 'check', reason: '', at: '2026-01-01' }));
  const decisions = examples.map((e, i) => ({ id: i + 1, at: e.at, seat: 'check', domain, subject: e.subject, features: JSON.stringify(e.features), skill_key: 'x@1', outcome: '', shadow: false, treatments: JSON.stringify(e.treatments ?? {}) }));
  return { examples, h: { skills: [], decisions, asks: [], audits: [] } };
}

function gate(domain: Domain, current: SkillProgram, candidate: SkillProgram, cases: Parameters<typeof world>[1]) {
  const { examples, h } = world(domain, cases);
  const { required, optional } = splitLessons(domain, current, examples);
  return evaluate(domain, current, candidate, examples, required, h, new Set(), optional, false);
}

const repeat = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);

// ---- 1. A new mistake is weighed only against cases where one could happen ----
// Cases the current version already got wrong, and the candidate gets wrong differently,
// are no evidence that its new decisions are sound.
{
  const overdue: FeatureMap = { days_past_due: 20, grace_days: 10, open_amount: 50000, unapplied_amount: 0, announced_payment: 0, open_credit_notes: 0, open_dispute: false, recent_return: true, bank_change_recent: false, notices_last_30d: 0 };
  const current: SkillProgram = { domain: 'pre_chase', rules: [], otherwise: { decide: 'chase' } };
  const candidate: SkillProgram = { domain: 'pre_chase', rules: [{ when: feat('recent_return'), then: { decide: 'hold' } }], otherwise: { decide: 'chase' } };
  const ev = gate('pre_chase', current, candidate, [...repeat(50, { features: overdue, label: 'escalate_controller' }), { features: overdue, label: 'chase' }, { features: overdue, label: 'hold' }]);
  check('a candidate wrong on 51 of its 52 new decisions fails', ev.gate === 'fail' && ev.why.some(w => w.startsWith('gets 1 case')), ev.why.join('; '));
}

// ---- 2. ...and, on a long enough record, a rare new mistake does not ----
{
  const overdue: FeatureMap = { days_past_due: 20, grace_days: 10, open_amount: 50000, unapplied_amount: 0, announced_payment: 0, open_credit_notes: 0, open_dispute: false, recent_return: false, bank_change_recent: false, notices_last_30d: 0 };
  const current: SkillProgram = { domain: 'pre_chase', rules: [], otherwise: { decide: 'escalate_controller' } };
  const candidate: SkillProgram = { domain: 'pre_chase', rules: [{ when: cmp('gt', feat('days_past_due'), feat('grace_days')), then: { decide: 'chase' } }], otherwise: { decide: 'escalate_controller' } };
  const long = gate('pre_chase', current, candidate, [...repeat(2000, { features: overdue, label: 'chase' }), { features: overdue, label: 'escalate_controller' }]);
  check('one disagreement in 2,001 takeovers passes at a 10% tolerable rate', long.gate === 'pass', long.why.join('; '));
  const short = gate('pre_chase', current, candidate, [...repeat(10, { features: overdue, label: 'chase' }), { features: overdue, label: 'escalate_controller' }]);
  check('one disagreement in 11 takeovers fails', short.gate === 'fail', short.why.join('; '));
}

// ---- 3. An outcome that cannot act is asking, whatever it is called ----
// "Apply the unique set" when no set fits hands the receipt to a person; it must not
// slip past the evidence that handing work back requires, nor be labeled as acting.
{
  const duplicate: FeatureMap = { solution_count: 0, exact_match: false, residual_cents: 5000, remittance_present: false, remittance_consistent: false, receipt_amount: 5000, reference_paid: true, reference_matches_open: false, reference_names_open: false, reference_gap_cents: 0, open_items: 3 };
  const treatments: Treatments = { apply_unique: 'ask', apply_to_reference: 'ask', apply_by_terms: 'INV-9', leave_unapplied_ask: 'ask' };
  const byTerms = { when: cmp('eq', feat('solution_count'), num(0)), then: { decide: 'apply_by_terms' } };
  const current: SkillProgram = { domain: 'allocation', rules: [byTerms], otherwise: { decide: 'leave_unapplied_ask' } };
  const asking = (decide: string): SkillProgram => ({ domain: 'allocation', rules: [{ when: feat('reference_paid'), then: { decide } }, byTerms], otherwise: { decide: 'leave_unapplied_ask' } });
  check('paying "the unique set" with no set to pay is asking', !settlesAlone('allocation', 'apply_unique', treatments) && settlesAlone('allocation', 'apply_by_terms', treatments));
  check('"should have asked" is labeled as asking, by its own name', outcomeFor(treatments, 'ask', 'leave_unapplied_ask') === 'leave_unapplied_ask');
  for (const n of [2, 4]) {
    const cases = repeat(n, { features: duplicate, label: 'leave_unapplied_ask', treatments });
    const honest = gate('allocation', current, asking('leave_unapplied_ask'), cases);
    const phantom = gate('allocation', current, asking('apply_unique'), cases);
    check(`on ${n} duplicates, a phantom ask is judged exactly as asking (${honest.gate})`, honest.gate === phantom.gate && honest.value === phantom.value && honest.gate === (n >= 3 ? 'pass' : 'fail'), `${honest.gate}/${phantom.gate}, value ${honest.value}/${phantom.value}`);
  }
}

// ---- 4. Two outcomes that put the money in the same place agree ----
{
  const same: Treatments = { apply_unique: 'ask', apply_to_reference: 'INV-1', apply_by_terms: 'INV-1', leave_unapplied_ask: 'ask' };
  const apart: Treatments = { apply_unique: 'ask', apply_to_reference: 'INV-1', apply_by_terms: 'INV-0', leave_unapplied_ask: 'ask' };
  check('"by terms" and "the named invoice" agree when both pay INV-1', agrees('allocation', 'apply_by_terms', 'apply_to_reference', same));
  check('...and disagree when they pay different invoices', !agrees('allocation', 'apply_by_terms', 'apply_to_reference', apart));
}

// ---- 5. Ordering interchangeable rules never changes a decision or who is asked ----
{
  const rnd = (() => {
    let s = 7;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  })();
  const program: SkillProgram = {
    domain: 'pre_chase',
    rules: [
      { when: cmp('le', feat('days_past_due'), num(30)), then: { decide: 'hold', note: 'broad' } },
      { when: cmp('le', feat('days_past_due'), num(5)), then: { decide: 'hold', note: 'narrow' } },
      { when: feat('open_dispute'), then: { decide: 'ask_consultant', askRole: 'consultant' } },
      { when: feat('recent_return'), then: { decide: 'ask_consultant', askRole: 'controller' } },
      { when: cmp('gt', feat('announced_payment'), num(0)), then: { decide: 'ask_consultant', askRole: 'controller' } },
    ],
    otherwise: { decide: 'chase' },
  };
  const cases = Array.from({ length: 400 }, () => ({
    features: { days_past_due: Math.floor(rnd() * 60), grace_days: 10, open_amount: 50000, unapplied_amount: 0, announced_payment: rnd() < 0.3 ? 10000 : 0, open_credit_notes: 0, open_dispute: rnd() < 0.3, recent_return: rnd() < 0.3, bank_change_recent: false, notices_last_30d: 0 },
    label: rnd() < 0.5 ? 'hold' : 'chase',
  }));
  const { examples } = world('pre_chase', cases);
  const ordered = cleanestFirst('pre_chase', program, examples);
  const same = examples.every(e => {
    const a = run(program, e.features).outcome;
    const b = run(ordered, e.features).outcome;
    return a.decide === b.decide && (a.askRole ?? '') === (b.askRole ?? '');
  });
  check('reordering interchangeable rules changes no decision and no one who is asked', same, ordered.rules.map(r => `${r.then.decide}/${r.then.askRole ?? '-'}`).join(', '));
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
