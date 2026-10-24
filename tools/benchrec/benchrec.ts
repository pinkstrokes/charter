// BenchRec: a Tier-1 institution's real cash account (CC BY 4.0, Kaggle
// benchmarkteam/benchrec-real-world-cash-reconciliation-dataset). Every bank
// line must be given the ledger allocation it belongs to; a submission counts
// only if its precision clears 99.8%, and then match rate decides.
//
// The bank desk starts with the one match every reconciliation clerk makes
// first and learns the rest from the institution's own history, the way every
// desk in Charter learns. Month by month the seat decides each train line as it
// arrives; a line it asked about or matched wrongly is a lesson, with the
// reconciliation team's recorded match as the answer; the same evolver
// proposes, the same gate replays every candidate over every line matched so
// far, and a version that passes takes over. Each rule of the final version then
// earns its autonomy as every rule in Charter does, on the train months after
// that version took over: it acts alone unless its record there proves, at 95%,
// that it is wrong more often than the 0.2% the benchmark tolerates, and then
// its lines go to a person. The eval split is scored once, against the solution file.
//   npx tsx tools/benchrec/benchrec.ts --data <folder with the BenchRec CSVs>
// tools/benchrec/monthly.ts reuses the scoring below month by month, without learning.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ASKS, outcomeFor, run, TOLERABLE, type Expr, type FeatureMap, type SkillProgram, type Treatments } from '../../module/spacetimedb/src/core/dsl';
import { lower95, upper95 } from '../../module/spacetimedb/src/core/stats';
import { examplesFor, improve, splitLessons, type History } from '../evolve/skills';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');
export const DIR = args.get('data') ?? 'data/benchrec';
const MODEL = args.get('model') ?? 'qwen3.8-max';
const NEAR_DAYS = 3;

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n') row.push(field.replace(/\r$/, '')), rows.push(row), (row = []), (field = '');
    else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ''])));
}

export interface Ledger {
  id: string;
  cents: number;
  valueDate: string;
  importDate: string;
  allocation: string;
}
export interface Bank {
  id: string;
  cents: number;
  valueDate: string;
  importDate: string;
  truth: string[]; // allocations it belongs to (train only)
}

const cents = (s: string) => Math.round(parseFloat(s || '0') * 100);
const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
const shift = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
export const allocations = (label: string) => (label.startsWith('[') ? label.slice(1, -1).split(/,(?=USD_)/) : label ? [label] : []).map(x => x.trim());

export function load(file: string): { ledger: Ledger[]; bank: Bank[] } {
  const rows = parseCsv(readFileSync(`${DIR}/${file}`, 'utf8'));
  const ledger: Ledger[] = [];
  const bank: Bank[] = [];
  for (const r of rows) {
    if (r.A_id) ledger.push({ id: r.A_id, cents: cents(r.A_amount), valueDate: r.A_valueDate, importDate: r.A_importDate, allocation: r.A_allocation.trim() });
    if (r.B_id) bank.push({ id: r.B_id, cents: cents(r.B_amount), valueDate: r.B_valueDate, importDate: r.B_importDate, truth: allocations(r.targetAllocation) });
  }
  return { ledger, bank };
}

// What the seat sees for one bank line, and the allocation each outcome would give it.
export function linesOf(ledger: Ledger[], bank: Bank[]): Map<string, { f: FeatureMap; t: Treatments }> {
  const byDayAmount = new Map<string, Ledger[]>();
  const byDayAllocation = new Map<string, Map<string, number>>();
  for (const a of ledger) {
    const k = `${a.valueDate}|${a.cents}`;
    (byDayAmount.get(k) ?? byDayAmount.set(k, []).get(k)!).push(a);
    const day = byDayAllocation.get(a.valueDate) ?? byDayAllocation.set(a.valueDate, new Map()).get(a.valueDate)!;
    day.set(a.allocation, (day.get(a.allocation) ?? 0) + a.cents);
  }
  const exactOf = (b: Bank) => byDayAmount.get(`${b.valueDate}|${b.cents}`) ?? [];
  const claims = new Map<string, number>();
  for (const b of bank) for (const a of exactOf(b)) claims.set(a.id, (claims.get(a.id) ?? 0) + 1);
  const out = new Map<string, { f: FeatureMap; t: Treatments }>();
  for (const b of bank) {
    const exact = exactOf(b);
    const exactAllocs = [...new Set(exact.map(a => a.allocation))];
    const group = [...(byDayAllocation.get(b.valueDate) ?? new Map<string, number>()).entries()].filter(([alloc, sum]) => sum === b.cents && !exactAllocs.includes(alloc)).map(([alloc]) => alloc);
    const near = new Set<string>();
    for (let d = -NEAR_DAYS; d <= NEAR_DAYS; d++) if (d !== 0) for (const a of byDayAmount.get(`${shift(b.valueDate, d)}|${b.cents}`) ?? []) near.add(a.allocation);
    out.set(b.id, {
      f: {
        exact_allocations: exactAllocs.length,
        exact_lines: exact.length,
        contested: exact.some(a => (claims.get(a.id) ?? 0) > 1),
        import_gap_days: exact.length ? Math.min(...exact.map(a => Math.abs(days(a.importDate, b.importDate)))) : 999,
        group_allocations: group.length,
        near_allocations: near.size,
      },
      t: { match_exact: exactAllocs[0] ?? ASKS, match_group: group[0] ?? ASKS, match_near: [...near][0] ?? ASKS, ask: ASKS },
    });
  }
  return out;
}

const feat = (name: string): Expr => ({ op: 'feat', name });
const num = (v: number): Expr => ({ op: 'num', v });
const cmp = (c: 'eq' | 'le', a: Expr, b: Expr): Expr => ({ op: 'cmp', c, a, b });
const and = (...args: Expr[]): Expr => ({ op: 'and', args });
const not = (a: Expr): Expr => ({ op: 'not', a });

// Day 0: the match every reconciliation clerk makes first.
export const DAY0: SkillProgram = {
  domain: 'bank_match',
  rules: [{ when: cmp('eq', feat('exact_allocations'), num(1)), then: { decide: 'match_exact', note: 'one ledger allocation on the value date has exactly this amount' } }],
  otherwise: { decide: 'ask', note: 'a person matches it' },
};

// Written by hand before the desk learned its own, and kept only as a yardstick.
export const HANDWRITTEN: SkillProgram = {
  domain: 'bank_match',
  rules: [
    { when: and(cmp('eq', feat('exact_allocations'), num(1)), not(feat('contested')), cmp('le', feat('import_gap_days'), num(14))), then: { decide: 'match_exact' } },
    { when: and(cmp('eq', feat('exact_allocations'), num(1)), not(feat('contested'))), then: { decide: 'match_exact' } },
    { when: and(cmp('eq', feat('exact_allocations'), num(1)), cmp('le', num(2), feat('exact_lines'))), then: { decide: 'match_exact' } },
    { when: cmp('eq', feat('exact_allocations'), num(1)), then: { decide: 'match_exact' } },
    { when: and(cmp('eq', feat('exact_allocations'), num(0)), cmp('eq', feat('group_allocations'), num(1))), then: { decide: 'match_group' } },
    { when: and(cmp('eq', feat('exact_allocations'), num(0)), cmp('eq', feat('group_allocations'), num(0)), cmp('eq', feat('near_allocations'), num(1))), then: { decide: 'match_near' } },
  ],
  otherwise: { decide: 'ask' },
};

// The person's match in the seat's spelling: the allocation an outcome gives, when one does.
const answerOf = (b: Bank, t: Treatments) => b.truth.find(a => Object.values(t).includes(a)) ?? b.truth.join(' + ');

async function learn(bank: Bank[], lines: Map<string, { f: FeatureMap; t: Treatments }>) {
  const h: History = { skills: [], decisions: [], asks: [], audits: [] };
  const none = new Set<string>();
  let program = DAY0;
  const history = bank.filter(b => b.truth.length).sort((a, b) => a.importDate.localeCompare(b.importDate) || a.id.localeCompare(b.id));
  const byMonth = new Map<string, Bank[]>();
  for (const b of history) (byMonth.get(b.importDate.slice(0, 7)) ?? byMonth.set(b.importDate.slice(0, 7), []).get(b.importDate.slice(0, 7))!).push(b);
  const versions: { version: number; from: string; program: SkillProgram; origin: string; lessonsHandled: number; lessons: number; tookOver: number; candidates: number; passed: number }[] = [
    { version: 1, from: history[0].importDate.slice(0, 7), program: DAY0, origin: 'day 0', lessonsHandled: 0, lessons: 0, tookOver: 0, candidates: 0, passed: 0 },
  ];
  const months: { month: string; lines: number; alone: number; wrong: number; version: number }[] = [];
  let id = 0;
  for (const [month, arriving] of byMonth) {
    const version = versions.length;
    let alone = 0;
    let wrong = 0;
    for (const b of arriving) {
      const { f, t } = lines.get(b.id)!;
      const decided = run(program, f).outcome.decide;
      const subject = `bank:${b.id}`;
      h.decisions.push({ id: ++id, at: b.importDate, seat: 'bank_rec', domain: 'bank_match', subject, features: JSON.stringify(f), skill_key: `bank_match@${version}`, outcome: decided, shadow: false, treatments: JSON.stringify(t) });
      // Every line of the history was reconciled by a person: a line the seat asked
      // about carries their match, a line it matched is checked against it.
      const done = answerOf(b, t);
      const ok = decided !== 'ask' && b.truth.includes(t[decided]);
      if (decided !== 'ask') (alone++, (wrong += ok ? 0 : 1));
      h.asks.push({
        id: ++id, created_at: b.importDate, kind: decided === 'ask' ? 'bank_match' : 'spot_check:bank_match', subject, status: 'answered',
        evidence: JSON.stringify({ features: f, treatments: t, decided }), answer: decided === 'ask' ? done : ok ? 'correct' : outcomeFor(t, done, 'ask'),
        reason: 'the reconciliation team matched it', answered_by: 'reconciliation team', answered_at: b.importDate,
      });
    }
    months.push({ month, lines: arriving.length, alone, wrong, version });
    // Month end: what the team matched this month is the lesson.
    const examples = examplesFor(h, 'bank_match', none);
    const { required, optional } = splitLessons('bank_match', program, examples);
    if (!required.length && !optional.length) continue;
    const t0 = Date.now();
    const { scored, passing } = await improve(MODEL, 'bank_match', program, examples, required, optional, h, none);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (!passing.length) {
      console.log(`${month}: ${required.length} lessons, ${optional.length} cases people matched; ${scored.length} candidates in ${secs}s, none passed: ${scored[0]?.ev.why.join('; ') ?? 'nothing usable'}`);
      continue;
    }
    const best = passing[0];
    program = best.program;
    versions.push({ version: versions.length + 1, from: month, program, origin: best.origin, lessonsHandled: best.ev.lesson.handled.length, lessons: required.length, tookOver: best.ev.lesson.optionalFixed, candidates: scored.length, passed: passing.length });
    console.log(`${month}: v${versions.length} in ${secs}s (${passing.length}/${scored.length} passed): handles ${best.ev.lesson.handled.length}/${required.length} lessons, takes over ${best.ev.lesson.optionalFixed}/${optional.length}, ${program.rules.length} rules`);
  }
  return { program, versions, months };
}

// Each rule's record on the train months after the final version took over, which
// no version was fitted to, and the state earned autonomy gives it there (as in
// reliability.ts): suspended when 95% sure it is worse than tolerable, reduced
// inspection when 95% sure it is better, otherwise inspected; only a suspended
// rule's lines go to a person.
export function autonomy(program: SkillProgram, bank: Bank[], lines: Map<string, { f: FeatureMap; t: Treatments }>, after: string) {
  const record = program.rules.map(() => ({ n: 0, wrong: 0 }));
  for (const b of bank) {
    if (!b.truth.length || b.importDate.slice(0, 7) <= after) continue;
    const { f, t } = lines.get(b.id)!;
    const r = run(program, f);
    if (r.trace.ruleIndex < 0 || r.outcome.decide === 'ask') continue;
    record[r.trace.ruleIndex].n++;
    if (!b.truth.includes(t[r.outcome.decide])) record[r.trace.ruleIndex].wrong++;
  }
  const tolerable = TOLERABLE.bank_match;
  return record.map(s => {
    const state = s.n >= 5 && lower95(s.wrong, s.n) > tolerable ? 'suspended' : s.n >= 40 && upper95(s.wrong, s.n) <= tolerable ? 'reduced' : 'inspected';
    return { ...s, upper95: Number(upper95(s.wrong, s.n).toFixed(5)), lower95: Number(lower95(s.wrong, s.n).toFixed(5)), state, actsAlone: state !== 'suspended' };
  });
}

export function score(program: SkillProgram, record: ReturnType<typeof autonomy>, bank: Bank[], lines: Map<string, { f: FeatureMap; t: Treatments }>, solution: Map<string, string[]>) {
  let matched = 0;
  let correct = 0;
  const submission: string[] = ['B_id,targetAllocation'];
  for (const b of bank) {
    if (!solution.has(b.id)) continue;
    const { f, t } = lines.get(b.id)!;
    const r = run(program, f);
    const alloc = r.trace.ruleIndex >= 0 && record[r.trace.ruleIndex].actsAlone && t[r.outcome.decide] !== ASKS ? t[r.outcome.decide] : '';
    submission.push(`"${b.id}","${alloc ? `[${alloc}]` : '[]'}"`);
    if (!alloc) continue;
    matched++;
    if (solution.get(b.id)!.includes(alloc)) correct++;
  }
  const total = solution.size;
  return { result: { bankLines: total, matched, correct, precision: matched ? correct / matched : null, matchRate: matched / total, clearsFloor: matched > 0 && correct / matched > 1 - TOLERABLE.bank_match }, submission };
}

// A matcher's submission rows (B_id, targetAllocation), scored on the solution's lines: a line it
// gave allocations to is matched, and correct when every one of them is the solution's.
export function scoreBaseline(rows: Record<string, string>[], solution: Map<string, string[]>) {
  const baseline = { matched: 0, correct: 0 };
  for (const r of rows) {
    const truth = solution.get(r.B_id);
    if (!truth) continue;
    let picked: string[] = [];
    try {
      picked = (JSON.parse(r.targetAllocation || '[]') as string[]).map(x => x.trim());
    } catch {
      picked = allocations(r.targetAllocation);
    }
    if (!picked.length) continue;
    baseline.matched++;
    if (picked.every(p => truth.includes(p))) baseline.correct++;
  }
  return baseline;
}

async function main(): Promise<void> {
  for (const f of ['BenchRec_cash_v1.0_train.csv', 'BenchRec_cash_v1.0_eval.csv', 'BenchRec_cash_v1.0_solution.csv'])
    if (!existsSync(`${DIR}/${f}`)) throw new Error(`${DIR}/${f} is missing; download it from https://www.kaggle.com/datasets/benchmarkteam/benchrec-real-world-cash-reconciliation-dataset`);
  const train = load('BenchRec_cash_v1.0_train.csv');
  const trainLines = linesOf(train.ledger, train.bank);
  // 1. Learn from the reconciliation history.
  const learned = await learn(train.bank, trainLines);
  // 2. Score the locked eval split once: day 0, the learned desk, and the hand-written yardstick.
  const evalSet = load('BenchRec_cash_v1.0_eval.csv');
  const evalLines = linesOf(evalSet.ledger, evalSet.bank);
  const solution = new Map(parseCsv(readFileSync(`${DIR}/BenchRec_cash_v1.0_solution.csv`, 'utf8')).map(r => [r.B_id, allocations(r.targetAllocation)]));
  // Every desk earns its autonomy on the same months: those after the learned version took over.
  const after = learned.versions[learned.versions.length - 1].from;
  const desk = (program: SkillProgram) => {
    const record = autonomy(program, train.bank, trainLines, after);
    const { result, submission } = score(program, record, evalSet.bank, evalLines, solution);
    return { rules: program.rules.map((r, i) => ({ rule: i, decide: r.then.decide, note: r.then.note ?? '', train: record[i] })), eval: result, submission };
  };
  const day0 = desk(DAY0);
  const final = desk(learned.program);
  const handwritten = desk(HANDWRITTEN);
  // 3. The matcher shipped with the dataset, scored the same way.
  const baseline = existsSync(`${DIR}/MatcherByChatGPT_submission.csv`) ? scoreBaseline(parseCsv(readFileSync(`${DIR}/MatcherByChatGPT_submission.csv`, 'utf8')), solution) : null;
  const result = {
    dataset: 'BenchRec cash v1.0 (Kaggle benchmarkteam, CC BY 4.0)',
    floor: 1 - TOLERABLE.bank_match,
    method: 'day-0 skill of one rule; month by month over the train history the seat decides each line, the reconciliation team\'s recorded match is the lesson, the evolver proposes and the replay gate accepts; each rule earns autonomy on the train months after the final version took over (the same months for every desk): suspended, and its lines sent to a person, when 95% sure its error rate is over 0.2%',
    autonomyFrom: after,
    months: learned.months,
    versions: learned.versions.map(v => ({ ...v, program: undefined, rules: v.program.rules.map(r => ({ when: r.when, decide: r.then.decide, note: r.then.note ?? '' })) })),
    day0: { rules: day0.rules, eval: day0.eval },
    learned: { rules: final.rules, eval: final.eval },
    handwritten: { rules: handwritten.rules, eval: handwritten.eval },
    baseline: baseline && { name: 'MatcherByChatGPT_submission.csv (shipped with the dataset)', matched: baseline.matched, correct: baseline.correct, precision: baseline.matched ? baseline.correct / baseline.matched : null, matchRate: baseline.matched / solution.size },
  };
  mkdirSync('data/benchrec_eval', { recursive: true });
  writeFileSync('data/benchrec_eval/result.json', JSON.stringify(result, null, 1));
  writeFileSync('data/benchrec_eval/submission.csv', final.submission.join('\n') + '\n');
  console.log(JSON.stringify({ day0: day0.eval, learned: final.eval, handwritten: handwritten.eval, baseline: result.baseline, versions: learned.versions.length }, null, 1));
}

// Learn and score only when run as a script, not when monthly.ts imports the scoring.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
