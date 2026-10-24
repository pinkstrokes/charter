// Reading skills: the module's own DSL types and interpreter (core/dsl.ts), plus
// a display layer that turns expressions into sentences and shows, for a given
// case, what each side of each comparison evaluated to.
import { DOMAINS, ESCALATING, run, sameTreatment, type Expr, type FeatureMap, type SkillProgram, type Value } from '@module/core/dsl';
import { money, pct, sentence } from './format';
import { parseLoose } from './json';

export { DOMAINS, ESCALATING, run, sameTreatment };

// The domain an ask is about: by kind, or by the suffix of spot_check:/correction: kinds.
export function askDomain(kind: string): string | undefined {
  const [base, suffix] = kind.split(':');
  if (suffix && (base === 'spot_check' || base === 'correction')) return suffix;
  return ASK_DOMAIN[base];
}

// A rule of a skill program in words; -1 is the fallback, -2 the precedent tier.
export function ruleText(program: SkillProgram | null, index: number): string {
  if (index === -2) return 'a person corrected a near-identical case (precedent)';
  if (!program) return index === -1 ? 'otherwise' : `rule ${index + 1}`;
  if (index === -1) return `otherwise ${outcomeText(program.otherwise.decide).toLowerCase()}`;
  const r = program.rules[index];
  return r ? `if ${exprText(r.when)}, ${outcomeText(r.then.decide).toLowerCase()}` : `rule ${index + 1}`;
}
export type { Expr, FeatureMap, SkillProgram, Value };

export const DOMAIN_NAMES = Object.keys(DOMAINS) as (keyof typeof DOMAINS)[];

export const DOMAIN_LABEL: Record<string, string> = {
  underreport: 'Under-reported sales',
  pre_chase: 'Before chasing a balance',
  routing_change: 'Bank-detail changes',
  allocation: 'Applying receipts',
  bill_match: 'Matching vendor bills',
};

// Which seat uses each domain.
export const DOMAIN_SEAT: Record<string, string> = {
  underreport: 'cash_app',
  allocation: 'cash_app',
  routing_change: 'cash_app',
  pre_chase: 'collections',
  bill_match: 'ap_clerk',
};

// Ask kinds whose evidence carries a domain's features.
export const ASK_DOMAIN: Record<string, string> = {
  audit: 'underreport',
  callback: 'routing_change',
  allocation: 'allocation',
  unapplied_cash: 'allocation',
  misapplied: 'allocation',
  collections: 'pre_chase',
  bill_exception: 'bill_match',
};

type FeatureSpec = { type: string; doc: string; values?: string[] };

export function featureSpec(domain: string, name: string): FeatureSpec | undefined {
  const d = (DOMAINS as Record<string, { features: Record<string, FeatureSpec> }>)[domain];
  return d?.features[name];
}

export function domainOf(features: Record<string, unknown>): string | undefined {
  let best: string | undefined;
  let score = 0;
  for (const d of DOMAIN_NAMES) {
    const names = Object.keys((DOMAINS as Record<string, { features: object }>)[d].features);
    const hit = Object.keys(features).filter(k => names.includes(k)).length;
    if (hit > score) {
      score = hit;
      best = d;
    }
  }
  return best;
}

const FEATURE_LABEL: Record<string, string> = {
  supply_implied_gross: 'supply-implied sales',
  card_settled: 'card settled',
  own_cash_share_history: 'own cash share before',
  peer_cash_share: 'peer cash share',
  days_to_next_movement: 'days to next money movement',
  next_movement_amount: 'next money movement',
  requests_last_30d: 'requests in 30 days',
  notices_last_30d: 'notices in 30 days',
  sender_matches_master: 'sender matches contact on file',
  source_trusted: 'trusted channel',
  urgency_language: 'pressure for speed or secrecy',
  callback_status: 'callback result',
  solution_count: 'matching invoice sets',
  remittance_present: 'remittance present',
  remittance_consistent: 'remittance agrees',
  reference_paid: 'reference already paid',
  reference_matches_open: 'reference names an invoice for exactly this amount',
  reference_names_open: 'reference names one open invoice',
  reference_gap_cents: 'named invoice minus payment',
  report_revised: 'revised report',
  weeks_of_history: 'weeks on file',
};

export function featureLabel(name: string): string {
  return FEATURE_LABEL[name] ?? name.replace(/_/g, ' ');
}

export type FeatureKind = 'money' | 'share' | 'bool' | 'enum' | 'count' | 'number';

export function featureKind(name: string, domain?: string): FeatureKind {
  const spec = domain ? featureSpec(domain, name) : undefined;
  if (spec?.type === 'bool') return 'bool';
  if (spec?.type === 'enum') return 'enum';
  if (name.endsWith('_cents') || /\(cents/.test(spec?.doc ?? '') || ['open_amount', 'receipt_amount', 'announced_payment', 'open_credit_notes', 'unapplied_amount', 'next_movement_amount'].includes(name)) return 'money';
  if (name.includes('share')) return 'share';
  if (/^(days|weeks|notices|requests|solution|open_items)/.test(name) || name.endsWith('_count')) return 'count';
  return 'number';
}

export function featureValue(name: string, v: unknown, domain?: string): string {
  if (v === undefined || v === null) return '—';
  const kind = featureKind(name, domain);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') {
    if (kind === 'money') return money(Math.round(v));
    if (kind === 'share') return pct(v);
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    return v.toFixed(3);
  }
  return String(v);
}

// ---------- expressions as sentences ----------

const CMP: Record<string, string> = { gt: '>', ge: '≥', lt: '<', le: '≤', eq: '=', ne: '≠' };

function moneyContext(e: Expr): boolean {
  if (e.op === 'feat') return featureKind(e.name) === 'money';
  if (e.op === 'arith') return e.args.some(moneyContext);
  return false;
}

function shareContext(e: Expr): boolean {
  if (e.op === 'feat') return featureKind(e.name) === 'share';
  if (e.op === 'arith') return e.args.some(shareContext);
  return false;
}

export function exprText(e: Expr, ctx: { money?: boolean; share?: boolean } = {}): string {
  switch (e.op) {
    case 'feat':
      return featureLabel(e.name);
    case 'num':
      if (ctx.money && Math.abs(e.v) >= 100) return money(Math.round(e.v), { whole: e.v % 100 === 0 });
      if (ctx.share && e.v <= 1 && e.v >= 0) return pct(e.v, e.v * 100 % 1 === 0 ? 0 : 1);
      return String(e.v);
    case 'bool':
      return e.v ? 'yes' : 'no';
    case 'enum':
      return `“${e.v.replace(/_/g, ' ')}”`;
    case 'not':
      return e.a.op === 'feat' ? `no ${featureLabel(e.a.name)}` : `not (${exprText(e.a, ctx)})`;
    case 'and':
    case 'or':
      return e.args.map(a => (a.op === 'and' || a.op === 'or' ? `(${exprText(a, ctx)})` : exprText(a, ctx))).join(e.op === 'and' ? ' and ' : ' or ');
    case 'cmp': {
      const m = moneyContext(e.a) || moneyContext(e.b);
      const s = shareContext(e.a) || shareContext(e.b);
      return `${exprText(e.a, { money: m, share: s })} ${CMP[e.c]} ${exprText(e.b, { money: m, share: s })}`;
    }
    case 'arith': {
      const parts = e.args.map(a => exprText(a, { ...ctx, money: false, share: false }));
      switch (e.f) {
        case 'add':
          return parts.join(' + ');
        case 'sub':
          return parts.join(' − ');
        case 'mul':
          return parts.join(' × ');
        case 'div':
          return parts.join(' ÷ ');
        case 'abs':
          return `|${parts[0]}|`;
        case 'max':
          return `larger of ${parts.join(', ')}`;
        case 'min':
          return `smaller of ${parts.join(', ')}`;
      }
    }
  }
  return '?';
}

export function outcomeText(decide: string): string {
  // Invoice numbers and other references (R-S01-2026-01-05) keep their hyphens.
  if (/\w-\w*\d/.test(decide)) return decide;
  return sentence(decide.replace(/_/g, ' '));
}

export function parseProgram(text: string): SkillProgram | null {
  const p = parseLoose<SkillProgram | null>(text, null);
  return p && Array.isArray(p.rules) ? p : null;
}

// Display-side evaluator with the same semantics as core/dsl.ts evalExpr, used
// only to show the numbers behind a decision (the decision itself is `run`).
export function evalExpr(e: Expr, f: FeatureMap): Value | undefined {
  try {
    switch (e.op) {
      case 'feat':
        return f[e.name];
      case 'num':
      case 'bool':
      case 'enum':
        return e.v;
      case 'not':
        return !evalExpr(e.a, f);
      case 'and':
        return e.args.every(a => evalExpr(a, f) === true);
      case 'or':
        return e.args.some(a => evalExpr(a, f) === true);
      case 'cmp': {
        const a = evalExpr(e.a, f);
        const b = evalExpr(e.b, f);
        if (a === undefined || b === undefined) return undefined;
        switch (e.c) {
          case 'eq':
            return a === b;
          case 'ne':
            return a !== b;
          case 'gt':
            return (a as number) > (b as number);
          case 'ge':
            return (a as number) >= (b as number);
          case 'lt':
            return (a as number) < (b as number);
          case 'le':
            return (a as number) <= (b as number);
        }
        return undefined;
      }
      case 'arith': {
        const xs = e.args.map(a => Number(evalExpr(a, f)));
        switch (e.f) {
          case 'add':
            return xs.reduce((s, x) => s + x, 0);
          case 'sub':
            return xs.slice(1).reduce((s, x) => s - x, xs[0]);
          case 'mul':
            return xs.reduce((s, x) => s * x, 1);
          case 'div':
            return xs[1] === 0 ? 0 : xs[0] / xs[1];
          case 'abs':
            return Math.abs(xs[0]);
          case 'max':
            return Math.max(...xs);
          case 'min':
            return Math.min(...xs);
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// "cash share 11.6% < peer cash share × 0.6 = 18.0%" for the comparisons in a rule.
export function explainComparisons(e: Expr, f: FeatureMap): { text: string; holds: boolean | undefined }[] {
  const out: { text: string; holds: boolean | undefined }[] = [];
  const walk = (x: Expr) => {
    if (x.op === 'cmp') {
      const m = moneyContext(x.a) || moneyContext(x.b);
      const s = shareContext(x.a) || shareContext(x.b);
      const show = (side: Expr) => {
        const v = evalExpr(side, f);
        const fmt = (val: Value | undefined) => {
          if (val === undefined) return '—';
          if (typeof val === 'number') return m ? money(Math.round(val)) : s ? pct(val) : Number.isInteger(val) ? val.toLocaleString('en-US') : val.toFixed(3);
          if (typeof val === 'boolean') return val ? 'yes' : 'no';
          return `“${val}”`;
        };
        if (side.op === 'num' || side.op === 'enum' || side.op === 'bool') return exprText(side, { money: m, share: s });
        if (side.op === 'feat') return `${exprText(side)} ${fmt(v)}`;
        return `${exprText(side)} = ${fmt(v)}`;
      };
      const holds = evalExpr(x, f);
      out.push({ text: `${show(x.a)} ${CMP[x.c]} ${show(x.b)}`, holds: typeof holds === 'boolean' ? holds : undefined });
      return;
    }
    if (x.op === 'and' || x.op === 'or') x.args.forEach(walk);
    else if (x.op === 'not') walk(x.a);
    else if (x.op === 'feat') {
      const v = f[x.name];
      out.push({ text: `${featureLabel(x.name)}: ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? '—')}`, holds: typeof v === 'boolean' ? v : undefined });
    }
  };
  walk(e);
  return out;
}

export function skillVersion(key: string): { domain: string; version: number } {
  const [domain, v] = key.split('@');
  return { domain, version: Number(v) || 0 };
}

export function isSkillKey(s: string): boolean {
  return /^[a-z_]+@\d+$/.test(s);
}
