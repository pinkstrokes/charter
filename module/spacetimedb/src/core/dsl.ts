// Team skills are small programs in this DSL. The same interpreter runs inside
// the database (to make live decisions) and in the evolution tools (to evaluate
// candidates), so what is proven offline is exactly what executes online.

export type Expr =
  | { op: 'feat'; name: string }
  | { op: 'num'; v: number }
  | { op: 'bool'; v: boolean }
  | { op: 'enum'; v: string }
  | { op: 'cmp'; c: 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'ne'; a: Expr; b: Expr }
  | { op: 'and' | 'or'; args: Expr[] }
  | { op: 'not'; a: Expr }
  | { op: 'arith'; f: 'add' | 'sub' | 'mul' | 'div' | 'abs' | 'max' | 'min'; args: Expr[] };

export interface Outcome {
  decide: string; // one of the domain's outcomes
  askRole?: string; // who to ask when the outcome needs a person
  note?: string; // short human-readable rationale template
}

export interface Rule {
  when: Expr;
  then: Outcome;
}

export interface SkillProgram {
  domain: DomainName;
  rules: Rule[]; // first match wins
  otherwise: Outcome;
}

export type Value = number | boolean | string;
export type FeatureMap = Record<string, Value>;

interface FeatureSpec {
  type: 'number' | 'bool' | 'enum';
  values?: string[]; // allowed literals for enum features
  doc: string;
}

interface DomainSpec {
  doc: string;
  outcomes: string[];
  features: Record<string, FeatureSpec>;
}

export const DOMAINS = {
  underreport: {
    doc: 'Decide whether a weekly sales report should be accepted or sent for audit.',
    outcomes: ['accept', 'flag_audit', 'ask_consultant'],
    features: {
      reported_gross: { type: 'number', doc: 'gross sales the franchisee reported (cents)' },
      reported_card: { type: 'number', doc: 'card sales the franchisee reported (cents)' },
      reported_cash: { type: 'number', doc: 'cash sales the franchisee reported (cents)' },
      card_settled: { type: 'number', doc: 'card sales the processor actually settled (cents, trusted)' },
      supply_implied_gross: { type: 'number', doc: 'gross sales implied by supplies the store bought (cents, trusted)' },
      cash_share: { type: 'number', doc: 'reported cash / reported gross' },
      peer_cash_share: { type: 'number', doc: 'median cash share of comparable stores this week' },
      own_cash_share_history: { type: 'number', doc: "this store's median cash share over prior weeks" },
      weeks_of_history: { type: 'number', doc: 'weeks of reports on file for this store' },
      report_revised: { type: 'bool', doc: 'this report supersedes an earlier one for the same week' },
    },
  },
  pre_chase: {
    doc: 'Decide whether collections should chase a past-due balance now.',
    outcomes: ['chase', 'hold', 'ask_consultant', 'escalate_controller'],
    features: {
      days_past_due: { type: 'number', doc: 'days since the oldest open invoice was due' },
      grace_days: { type: 'number', doc: 'contractual grace period for this counterparty' },
      open_amount: { type: 'number', doc: 'open balance being chased (cents)' },
      unapplied_amount: { type: 'number', doc: 'money received from this counterparty but not yet applied (cents)' },
      announced_payment: { type: 'number', doc: 'payment announced by a trusted source but not yet received (cents)' },
      open_credit_notes: { type: 'number', doc: 'credit notes issued to this counterparty and not yet netted (cents)' },
      open_dispute: { type: 'bool', doc: 'there is an open dispute on this balance' },
      recent_return: { type: 'bool', doc: 'a debit was returned in the last 14 days' },
      bank_change_recent: { type: 'bool', doc: 'the counterparty asked to change its bank account in the last 30 days (a return may be our debit hitting the old account)' },
      notices_last_30d: { type: 'number', doc: 'collection notices already sent in the last 30 days' },
    },
  },
  routing_change: {
    doc: 'Decide what to do with a request to change where money is sent or debited.',
    outcomes: ['hold_and_verify', 'reject', 'ask_controller'],
    features: {
      source_trusted: { type: 'bool', doc: 'the request arrived through a trusted channel' },
      sender_matches_master: { type: 'bool', doc: 'the sender address matches the contact on file before the request' },
      days_to_next_movement: { type: 'number', doc: 'days until the next debit or refund to this counterparty' },
      next_movement_amount: { type: 'number', doc: 'amount of that next money movement (cents)' },
      callback_status: { type: 'enum', values: ['none', 'confirmed', 'denied', 'no_answer'], doc: 'result of calling the number on file' },
      requests_last_30d: { type: 'number', doc: 'routing-change requests for this counterparty in the last 30 days' },
      urgency_language: { type: 'bool', doc: 'the message pressures for speed or secrecy' },
      lookalike_sender: { type: 'bool', doc: "the sender's address imitates the contact on file" },
    },
  },
  allocation: {
    doc: 'Decide how to apply a receipt whose matching is not exact or not unique.',
    outcomes: ['apply_unique', 'apply_to_reference', 'apply_by_terms', 'leave_unapplied_ask'],
    features: {
      solution_count: { type: 'number', doc: 'invoice subsets that explain the amount within tolerance (capped at 3)' },
      exact_match: { type: 'bool', doc: 'a subset sums exactly to the receipt' },
      residual_cents: { type: 'number', doc: 'amount left over after the best subset' },
      remittance_present: { type: 'bool', doc: 'the payer said which invoices this pays' },
      remittance_consistent: { type: 'bool', doc: 'the payer’s list agrees with a valid subset' },
      receipt_amount: { type: 'number', doc: 'amount received (cents)' },
      reference_paid: { type: 'bool', doc: 'the payment reference names an invoice that is already paid' },
      reference_matches_open: { type: 'bool', doc: 'the payment reference names one open invoice whose balance is exactly the payment' },
      reference_names_open: { type: 'bool', doc: "the payment reference names at least one of the payer's open invoices, whatever their balances" },
      reference_gap_cents: { type: 'number', doc: 'balance of the named invoices minus the payment (positive when short-paid)' },
      open_items: { type: 'number', doc: 'open invoices this payer has' },
    },
  },
  bill_match: {
    doc: 'Decide whether a vendor bill can be approved for payment, held for a person, or rejected.',
    outcomes: ['approve', 'hold_exception', 'reject'],
    features: {
      po_found: { type: 'bool', doc: 'a purchase order exists for the bill' },
      receipt_found: { type: 'bool', doc: 'goods were received against that order' },
      amount_vs_po: { type: 'number', doc: 'bill amount / order amount' },
      amount_vs_received: { type: 'number', doc: 'bill amount / value of goods received' },
      duplicate_score: { type: 'number', doc: '0..1, how closely the bill matches another bill from the same vendor (same amount, same number once punctuation is stripped, close dates)' },
      vendor_bank_change_pending: { type: 'bool', doc: 'a change of the vendor bank account is waiting for verification' },
      days_to_due: { type: 'number', doc: 'days until the bill is due' },
      amount: { type: 'number', doc: 'bill amount (cents)' },
    },
  },
  bank_match: {
    doc: 'Decide which ledger allocation a bank statement line belongs to, or hand it to a person.',
    outcomes: ['match_exact', 'match_group', 'match_near', 'ask'],
    features: {
      exact_allocations: { type: 'number', doc: 'ledger allocations with a line of exactly this amount on the same value date (match_exact takes the first)' },
      exact_lines: { type: 'number', doc: 'ledger lines of exactly this amount on the same value date' },
      contested: { type: 'bool', doc: 'another bank line has the same amount and value date as one of those ledger lines' },
      import_gap_days: { type: 'number', doc: 'days between this bank line and the closest such ledger line arriving in the books (999 when there is none)' },
      group_allocations: { type: 'number', doc: 'other allocations whose ledger lines on the value date add up to this amount (match_group takes the first)' },
      near_allocations: { type: 'number', doc: 'allocations with a line of exactly this amount within 3 days of the value date, not on it (match_near takes the first)' },
    },
  },
} satisfies Record<string, DomainSpec>;

export type DomainName = keyof typeof DOMAINS;

// Outcomes that hand the case to a person instead of settling it.
export const ESCALATING: Record<DomainName, string[]> = {
  underreport: ['flag_audit', 'ask_consultant'],
  pre_chase: ['ask_consultant', 'escalate_controller'],
  allocation: ['leave_unapplied_ask'],
  routing_change: ['hold_and_verify', 'ask_controller', 'reject'],
  bill_match: ['hold_exception'],
  bank_match: ['ask'],
};

// How often a rule may be wrong and still act alone. At exactly this rate acting
// alone and asking a person cost the same, so one mistake is worth 1/TOLERABLE
// questions. The bank desk's is BenchRec's floor: 99.8% precision.
export const TOLERABLE: Record<DomainName, number> = { underreport: 0.05, pre_chase: 0.1, allocation: 0.02, routing_change: 0.02, bill_match: 0.02, bank_match: 0.002 };

// What each outcome would do with one case, recorded with the decision when the
// seat can work it out: for cash, the invoices each outcome would pay ('ask' when
// it would hand the receipt to a person). Customer with one open invoice: paying
// it "by terms" and paying "the invoice the payer named" are the same decision.
export type Treatments = Record<string, string>;
export const ASKS = 'ask';

// Two outcomes agree when they lead to the same treatment of the case.
export function sameTreatment(domain: string, a: string, b: string, treatments?: Treatments): boolean {
  if (domain === 'underreport') return ESCALATING.underreport.includes(a) === ESCALATING.underreport.includes(b);
  if (treatments && a in treatments && b in treatments) return treatments[a] === treatments[b];
  return a === b;
}

// The outcome that would have done what a person did, or the domain's way of asking when none would
// (an outcome that cannot act on a case asks too, but asking is said by its own name).
export function outcomeFor(treatments: Treatments, done: string, asks: string): string {
  if (done === ASKS) return asks;
  return Object.keys(treatments).find(o => treatments[o] === done) ?? asks;
}

// Whether an outcome settles a case without a person: by what it would do when that
// is known (paying "the unique set" when no set fits hands the receipt to a person).
export function settlesAlone(domain: string, outcome: string, treatments?: Treatments): boolean {
  if (treatments && outcome in treatments) return treatments[outcome] !== ASKS;
  return !(ESCALATING[domain as DomainName] ?? []).includes(outcome);
}

export function parseTreatments(json: string | undefined): Treatments | undefined {
  if (!json) return undefined;
  const t = JSON.parse(json) as Treatments;
  return Object.keys(t).length ? t : undefined;
}

export interface Trace {
  ruleIndex: number; // -1 when 'otherwise' was used
  used: Record<string, Value>; // features the deciding rule read
}

function featureNames(expr: Expr, out: Set<string>): void {
  switch (expr.op) {
    case 'feat':
      out.add(expr.name);
      return;
    case 'cmp':
      featureNames(expr.a, out);
      featureNames(expr.b, out);
      return;
    case 'and':
    case 'or':
    case 'arith':
      expr.args.forEach(a => featureNames(a, out));
      return;
    case 'not':
      featureNames(expr.a, out);
      return;
    default:
      return;
  }
}

function evalExpr(expr: Expr, f: FeatureMap): Value {
  switch (expr.op) {
    case 'feat': {
      const v = f[expr.name];
      if (v === undefined) throw new Error(`missing feature ${expr.name}`);
      return v;
    }
    case 'num':
      return expr.v;
    case 'bool':
      return expr.v;
    case 'enum':
      return expr.v;
    case 'not':
      return !evalExpr(expr.a, f);
    case 'and':
      return expr.args.every(a => evalExpr(a, f) === true);
    case 'or':
      return expr.args.some(a => evalExpr(a, f) === true);
    case 'cmp': {
      const a = evalExpr(expr.a, f);
      const b = evalExpr(expr.b, f);
      switch (expr.c) {
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
      return false;
    }
    case 'arith': {
      const xs = expr.args.map(a => Number(evalExpr(a, f)));
      switch (expr.f) {
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
      return 0;
    }
  }
}

export function run(program: SkillProgram, f: FeatureMap): { outcome: Outcome; trace: Trace } {
  for (let i = 0; i < program.rules.length; i++) {
    const rule = program.rules[i];
    if (evalExpr(rule.when, f) === true) {
      const names = new Set<string>();
      featureNames(rule.when, names);
      const used: Record<string, Value> = {};
      names.forEach(n => (used[n] = f[n]));
      return { outcome: rule.then, trace: { ruleIndex: i, used } };
    }
  }
  return { outcome: program.otherwise, trace: { ruleIndex: -1, used: {} } };
}

export function complexity(program: SkillProgram): number {
  const count = (e: Expr): number => {
    switch (e.op) {
      case 'cmp':
        return 1 + count(e.a) + count(e.b);
      case 'and':
      case 'or':
      case 'arith':
        return 1 + e.args.reduce((s, a) => s + count(a), 0);
      case 'not':
        return 1 + count(e.a);
      default:
        return 1;
    }
  };
  return program.rules.reduce((s, r) => s + 1 + count(r.when), 1);
}

// Structural checks every candidate must pass before it is evaluated: known
// features only, enum literals from the declared set, outcomes from the domain,
// bounded size, and numeric constants that cannot encode an identifier.
export function validate(program: SkillProgram): string[] {
  // A model can hand back anything; malformed structure is a problem, not a crash.
  try {
    return validateShape(program);
  } catch (e) {
    return [`malformed program: ${(e as Error).message}`];
  }
}

function validateShape(program: SkillProgram): string[] {
  const problems: string[] = [];
  if (!program || !Array.isArray(program.rules) || !program.otherwise || typeof program.otherwise.decide !== 'string') return ['program needs rules[] and an otherwise outcome'];
  if (program.rules.some(r => !r || !r.when || !r.then || typeof r.then.decide !== 'string')) return ['every rule needs a when and a then.decide'];
  const spec = DOMAINS[program.domain] as DomainSpec | undefined;
  if (!spec) return [`unknown domain ${String(program.domain)}`];
  const outcomes = new Set(spec.outcomes);
  const check = (e: Expr): void => {
    switch (e.op) {
      case 'feat':
        if (!(e.name in spec.features)) problems.push(`unknown feature ${e.name}`);
        return;
      case 'num':
        if (!Number.isFinite(e.v)) problems.push('non-finite constant');
        if (Math.abs(e.v) > 1e9) problems.push(`constant ${e.v} too large`);
        if (Number.isInteger(e.v) && Math.abs(e.v) >= 1000 && Math.abs(e.v) % 100 !== 0)
          problems.push(`constant ${e.v} looks like an identifier or an exact amount; round it`);
        return;
      case 'enum': {
        const allowed = Object.values(spec.features).flatMap(fs => fs.values ?? []);
        if (!allowed.includes(e.v)) problems.push(`enum literal ${e.v} not declared`);
        return;
      }
      case 'bool':
        return;
      case 'cmp':
        check(e.a);
        check(e.b);
        return;
      case 'and':
      case 'or':
      case 'arith':
        if (e.args.length === 0) problems.push(`${e.op} with no arguments`);
        e.args.forEach(check);
        return;
      case 'not':
        check(e.a);
        return;
      default:
        problems.push(`unknown expression ${JSON.stringify(e).slice(0, 60)}`);
    }
  };
  if (program.rules.length > 12) problems.push('more than 12 rules');
  program.rules.forEach(r => {
    check(r.when);
    if (!outcomes.has(r.then.decide)) problems.push(`unknown outcome ${r.then.decide}`);
  });
  if (!outcomes.has(program.otherwise.decide)) problems.push(`unknown outcome ${program.otherwise.decide}`);
  if (complexity(program) > 80) problems.push('program too complex');
  return problems;
}

// Shorthand builders used by seed skills and tests.
export const F = (name: string): Expr => ({ op: 'feat', name });
export const N = (v: number): Expr => ({ op: 'num', v });
export const B = (v: boolean): Expr => ({ op: 'bool', v });
export const E = (v: string): Expr => ({ op: 'enum', v });
export const cmp = (c: 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'ne', a: Expr, b: Expr): Expr => ({ op: 'cmp', c, a, b });
export const and = (...args: Expr[]): Expr => ({ op: 'and', args });
export const or = (...args: Expr[]): Expr => ({ op: 'or', args });
export const not = (a: Expr): Expr => ({ op: 'not', a });
export const arith = (f: 'add' | 'sub' | 'mul' | 'div' | 'abs' | 'max' | 'min', ...args: Expr[]): Expr => ({ op: 'arith', f, args });
