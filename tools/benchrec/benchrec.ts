// BenchRec: a Tier-1 institution's real cash account (CC BY 4.0, Kaggle
// benchmarkteam/benchrec-real-world-cash-reconciliation-dataset). Every bank
// line must be given the ledger allocation it belongs to; a submission counts
// only if its precision clears 99.8%, and then match rate decides.
//
// A bank-reconciliation seat decides with a skill program in the same language
// as every other seat, and its rules earn autonomy the way the kernel's do: on
// the labeled train split, a rule acts alone only if we are 95% sure its error
// rate is under the 0.2% the benchmark tolerates. Every other line goes to a
// person. The eval split is scored once, against the solution file.
//   npx tsx tools/benchrec/benchrec.ts --data <folder with the BenchRec CSVs>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { run, type FeatureMap, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { upper95 } from '../../module/spacetimedb/src/core/stats';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');
const DIR = args.get('data') ?? 'data/benchrec';
const TOLERABLE = 0.002; // 1 - the benchmark's 99.8% precision floor
const NEAR_DAYS = 3;

function parseCsv(text: string): Record<string, string>[] {
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

interface Ledger {
  id: string;
  cents: number;
  valueDate: string;
  importDate: string;
  allocation: string;
}
interface Bank {
  id: string;
  cents: number;
  valueDate: string;
  importDate: string;
  truth: string[]; // allocations it belongs to (train only)
}

const cents = (s: string) => Math.round(parseFloat(s || '0') * 100);
const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
const shift = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const allocations = (label: string) => (label.startsWith('[') ? label.slice(1, -1).split(/,(?=USD_)/) : label ? [label] : []).map(x => x.trim());

function load(file: string): { ledger: Ledger[]; bank: Bank[] } {
  const rows = parseCsv(readFileSync(`${DIR}/${file}`, 'utf8'));
  const ledger: Ledger[] = [];
  const bank: Bank[] = [];
  for (const r of rows) {
    if (r.A_id) ledger.push({ id: r.A_id, cents: cents(r.A_amount), valueDate: r.A_valueDate, importDate: r.A_importDate, allocation: r.A_allocation.trim() });
    if (r.B_id) bank.push({ id: r.B_id, cents: cents(r.B_amount), valueDate: r.B_valueDate, importDate: r.B_importDate, truth: allocations(r.targetAllocation) });
  }
  return { ledger, bank };
}

// What the seat sees for one bank line, and the allocation each rule would give it.
function featuresFor(ledger: Ledger[], bank: Bank[]): Map<string, { f: FeatureMap; exact: string; group: string; near: string }> {
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
  const out = new Map<string, { f: FeatureMap; exact: string; group: string; near: string }>();
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
      exact: exactAllocs[0] ?? '',
      group: group[0] ?? '',
      near: [...near][0] ?? '',
    });
  }
  return out;
}

const feat = (name: string) => ({ op: 'feat' as const, name });
const num = (v: number) => ({ op: 'num' as const, v });
const eq = (a: object, b: object) => ({ op: 'cmp' as const, c: 'eq' as const, a, b }) as never;
const le = (a: object, b: object) => ({ op: 'cmp' as const, c: 'le' as const, a, b }) as never;
const and = (...args: object[]) => ({ op: 'and' as const, args }) as never;
const not = (a: object) => ({ op: 'not' as const, a }) as never;

// Day-0 skill: the obvious matches a bank-reconciliation clerk makes first. The
// interpreter is the seats' own; the domain lives here, not in the database's
// DOMAINS, because this desk is measured offline.
export const SKILL = {
  domain: 'bank_match' as SkillProgram['domain'],
  rules: [
    { when: and(eq(feat('exact_allocations'), num(1)), not(feat('contested')), le(feat('import_gap_days'), num(14))), then: { decide: 'match_exact', note: 'one ledger allocation on the value date has exactly this amount, booked within two weeks' } },
    { when: and(eq(feat('exact_allocations'), num(1)), not(feat('contested'))), then: { decide: 'match_exact', note: 'one ledger allocation on the value date has exactly this amount' } },
    { when: and(eq(feat('exact_allocations'), num(1)), le(num(2), feat('exact_lines'))), then: { decide: 'match_exact', note: 'every ledger line with this amount on the value date carries the same allocation' } },
    { when: eq(feat('exact_allocations'), num(1)), then: { decide: 'match_exact', note: 'another bank line claims the same ledger line' } },
    { when: and(eq(feat('exact_allocations'), num(0)), eq(feat('group_allocations'), num(1))), then: { decide: 'match_group', note: "one allocation's ledger lines on the value date add up to this amount" } },
    { when: and(eq(feat('exact_allocations'), num(0)), eq(feat('group_allocations'), num(0)), eq(feat('near_allocations'), num(1))), then: { decide: 'match_near', note: `one ledger allocation within ${NEAR_DAYS} days has exactly this amount` } },
  ],
  otherwise: { decide: 'ask', note: 'no single allocation explains this line' },
} satisfies SkillProgram;

function main(): void {
  for (const f of ['BenchRec_cash_v1.0_train.csv', 'BenchRec_cash_v1.0_eval.csv', 'BenchRec_cash_v1.0_solution.csv'])
    if (!existsSync(`${DIR}/${f}`)) throw new Error(`${DIR}/${f} is missing; download it from https://www.kaggle.com/datasets/benchmarkteam/benchrec-real-world-cash-reconciliation-dataset`);
  // 1. Earn autonomy on the train split: each rule's record against people's matches.
  const train = load('BenchRec_cash_v1.0_train.csv');
  const tf = featuresFor(train.ledger, train.bank);
  const record = SKILL.rules.map(() => ({ n: 0, wrong: 0 }));
  for (const b of train.bank) {
    if (!b.truth.length) continue;
    const x = tf.get(b.id)!;
    const r = run(SKILL, x.f);
    if (r.trace.ruleIndex < 0) continue;
    const alloc = r.outcome.decide === 'match_exact' ? x.exact : r.outcome.decide === 'match_group' ? x.group : x.near;
    record[r.trace.ruleIndex].n++;
    if (!b.truth.includes(alloc)) record[r.trace.ruleIndex].wrong++;
  }
  const autonomous = record.map(s => s.n > 0 && upper95(s.wrong, s.n) <= TOLERABLE);
  // 2. Score the locked eval split once.
  const evalSet = load('BenchRec_cash_v1.0_eval.csv');
  const ef = featuresFor(evalSet.ledger, evalSet.bank);
  const solution = new Map(parseCsv(readFileSync(`${DIR}/BenchRec_cash_v1.0_solution.csv`, 'utf8')).map(r => [r.B_id, allocations(r.targetAllocation)]));
  const byRule = SKILL.rules.map(() => ({ n: 0, wrong: 0 }));
  let matched = 0;
  let correct = 0;
  const submission: string[] = ['B_id,targetAllocation'];
  for (const b of evalSet.bank) {
    if (!solution.has(b.id)) continue;
    const x = ef.get(b.id)!;
    const r = run(SKILL, x.f);
    const alone = r.trace.ruleIndex >= 0 && autonomous[r.trace.ruleIndex];
    const alloc = !alone ? '' : r.outcome.decide === 'match_exact' ? x.exact : r.outcome.decide === 'match_group' ? x.group : x.near;
    submission.push(`"${b.id}","${alloc ? `[${alloc}]` : '[]'}"`);
    if (!alloc) continue;
    matched++;
    const ok = solution.get(b.id)!.includes(alloc);
    correct += ok ? 1 : 0;
    byRule[r.trace.ruleIndex].n++;
    byRule[r.trace.ruleIndex].wrong += ok ? 0 : 1;
  }
  const total = solution.size;
  // 3. The matcher shipped with the dataset, scored the same way.
  let baseline: { matched: number; correct: number } | null = null;
  if (existsSync(`${DIR}/MatcherByChatGPT_submission.csv`)) {
    baseline = { matched: 0, correct: 0 };
    for (const r of parseCsv(readFileSync(`${DIR}/MatcherByChatGPT_submission.csv`, 'utf8'))) {
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
  }
  const result = {
    dataset: 'BenchRec cash v1.0 (Kaggle benchmarkteam, CC BY 4.0)',
    floor: 1 - TOLERABLE,
    rules: SKILL.rules.map((r, i) => ({ rule: i, note: r.then.note, train: { ...record[i], upper95: Number(upper95(record[i].wrong, record[i].n).toFixed(5)) }, actsAlone: autonomous[i], eval: byRule[i] })),
    eval: { bankLines: total, matched, correct, precision: matched ? correct / matched : null, matchRate: matched / total, clearsFloor: matched > 0 && correct / matched > 1 - TOLERABLE },
    baseline: baseline && { name: 'MatcherByChatGPT_submission.csv (shipped with the dataset)', matched: baseline.matched, correct: baseline.correct, precision: baseline.matched ? baseline.correct / baseline.matched : null, matchRate: baseline.matched / total },
  };
  mkdirSync('data/benchrec_eval', { recursive: true });
  writeFileSync('data/benchrec_eval/result.json', JSON.stringify(result, null, 1));
  writeFileSync('data/benchrec_eval/submission.csv', submission.join('\n') + '\n');
  console.log(JSON.stringify(result, null, 1));
}

main();
