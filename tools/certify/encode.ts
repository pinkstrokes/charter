// Skills as formulas. A skill is a first-match list of rules over a domain's typed
// features; here each feature becomes a Z3 constant and each rule's condition a Z3
// formula, following dsl.ts's evaluator case by case, so what the solver reasons
// about is exactly what the database executes.

import { DOMAINS, type Expr, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';

// Features that are ratios; every other number in the DSL counts cents, days or things.
const REAL = new Set(['cash_share', 'peer_cash_share', 'own_cash_share_history', 'amount_vs_po', 'amount_vs_received', 'duplicate_score']);

type Kind = 'bool' | 'num' | 'enum';
interface Term { kind: Kind; t: any; values?: string[] }

export class Encoder {
  Z3: any;
  domain: keyof typeof DOMAINS;
  vars: Record<string, Term> = {};
  constructor(Z3: any, domain: keyof typeof DOMAINS) {
    this.Z3 = Z3;
    this.domain = domain;
    for (const [name, spec] of Object.entries(DOMAINS[domain].features) as [string, any][]) {
      if (spec.type === 'bool') this.vars[name] = { kind: 'bool', t: Z3.Bool.const(name) };
      else if (spec.type === 'enum') this.vars[name] = { kind: 'enum', t: Z3.Int.const(name), values: spec.values };
      else this.vars[name] = { kind: 'num', t: REAL.has(name) ? Z3.Real.const(name) : Z3.Int.const(name) };
    }
  }
  isInt(name: string): boolean { return this.vars[name]?.kind === 'num' && !REAL.has(name); }
  // Every number is compared as a real, so integer features and decimal constants mix freely.
  private real(t: Term): any {
    const Z3 = this.Z3;
    if (t.kind === 'bool') return Z3.If(t.t, Z3.Real.val(1), Z3.Real.val(0));
    if (t.kind === 'enum') return Z3.Real.val(0);
    return t.t.sort.name() === 'Int' ? Z3.ToReal(t.t) : t.t;
  }
  term(e: Expr): Term {
    const Z3 = this.Z3;
    switch (e.op) {
      case 'feat': {
        const v = this.vars[e.name];
        if (!v) throw new Error(`unknown feature ${e.name} in ${this.domain}`);
        return v;
      }
      case 'num': return { kind: 'num', t: Z3.Real.val(e.v) };
      case 'bool': return { kind: 'bool', t: Z3.Bool.val(e.v) };
      case 'enum': return { kind: 'enum', t: e.v as any, values: [e.v] };
      case 'not': {
        // dsl.ts: !value. A number is false unless it is zero; a non-empty enum literal is never false.
        const a = this.term(e.a);
        if (a.kind === 'bool') return { kind: 'bool', t: Z3.Not(a.t) };
        if (a.kind === 'num') return { kind: 'bool', t: this.real(a).eq(0) };
        return { kind: 'bool', t: Z3.Bool.val(false) };
      }
      case 'and':
      case 'or': {
        // dsl.ts compares each argument with === true, so anything but a boolean is false.
        const xs = e.args.map(a => this.cond(a));
        return { kind: 'bool', t: e.op === 'and' ? Z3.And(...xs) : Z3.Or(...xs) };
      }
      case 'cmp': {
        const a = this.term(e.a), b = this.term(e.b);
        if (e.c === 'eq' || e.c === 'ne') {
          let eq: any;
          if (a.kind === 'enum' || b.kind === 'enum') eq = this.enumEq(a, b);
          else if (a.kind !== b.kind) eq = Z3.Bool.val(false);
          else if (a.kind === 'bool') eq = a.t.eq(b.t);
          else eq = this.real(a).eq(this.real(b));
          return { kind: 'bool', t: e.c === 'eq' ? eq : Z3.Not(eq) };
        }
        const x = this.real(a), y = this.real(b);
        const t = e.c === 'gt' ? x.gt(y) : e.c === 'ge' ? x.ge(y) : e.c === 'lt' ? x.lt(y) : x.le(y);
        return { kind: 'bool', t };
      }
      case 'arith': {
        const xs = e.args.map(a => this.real(this.term(a)));
        let t: any;
        switch (e.f) {
          case 'add': t = xs.reduce((s: any, x: any) => s.add(x)); break;
          case 'sub': t = xs.slice(1).reduce((s: any, x: any) => s.sub(x), xs[0]); break;
          case 'mul': t = xs.reduce((s: any, x: any) => s.mul(x)); break;
          case 'div': t = Z3.If(xs[1].eq(0), Z3.Real.val(0), xs[0].div(xs[1])); break;
          case 'abs': t = Z3.If(xs[0].lt(0), xs[0].neg(), xs[0]); break;
          case 'max': t = xs.reduce((s: any, x: any) => Z3.If(s.ge(x), s, x)); break;
          case 'min': t = xs.reduce((s: any, x: any) => Z3.If(s.le(x), s, x)); break;
        }
        return { kind: 'num', t };
      }
    }
  }
  private enumEq(a: Term, b: Term): any {
    const Z3 = this.Z3;
    const lit = (x: Term) => (typeof x.t === 'string' ? x.t : null);
    if (lit(a) !== null && lit(b) !== null) return Z3.Bool.val(lit(a) === lit(b));
    const [v, l] = lit(a) !== null ? [b, lit(a)] : [a, lit(b)];
    if (l === null) return v.t.eq(a === v ? b.t : a.t);
    const i = (v.values ?? []).indexOf(l);
    return i === -1 ? Z3.Bool.val(false) : v.t.eq(i);
  }
  // A rule's condition holds only when it evaluates to exactly true.
  cond(e: Expr): any {
    const t = this.term(e);
    return t.kind === 'bool' ? t.t : this.Z3.Bool.val(false);
  }
  // The decision as an index into the domain's outcomes: first match wins.
  decision(p: SkillProgram): any {
    const Z3 = this.Z3, outs = DOMAINS[this.domain].outcomes as string[];
    let t = Z3.Int.val(outs.indexOf(p.otherwise.decide));
    for (let i = p.rules.length - 1; i >= 0; i--) t = Z3.If(this.cond(p.rules[i].when), Z3.Int.val(outs.indexOf(p.rules[i].then.decide)), t);
    return t;
  }
  // Enum and type ranges every feature map satisfies.
  ranges(): any[] {
    const out: any[] = [];
    for (const [name, v] of Object.entries(this.vars)) {
      if (v.kind === 'enum') out.push(v.t.ge(0), v.t.lt((v.values ?? []).length));
      void name;
    }
    return out;
  }
  // A Z3 model as a feature map the DSL can run on.
  features(model: any): Record<string, number | boolean | string> {
    const f: Record<string, number | boolean | string> = {};
    for (const [name, v] of Object.entries(this.vars)) {
      const x = model.eval(v.t, true);
      if (v.kind === 'bool') f[name] = x.toString() === 'true';
      else if (v.kind === 'enum') f[name] = (v.values ?? [])[Number(x.toString())];
      else f[name] = toNumber(x.toString());
    }
    return f;
  }
}

function toNumber(s: string): number {
  // Z3 prints rationals as a/b and negatives as (- x).
  const t = s.replace(/[()\s]/g, '');
  const neg = t.startsWith('-');
  const body = neg ? t.slice(1) : t;
  const [n, d] = body.split('/');
  const v = d ? Number(n) / Number(d) : Number(n);
  return neg ? -v : v;
}

// The atoms a program's conditions are built from: comparisons and boolean features.
export function atoms(e: Expr, out: Map<string, Expr>): void {
  switch (e.op) {
    case 'cmp': out.set(JSON.stringify(e), e); return;
    case 'feat': out.set(JSON.stringify(e), e); return;
    case 'and': case 'or': e.args.forEach(a => atoms(a, out)); return;
    case 'not': atoms(e.a, out); return;
    default: return;
  }
}
export function vocabulary(programs: SkillProgram[]): Expr[] {
  const m = new Map<string, Expr>();
  for (const p of programs) for (const r of p.rules) atoms(r.when, m);
  return [...m.values()];
}
