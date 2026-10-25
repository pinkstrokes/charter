// npx tsx tools/certify/learned_gate.ts B|C [--all] [--trace]
//
// Two ways to build autonomy by situation into the live seat, replayed on the run's own cash
// decisions (its versions, dates, questions and spot checks; answers from the answer key):
//   default  only a behaviour a learned version adds is gated: where it decides differently from
//            the hand-written day-one skill, it acts alone in a situation only once a person has
//            confirmed it there and nobody has said otherwise;
//   --all    every behaviour is gated that way, the day-one skill's too.
// A situation is which conditions of the day-one skill and the version in force hold on the case.
// --trace prints the first week's decisions, to see what each gate does with the moment's payment.
import { readFileSync } from 'node:fs';
import { run, settlesAlone, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { vocabulary } from './encode';

const D = JSON.parse(readFileSync(new URL('./data/inputs.json', import.meta.url), 'utf8'));
const co = (process.argv[2] ?? 'B').toUpperCase() as 'B' | 'C';
const ALL = process.argv.includes('--all');
const decisions: any[] = JSON.parse(readFileSync(new URL(`./data/decisions-${co.toLowerCase()}.json`, import.meta.url), 'utf8'));
const versions = (co === 'B' ? D.b : D.c).versions as { key: string; program: SkillProgram }[];
const progOf = (key: string) => versions.find(v => v.key === key.split('+')[0])!.program;
const seed = progOf('allocation@1');
const landing = (truth: string[]) => (truth.length ? [...truth].sort().join(' + ') : 'ask');
const answerOf = (d: any) => Object.keys(d.t).find(o => o !== 'leave_unapplied_ask' && d.t[o] === landing(d.truth)) ?? 'leave_unapplied_ask';
const rightOf = (d: any, outcome: string) => d.t[outcome] === (Object.values(d.t).includes(landing(d.truth)) ? landing(d.truth) : 'ask');
const alone = (d: any, outcome: string) => settlesAlone('allocation', outcome, d.t);
const agrees = (d: any, a: string, b: string) => d.t[a] === d.t[b];
const holds = (atom: any, f: any) => run({ domain: 'allocation', rules: [{ when: atom, then: { decide: 'y' } }], otherwise: { decide: 'n' } } as any, f).outcome.decide === 'y';
const ordered = [...decisions].sort((x, y) => x.at.localeCompare(y.at) || x.id - y.id);
const vocabs = new Map<string, any[]>();
const vocabFor = (key: string) => vocabs.get(key) ?? vocabs.set(key, vocabulary(key === 'allocation@1' ? [seed] : [seed, progOf(key)])).get(key)!;
const where = (vocab: any[], f: any) => vocab.map(a => (holds(a, f) ? '1' : '0')).join('');

type T = { wrongAlone: number; asks: number; extraAsks: number };
const blank = (): T => ({ wrongAlone: 0, asks: 0, extraAsks: 0 });
const byMonth = new Map<string, { run: T; gate: T }>();
const evidence: { d: any; said: string }[] = [];
for (const d of ordered) {
  const month = d.at.slice(0, 7);
  const m = byMonth.get(month) ?? byMonth.set(month, { run: blank(), gate: blank() }).get(month)!;
  const key = d.skill.split('+')[0];
  if (alone(d, d.outcome)) (rightOf(d, d.outcome) ? 0 : m.run.wrongAlone++);
  else m.run.asks++;
  let actsAlone = alone(d, d.outcome);
  if (actsAlone && (ALL || (key !== 'allocation@1' && !agrees(d, d.outcome, run(seed, d.f).outcome.decide)))) {
    const vocab = vocabFor(key);
    const here = where(vocab, d.f);
    const prog = progOf(key);
    const ev = evidence.filter(e => where(vocab, e.d.f) === here);
    const agreeing = ev.filter(e => agrees(e.d, e.said, run(prog, e.d.f).outcome.decide)).length;
    if (!(agreeing >= 1 && agreeing === ev.length)) (actsAlone = false), m.gate.extraAsks++;
  }
  if (process.argv.includes('--trace') && d.at <= ordered[0].at.slice(0, 8) + '31') console.log('  ', d.at, d.subject, d.outcome, actsAlone ? 'alone' : 'asked', rightOf(d, d.outcome) ? '' : '(wrong)');
  if (actsAlone) {
    if (!rightOf(d, d.outcome)) m.gate.wrongAlone++;
    if ((d.labelSource || '').startsWith('spot_check')) evidence.push({ d, said: answerOf(d) });
  } else {
    m.gate.asks++;
    evidence.push({ d, said: answerOf(d) });
  }
}
const months = [...byMonth.keys()].sort();
const sum = (ms: string[], k: 'run' | 'gate', f: keyof T) => ms.reduce((s, x) => s + byMonth.get(x)![k][f], 0);
console.log(`${co}: ${ordered.length} cash decisions; gate on ${ALL ? 'every behaviour' : 'learned behaviours only'}`);
for (const [name, ms] of [['first three months', months.slice(0, 3)], ['the rest', months.slice(3)], ['all', months]] as const)
  console.log(`${name.padEnd(20)} as run ${sum(ms, 'run', 'wrongAlone')} wrong alone, ${sum(ms, 'run', 'asks')} questions;  gated ${sum(ms, 'gate', 'wrongAlone')} wrong alone, ${sum(ms, 'gate', 'asks')} questions`);
