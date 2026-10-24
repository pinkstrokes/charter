// BenchRec month by month: how often each desk would have missed the benchmark's
// 99.8% precision floor on the locked eval split, not only whether its pooled
// number clears it, and how sure that pooled precision is.
//
// Nothing is learned and no model is called. The desks are the ones result.json
// records: the day-0 rule, the learned final version (its rules as recorded there),
// the rules written by hand, each with the autonomy its rules earned on the train
// months after the final version took over (recomputed by benchrec.ts's own code and
// checked against result.json), and the matcher shipped with the dataset. Every group
// of eval lines is scored by benchrec.ts's score() and scoreBaseline(). A month is
// the bank line's import month, the desk's calendar, as in benchrec.ts; the bootstrap
// resamples whole import days.
//   npx tsx tools/benchrec/monthly.ts --data <folder with the BenchRec CSVs> [--resamples 2000] [--seed 1]
import { readFileSync, writeFileSync } from 'node:fs';
import { TOLERABLE, type Expr, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { allocations, autonomy, DAY0, DIR, HANDWRITTEN, linesOf, load, parseCsv, score, scoreBaseline, type Bank } from './benchrec';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');
const RESAMPLES = Number(args.get('resamples') ?? 2000);
const SEED = Number(args.get('seed') ?? 1);
const OUT = 'data/benchrec_eval';

// The floor as whole numbers: precision >= 99.8% exactly when wrong * 10^6 <= 2000 * matched.
const PER_MILLION = Math.round(TOLERABLE.bank_match * 1e6);
const clears = (matched: number, wrong: number) => matched > 0 && wrong * 1e6 <= PER_MILLION * matched;

type Recorded = { rules: { train: unknown }[]; eval: unknown };
const result = JSON.parse(readFileSync(`${OUT}/result.json`, 'utf8')) as {
  autonomyFrom: string;
  versions: { rules: { when: Expr; decide: string; note: string }[] }[];
  day0: Recorded;
  learned: Recorded;
  handwritten: Recorded;
  baseline: { matched: number; correct: number; precision: number; matchRate: number };
};
// result.json keeps each rule's when and decide; 'otherwise' is not kept and does not
// matter here: only a rule that fired can act alone, in autonomy() and in score().
const last = result.versions[result.versions.length - 1];
const LEARNED: SkillProgram = { domain: 'bank_match', rules: last.rules.map(r => ({ when: r.when, then: { decide: r.decide, note: r.note } })), otherwise: { decide: 'ask' } };

const DESKS = ['learned', 'day0', 'handwritten', 'baseline'] as const;
type Desk = (typeof DESKS)[number];
const NAMES: Record<Desk, string> = { learned: 'learned', day0: 'day 0', handwritten: 'hand-written', baseline: 'shipped matcher' };
type Score = { matched: number; correct: number };

const failures: string[] = [];
const same = (what: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${what}: ${JSON.stringify(got)} here, ${JSON.stringify(want)} in result.json`);
};

const train = load('BenchRec_cash_v1.0_train.csv');
const trainLines = linesOf(train.ledger, train.bank);
const evalSet = load('BenchRec_cash_v1.0_eval.csv');
const evalLines = linesOf(evalSet.ledger, evalSet.bank);
const solution = new Map(parseCsv(readFileSync(`${DIR}/BenchRec_cash_v1.0_solution.csv`, 'utf8')).map(r => [r.B_id, allocations(r.targetAllocation)]));
const shipped = parseCsv(readFileSync(`${DIR}/MatcherByChatGPT_submission.csv`, 'utf8'));
const shippedById = new Map<string, Record<string, string>[]>();
for (const r of shipped) (shippedById.get(r.B_id) ?? shippedById.set(r.B_id, []).get(r.B_id)!).push(r);

// Each desk as a scorer of any group of eval lines, checked first on the whole split.
const scorer = {} as Record<Desk, (bank: Bank[], sol: Map<string, string[]>) => Score>;
const pooled = {} as Record<Desk, Score>;
for (const [desk, program] of [['learned', LEARNED], ['day0', DAY0], ['handwritten', HANDWRITTEN]] as const) {
  const record = autonomy(program, train.bank, trainLines, result.autonomyFrom);
  same(`${desk} autonomy`, record, result[desk].rules.map(r => r.train));
  const whole = score(program, record, evalSet.bank, evalLines, solution);
  same(`${desk} eval`, whole.result, result[desk].eval);
  if (desk === 'learned' && whole.submission.join('\n') + '\n' !== readFileSync(`${OUT}/submission.csv`, 'utf8')) failures.push(`learned: the submission differs from ${OUT}/submission.csv`);
  scorer[desk] = (bank, sol) => score(program, record, bank, evalLines, sol).result;
  pooled[desk] = whole.result;
}
scorer.baseline = (bank, sol) => scoreBaseline(bank.flatMap(b => shippedById.get(b.id) ?? []), sol);
pooled.baseline = scoreBaseline(shipped, solution);
same('baseline eval', { ...pooled.baseline, precision: pooled.baseline.correct / pooled.baseline.matched, matchRate: pooled.baseline.matched / solution.size }, { matched: result.baseline.matched, correct: result.baseline.correct, precision: result.baseline.precision, matchRate: result.baseline.matchRate });

// Groups of eval lines, each scored on its own lines by the desks' own code.
function groups(key: (b: Bank) => string) {
  const by = new Map<string, Bank[]>();
  for (const b of evalSet.bank) if (solution.has(b.id)) (by.get(key(b)) ?? by.set(key(b), []).get(key(b))!).push(b);
  const out = [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, bank]) => {
      const sol = new Map(bank.map(b => [b.id, solution.get(b.id)!]));
      return { key: k, lines: sol.size, desks: Object.fromEntries(DESKS.map(d => [d, scorer[d](bank, sol)])) as Record<Desk, Score> };
    });
  // The groups must add up to the whole split.
  if (out.reduce((s, g) => s + g.lines, 0) !== solution.size) failures.push(`groups by ${key.name || 'key'}: lines do not add up to ${solution.size}`);
  for (const d of DESKS) {
    const matched = out.reduce((s, g) => s + g.desks[d].matched, 0);
    const correct = out.reduce((s, g) => s + g.desks[d].correct, 0);
    if (matched !== pooled[d].matched || correct !== pooled[d].correct) failures.push(`${d}: groups add up to ${correct}/${matched}, the whole split is ${pooled[d].correct}/${pooled[d].matched}`);
  }
  return out;
}

const stat = (s: Score, lines: number) => {
  const wrong = s.matched - s.correct;
  return {
    matched: s.matched,
    wrong,
    matchRate: s.matched / lines,
    precision: s.matched ? s.correct / s.matched : null,
    clearsFloor: s.matched ? clears(s.matched, wrong) : null, // null: it matched nothing
    wrongAllowed: Math.floor((s.matched * PER_MILLION) / 1e6), // the most mistakes that still clear the floor
  };
};
const table = (gs: ReturnType<typeof groups>, label: string) =>
  gs.map(g => ({ [label]: g.key, lines: g.lines, ...Object.fromEntries(DESKS.map(d => [d, stat(g.desks[d], g.lines)])) }));
const below = (rows: ReturnType<typeof table>, label: string) =>
  Object.fromEntries(DESKS.map(d => [d, rows.filter(r => (r[d] as ReturnType<typeof stat>).clearsFloor === false).map(r => r[label] as string)]));

const mondayOf = (d: string) => new Date(Date.parse(d) - ((new Date(d).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
const months = table(groups(function importMonth(b) { return b.importDate.slice(0, 7); }), 'month');
const valueMonths = table(groups(function valueMonth(b) { return b.valueDate.slice(0, 7); }), 'month');
const weeks = table(groups(function importWeek(b) { return mondayOf(b.importDate); }), 'week');
const days = groups(function importDay(b) { return b.importDate; });

// Bootstrap over whole import days, the same draws for every desk.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const quantile = (sorted: number[], p: number) => {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return sorted[lo] + (h - lo) * ((sorted[Math.min(lo + 1, sorted.length - 1)] ?? sorted[lo]) - sorted[lo]);
};
const rand = mulberry32(SEED);
const precisions = Object.fromEntries(DESKS.map(d => [d, [] as number[]])) as Record<Desk, number[]>;
const missed = Object.fromEntries(DESKS.map(d => [d, 0])) as Record<Desk, number>;
const winners = new Map<string, number>();
const gap: number[] = [];
for (let s = 0; s < RESAMPLES; s++) {
  const tot = Object.fromEntries(DESKS.map(d => [d, { matched: 0, correct: 0 }])) as Record<Desk, Score>;
  for (let i = 0; i < days.length; i++) {
    const day = days[Math.floor(rand() * days.length)];
    for (const d of DESKS) (tot[d].matched += day.desks[d].matched), (tot[d].correct += day.desks[d].correct);
  }
  for (const d of DESKS) {
    precisions[d].push(tot[d].correct / tot[d].matched);
    if (!clears(tot[d].matched, tot[d].matched - tot[d].correct)) missed[d]++;
  }
  // The benchmark's own ranking on this draw: the highest match rate among desks that clear the floor
  // (every desk is scored on the same lines, so the most lines matched).
  const eligible = DESKS.filter(d => clears(tot[d].matched, tot[d].matched - tot[d].correct));
  const winner = eligible.length ? eligible.reduce((a, b) => (tot[b].matched > tot[a].matched ? b : a)) : 'none';
  winners.set(winner, (winners.get(winner) ?? 0) + 1);
  gap.push(tot.learned.correct / tot.learned.matched - tot.day0.correct / tot.day0.matched);
}
const interval = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return { lo: quantile(sorted, 0.025), hi: quantile(sorted, 0.975) };
};
const bootstrap = {
  unit: 'whole import days (B_importDate), drawn with replacement; the same draws for every desk',
  days: days.length,
  resamples: RESAMPLES,
  seed: SEED,
  prng: 'mulberry32',
  interval: '2.5th and 97.5th percentiles of the resampled pooled precision (linear interpolation)',
  precision: Object.fromEntries(DESKS.map(d => [d, { pooled: pooled[d].correct / pooled[d].matched, ...interval(precisions[d]), belowFloorShare: missed[d] / RESAMPLES }])),
  learnedMinusDay0: interval(gap),
  benchmarkWinnerShare: Object.fromEntries([...DESKS, 'none'].map(d => [d, (winners.get(d) ?? 0) / RESAMPLES])),
};

if (failures.length) {
  console.error(`Not written: the reconstruction does not reproduce result.json:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}

const out = {
  dataset: 'BenchRec cash v1.0 (Kaggle benchmarkteam, CC BY 4.0), locked eval split',
  source: `the desks recorded in ${OUT}/result.json; every group scored by benchrec.ts score() and scoreBaseline(); nothing re-learned, no model called`,
  floor: { precision: 1 - TOLERABLE.bank_match, test: 'precision >= 99.8%, i.e. wrong <= matched / 500; benchrec.ts clearsFloor uses >, which differs only at exactly 99.8%' },
  checks: [
    'each rule\'s autonomy record on the train months after the final version took over equals result.json',
    'each desk\'s pooled eval numbers equal result.json',
    `the learned desk's submission equals ${OUT}/submission.csv line for line`,
    'the months (by import and by value date), weeks and days each add up to the pooled numbers',
  ],
  pooled: Object.fromEntries(DESKS.map(d => [d, stat(pooled[d], solution.size)])),
  monthOf: 'the bank line\'s import date (B_importDate), as in benchrec.ts',
  months,
  monthsBelowFloor: below(months, 'month'),
  byValueDate: { monthOf: 'the bank line\'s value date (B_valueDate)', months: valueMonths, monthsBelowFloor: below(valueMonths, 'month') },
  byWeek: { weekOf: 'the Monday of the bank line\'s import week', weeks, weeksBelowFloor: below(weeks, 'week') },
  bootstrap,
};
writeFileSync(`${OUT}/monthly.json`, JSON.stringify(out, null, 1));

// The same, readable.
const pct = (x: number | null, digits: number) => (x === null ? 'n/a' : `${(x * 100).toFixed(digits)}%`);
const cell = (s: ReturnType<typeof stat>) =>
  `${`${s.matched.toLocaleString('en-US')}/${s.wrong}`.padStart(13)} ${pct(s.matchRate, 1).padStart(6)} ${pct(s.precision, 3).padStart(8)} ${s.clearsFloor === null ? ' - ' : s.clearsFloor ? 'ok ' : 'NO '}`;
const print = (title: string, rows: { lines: number }[], label: string) => {
  console.log(`\n${title}\n${''.padEnd(18)}  ${DESKS.map(d => NAMES[d].padEnd(33)).join('  ')}`);
  console.log(`${label.padEnd(10)} ${'lines'.padStart(7)}  ${DESKS.map(() => `${'matched/wrong'.padStart(13)} ${'rate'.padStart(6)} ${'precis.'.padStart(8)} ≥fl`).join('  ')}`);
  for (const r of rows as Record<string, any>[]) console.log(`${String(r[label]).padEnd(10)} ${r.lines.toLocaleString('en-US').padStart(7)}  ${DESKS.map(d => cell(r[d])).join('  ')}`);
};
print('By import month', [...months, { month: 'pooled', lines: solution.size, ...out.pooled }], 'month');
print('By value month', valueMonths, 'month');
print('By import week', weeks, 'week');
console.log('\nBelow the floor (matched something, precision under 99.8%):');
for (const d of DESKS) console.log(`  ${NAMES[d].padEnd(16)} months ${out.monthsBelowFloor[d].join(', ') || 'none'} of ${months.filter(m => (m[d] as ReturnType<typeof stat>).clearsFloor !== null).length}; value months ${out.byValueDate.monthsBelowFloor[d].join(', ') || 'none'}; weeks ${out.byWeek.weeksBelowFloor[d].length} of ${weeks.filter(w => (w[d] as ReturnType<typeof stat>).clearsFloor !== null).length}`);
console.log(`\nBootstrap over ${days.length} import days, ${RESAMPLES} resamples, seed ${SEED}: pooled precision [2.5%, 97.5%], share of resamples under the floor`);
for (const d of DESKS) {
  const p = bootstrap.precision[d] as { pooled: number; lo: number; hi: number; belowFloorShare: number };
  console.log(`  ${NAMES[d].padEnd(16)} ${pct(p.pooled, 3)}  [${pct(p.lo, 3)}, ${pct(p.hi, 3)}]  under the floor in ${pct(p.belowFloorShare, 1)}`);
}
console.log(`  learned minus day 0: [${(bootstrap.learnedMinusDay0.lo * 100).toFixed(3)}, ${(bootstrap.learnedMinusDay0.hi * 100).toFixed(3)}] points`);
console.log(`  the benchmark's pick (best match rate that clears the floor): ${Object.entries(bootstrap.benchmarkWinnerShare).map(([d, s]) => `${NAMES[d as Desk] ?? d} ${pct(s, 1)}`).join(', ')}`);
console.log(`\nChecks passed: ${out.checks.join('; ')}. Wrote ${OUT}/monthly.json`);
