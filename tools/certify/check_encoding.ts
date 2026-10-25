// The encoding must decide exactly what the interpreter decides. Every recorded case of
// companies B and C, and random feature maps for every skill version of every domain, are
// run through dsl.ts and through the Z3 formula; any disagreement fails the check.

import { init } from 'z3-solver';
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMAINS, run, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { Encoder } from './encode';

const D = JSON.parse(readFileSync(process.env.CHARTER_SHOWCASE_DATA ?? `${process.env.HOME}/Developer/charter-showcase/data.json`, 'utf8'));
const { Context } = await init();
const Z3 = Context('main');

function pin(enc: Encoder, f: Record<string, any>): any[] {
  return Object.entries(enc.vars).map(([name, v]) => {
    const x = f[name];
    if (v.kind === 'bool') return v.t.eq(Z3.Bool.val(!!x));
    if (v.kind === 'enum') return v.t.eq((v.values ?? []).indexOf(x));
    return v.t.eq(enc.isInt(name) ? Z3.Int.val(Math.round(Number(x))) : Z3.Real.val(Number(x)));
  });
}
async function decide(enc: Encoder, p: SkillProgram, f: Record<string, any>): Promise<string> {
  const s = new Z3.Solver();
  s.add(...pin(enc, f));
  if ((await s.check()) !== 'sat') throw new Error('pinned features are unsatisfiable');
  return (DOMAINS[enc.domain].outcomes as string[])[Number(s.model().eval(enc.decision(p), true).toString())];
}
function randomFeatures(domain: keyof typeof DOMAINS, rnd: () => number): Record<string, any> {
  const f: Record<string, any> = {};
  for (const [name, spec] of Object.entries(DOMAINS[domain].features) as [string, any][]) {
    if (spec.type === 'bool') f[name] = rnd() < 0.5;
    else if (spec.type === 'enum') f[name] = spec.values[Math.floor(rnd() * spec.values.length)];
    else if (['cash_share', 'peer_cash_share', 'own_cash_share_history', 'duplicate_score'].includes(name)) f[name] = Math.round(rnd() * 100) / 100;
    else if (['amount_vs_po', 'amount_vs_received'].includes(name)) f[name] = Math.round(rnd() * 200) / 100;
    else f[name] = Math.floor(rnd() * [4, 30, 3000, 300000][Math.floor(rnd() * 4)]);
  }
  return f;
}
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
let checked = 0, bad = 0;
const programs: [string, keyof typeof DOMAINS, SkillProgram][] = [];
for (const co of ['b', 'c'] as const) for (const v of D[co].versions) programs.push([`${co.toUpperCase()} ${v.key}`, 'allocation', v.program]);
for (const [dom, vs] of Object.entries(D.a.skills) as [string, any][]) for (const v of vs) programs.push([`A ${v.key}`, dom as any, v.program]);
for (const [name, dom, p] of programs) {
  const enc = new Encoder(Z3, dom);
  const samples: Record<string, any>[] = [];
  if (dom === 'allocation') for (const co of ['b', 'c']) for (const c of D[co].cases.slice(0, 120)) samples.push(c.f);
  for (let i = 0; i < 60; i++) samples.push(randomFeatures(dom, rnd));
  for (const f of samples) {
    const want = run(p, f).outcome.decide, got = await decide(enc, p, f);
    checked++;
    if (want !== got) { bad++; if (bad <= 5) console.log('DISAGREE', name, want, got, JSON.stringify(f)); }
  }
}
console.log(`${checked} decisions checked across ${programs.length} skill versions: ${bad} disagreements`);
writeFileSync(new URL('./out/encoding.json', import.meta.url), JSON.stringify({ checked, versions: programs.length, disagreements: bad }));
process.exit(bad ? 1 : 0);
