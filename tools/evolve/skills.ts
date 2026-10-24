// Skill evolution for one domain. People's answers are the only teacher; every
// candidate is replayed over the features the seats actually saw, and must pass
// the gate before a person is even asked to look at it.
import { complexity, DOMAINS, run, validate, type Expr, type FeatureMap, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { createHash } from 'node:crypto';
import { llmJson, parseJson, type Db, type Row } from './lib';

export type Domain = keyof typeof DOMAINS;

export interface Example {
  subject: string;
  features: FeatureMap;
  label: string; // the outcome a person (or a field audit) said was right
  source: string;
  reason: string;
  at: string;
}

export interface History {
  skills: Row[];
  decisions: Row[]; // live decisions, not shadow
  asks: Row[];
  audits: Row[]; // facts with attr 'audit'
}

export async function loadHistory(db: Db): Promise<History> {
  const [skills, decisions, asks, facts] = await Promise.all([
    db.sql('SELECT key, domain, version, status, program, parent, provenance, proof, created_at FROM skill'),
    db.sql('SELECT id, at, seat, domain, subject, features, skill_key, outcome, shadow FROM decision'),
    db.sql('SELECT id, created_at, kind, subject, evidence, status, answer, reason, answered_by, answered_at FROM ask'),
    db.sql('SELECT id, subject, attr, value, valid_from FROM fact'),
  ]);
  decisions.sort((a, b) => a.id - b.id);
  return { skills, decisions: decisions.filter(d => !d.shadow), asks, audits: facts.filter(f => f.attr === 'audit') };
}

// Which person-facing answers teach which domain, and what outcome they mean.
const ASK_LABELS: Record<string, { domain: Domain; map: Record<string, string> }> = {
  audit: { domain: 'underreport', map: { 'request audit': 'flag_audit', 'explained — accept report': 'accept' } },
  collections: { domain: 'pre_chase', map: { chase: 'chase', 'hold 7 days': 'hold', escalate: 'escalate_controller' } },
  bill_exception: { domain: 'bill_match', map: { approve: 'approve', reject: 'reject', hold: 'hold_exception' } },
};

const ESCALATE = new Set(['flag_audit', 'ask_consultant']);

// Two outcomes agree if they lead to the same treatment of the case.
export function agrees(domain: Domain, a: string, b: string): boolean {
  return domain === 'underreport' ? ESCALATE.has(a) === ESCALATE.has(b) : a === b;
}

// Domain safety rules a candidate may never break on any past case.
const SAFETY: Record<Domain, (f: FeatureMap, outcome: string) => string | null> = {
  underreport: () => null,
  pre_chase: (f, o) => (o === 'chase' && Number(f.days_past_due) <= Number(f.grace_days) ? 'chases inside the contractual grace period' : null),
  allocation: (f, o) => (o === 'apply_unique' && Number(f.solution_count) > 1 && f.remittance_consistent !== true ? 'applies cash when several invoice sets fit and the payer did not say which' : null),
  routing_change: (f, o) => (o === 'ask_controller' && f.source_trusted !== true && f.callback_status !== 'confirmed' ? 'sends an unverified bank change to approval' : null),
  bill_match: (f, o) => (o === 'approve' && f.po_found !== true ? 'approves a bill with no purchase order' : null),
};

export const AUDIT_BUDGET = 0.06; // at most 6% of store-weeks may be sent for audit
export const CHANGE_BUDGET = 0.1; // a new version may change at most 10% of past decisions

export function latestBySubject(h: History, domain: Domain): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const d of h.decisions) if (d.domain === domain) out.set(d.subject, d);
  return out;
}

// What the organization knows, never the answer key. `hidden` holds subjects of
// the locked test and live splits, which the evolver must not learn from.
export function examplesFor(h: History, domain: Domain, hidden: Set<string>): Example[] {
  const latest = latestBySubject(h, domain);
  const bySubject = new Map<string, Example>();
  for (const a of [...h.asks].sort((x, y) => x.id - y.id)) {
    if (a.status !== 'answered') continue;
    const ev = parseJson<{ features?: FeatureMap }>(a.evidence, {});
    let label: string | undefined;
    let subject = a.subject;
    if (a.kind === `correction:${domain}`) {
      label = a.answer; // a person marked a decision wrong and said what it should have been
    } else if (a.kind === `spot_check:${domain}`) {
      label = a.answer === 'correct' ? String((ev as { decided?: string }).decided ?? '') : a.answer;
    } else if (a.kind === 'allocation' && domain === 'allocation') {
      // The person picked the payer's own list when it was there: the seat could have applied it.
      label = a.answer !== 'apply oldest first' && ev.features?.remittance_consistent === true ? 'apply_unique' : 'leave_unapplied_ask';
    } else {
      const spec = ASK_LABELS[a.kind];
      if (!spec || spec.domain !== domain) continue;
      label = spec.map[a.answer];
      if (domain === 'pre_chase') subject = `${a.subject}:${a.created_at}`;
    }
    if (!label) continue;
    const features = ev.features ?? parseJson<FeatureMap>(latest.get(subject)?.features ?? '{}', {});
    if (!Object.keys(features).length) continue;
    bySubject.set(subject, { subject, features, label, source: `ask #${a.id} answered by ${a.answered_by}`, reason: a.reason, at: a.answered_at });
  }
  if (domain === 'underreport') {
    // A closed field audit is the strongest label there is; it overrides an answer.
    for (const f of h.audits) {
      const v = parseJson<{ store: string; week: string; status: string; owedCents?: number; note?: string; by?: string }>(f.value, { store: '', week: '', status: '' });
      if (v.status !== 'closed') continue;
      const subject = `store:${v.store}:${v.week}`;
      const prior = bySubject.get(subject);
      const features = prior?.features ?? parseJson<FeatureMap>(latest.get(subject)?.features ?? '{}', {});
      if (!Object.keys(features).length) continue;
      bySubject.set(subject, { subject, features, label: (v.owedCents ?? 0) > 0 ? 'flag_audit' : 'accept', source: `field audit by ${v.by ?? 'consultant'}`, reason: v.note ?? prior?.reason ?? '', at: f.valid_from });
    }
  }
  return [...bySubject.values()].filter(e => !hidden.has(e.subject));
}

export interface Evaluation {
  problems: string[];
  labeled: { n: number; correctBefore: number; correctAfter: number; fixed: string[]; broken: string[] };
  lesson: { subjects: string[]; fixed: boolean };
  budget: { flagged: number; total: number; rate: number; limit: number } | null;
  changed: { n: number; total: number; rate: number; limit: number };
  newLeads: string[];
  safety: string[];
  complexity: number;
  robustness: number; // share of ±10% perturbations of labeled cases still decided as people said
  gate: 'pass' | 'fail';
  why: string[];
}

// Continuous features only: money amounts and shares, not counts or flags.
function perturb(f: FeatureMap, seed: string, k = 24): FeatureMap[] {
  let s = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const out: FeatureMap[] = [];
  for (let i = 0; i < k; i++) {
    const g: FeatureMap = {};
    for (const [key, v] of Object.entries(f)) g[key] = typeof v === 'number' && (!Number.isInteger(v) || Math.abs(v) > 50) ? v * (0.9 + rnd() * 0.2) : v;
    out.push(g);
  }
  return out;
}

function robustness(domain: Domain, p: SkillProgram, examples: Example[]): number {
  if (!examples.length) return 0;
  let ok = 0;
  let n = 0;
  for (const e of examples)
    for (const g of perturb(e.features, e.subject)) {
      n++;
      try {
        if (agrees(domain, run(p, g).outcome.decide, e.label)) ok++;
      } catch {
        /* counts as wrong */
      }
    }
  return ok / n;
}

export function evaluate(domain: Domain, current: SkillProgram, candidate: SkillProgram, examples: Example[], lesson: Example[], h: History, hidden: Set<string>): Evaluation {
  const problems = validate(candidate);
  const decide = (p: SkillProgram, f: FeatureMap) => {
    try {
      return run(p, f).outcome.decide;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  };
  const fixed: string[] = [];
  const broken: string[] = [];
  let before = 0;
  let after = 0;
  for (const e of examples) {
    const b = agrees(domain, decide(current, e.features), e.label);
    const a = agrees(domain, decide(candidate, e.features), e.label);
    before += b ? 1 : 0;
    after += a ? 1 : 0;
    if (!b && a) fixed.push(e.subject);
    if (b && !a) broken.push(e.subject);
  }
  const lessonFixed = lesson.every(e => agrees(domain, decide(candidate, e.features), e.label));
  const past = [...latestBySubject(h, domain).values()].filter(d => !hidden.has(d.subject));
  const labeledSubjects = new Set(examples.map(e => e.subject));
  let changedN = 0;
  let flagged = 0;
  const newLeads: string[] = [];
  const safety: string[] = [];
  for (const d of past) {
    const f = parseJson<FeatureMap>(d.features, {});
    const o = decide(candidate, f);
    const c = decide(current, f);
    if (!agrees(domain, o, c)) changedN++;
    if (domain === 'underreport' && ESCALATE.has(o)) flagged++;
    if (domain === 'underreport' && ESCALATE.has(o) && !ESCALATE.has(c) && !labeledSubjects.has(d.subject)) newLeads.push(d.subject);
    const s = SAFETY[domain](f, o);
    if (s) safety.push(`${d.subject}: ${s}`);
    if (o.startsWith('error')) safety.push(`${d.subject}: ${o}`);
  }
  const total = past.length || 1;
  const budget = domain === 'underreport' ? { flagged, total: past.length, rate: flagged / total, limit: AUDIT_BUDGET } : null;
  const changed = { n: changedN, total: past.length, rate: changedN / total, limit: CHANGE_BUDGET };
  const why: string[] = [];
  if (problems.length) why.push(`invalid: ${problems.join('; ')}`);
  if (!lessonFixed) why.push('does not handle the case people just taught');
  if (broken.length) why.push(`gets ${broken.length} case(s) wrong that the current version gets right`);
  if (budget && budget.rate > budget.limit) why.push(`would send ${(budget.rate * 100).toFixed(1)}% of store-weeks to audit (limit ${budget.limit * 100}%)`);
  if (changed.rate > changed.limit) why.push(`changes ${(changed.rate * 100).toFixed(1)}% of past decisions (limit ${changed.limit * 100}%)`);
  if (safety.length) why.push(`${safety.length} safety violation(s)`);
  return {
    problems,
    labeled: { n: examples.length, correctBefore: before, correctAfter: after, fixed, broken },
    lesson: { subjects: lesson.map(e => e.subject), fixed: lessonFixed },
    budget,
    changed,
    newLeads,
    safety: safety.slice(0, 20),
    complexity: problems.length ? 0 : complexity(candidate),
    robustness: problems.length ? 0 : robustness(domain, candidate, examples),
    gate: why.length === 0 ? 'pass' : 'fail',
    why,
  };
}

// ---------- proposing ----------

const GRAMMAR = `A skill is JSON: {"domain": "<domain>", "rules": [{"when": <expr>, "then": {"decide": "<outcome>", "note": "<short reason shown to people>"}}], "otherwise": {"decide": "<outcome>"}}. Rules are checked in order; the first whose "when" is true decides.
Expressions:
{"op":"feat","name":"<feature>"}  {"op":"num","v":<number>}  {"op":"bool","v":true|false}  {"op":"enum","v":"<literal>"}
{"op":"cmp","c":"gt|ge|lt|le|eq|ne","a":<expr>,"b":<expr>}
{"op":"and","args":[<expr>,...]}  {"op":"or","args":[...]}  {"op":"not","a":<expr>}
{"op":"arith","f":"add|sub|mul|div|abs|max|min","args":[<expr>,...]}
Limits: at most 8 rules; numbers of 1000 or more must be multiples of 100; never test for a specific store, person or amount — rules must describe a pattern.`;

function describeDomain(domain: Domain): string {
  const spec = DOMAINS[domain];
  const feats = Object.entries(spec.features).map(([k, v]) => `- ${k} (${v.type}${'values' in v && v.values ? `: ${v.values.join('|')}` : ''}): ${v.doc}`);
  return `Domain "${domain}": ${spec.doc}\nOutcomes: ${spec.outcomes.join(', ')}\nFeatures:\n${feats.join('\n')}`;
}

function show(f: FeatureMap): string {
  return Object.entries(f)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : v}`)
    .join(', ');
}

function percentiles(h: History, domain: Domain): string {
  const rows = [...latestBySubject(h, domain).values()].map(d => parseJson<FeatureMap>(d.features, {}));
  const lines: string[] = [];
  for (const [k, spec] of Object.entries(DOMAINS[domain].features)) {
    if (spec.type !== 'number') continue;
    const xs = rows.map(r => Number(r[k])).filter(Number.isFinite).sort((a, b) => a - b);
    if (!xs.length) continue;
    const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    lines.push(`- ${k}: p5=${q(0.05).toFixed(3)} p50=${q(0.5).toFixed(3)} p95=${q(0.95).toFixed(3)}`);
  }
  return lines.join('\n');
}

const STYLES = [
  { temperature: 0.2, hint: 'Make the smallest change that handles the new lesson: add or adjust one rule and keep the rest.' },
  { temperature: 0.6, hint: 'Be robust to confounders: compare a store with its own history and with its peers, and require two independent signals before escalating, so stores that are legitimately different are not flagged.' },
  { temperature: 0.9, hint: 'Think about what pattern the person described in general terms, and encode that pattern as simply as possible.' },
];

export async function propose(model: string, domain: Domain, current: SkillProgram, lesson: Example[], examples: Example[], h: History): Promise<{ program: SkillProgram; rationale: string; style: number; cached: boolean }[]> {
  const keep = examples.filter(e => !lesson.some(l => l.subject === e.subject)).slice(-12);
  const user = [
    describeDomain(domain),
    `\nCurrent team skill:\n${JSON.stringify(current)}`,
    `\nWhat people just taught the team (the current skill decides these wrongly):\n${lesson.map(e => `- ${e.subject}: correct outcome "${e.label}". ${e.source}: "${e.reason}"\n  features: ${show(e.features)}`).join('\n')}`,
    keep.length ? `\nOther cases people have labeled (keep these right):\n${keep.map(e => `- ${e.subject}: "${e.label}"; ${show(e.features)}`).join('\n')}` : '',
    `\nHow the features are distributed over all past cases:\n${percentiles(h, domain)}`,
    `\nReturn JSON: {"program": <skill>, "rationale": "<two sentences>"}`,
  ].join('\n');
  const out: { program: SkillProgram; rationale: string; style: number; cached: boolean }[] = [];
  const results = await Promise.allSettled(
    STYLES.map((s, i) =>
      llmJson(model, `You improve a finance team's decision skill from what its people taught it.\n${GRAMMAR}\n${s.hint}`, user, s.temperature).then(r => ({ r, i }))
    )
  );
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    const p = res.value.r.json?.program as SkillProgram | undefined;
    if (p && Array.isArray(p.rules)) out.push({ program: { ...p, domain }, rationale: String(res.value.r.json?.rationale ?? ''), style: res.value.i, cached: res.value.r.cached });
  }
  return out;
}

// The model proposes structure; the evaluator tunes its constants by replay.
export function tune(domain: Domain, current: SkillProgram, cand: SkillProgram, examples: Example[], lesson: Example[], h: History, hidden: Set<string>): SkillProgram[] {
  const nums: { set: (v: number) => void; v: number }[] = [];
  const clone = JSON.parse(JSON.stringify(cand)) as SkillProgram;
  const walk = (e: Expr) => {
    if (e.op === 'num') nums.push({ v: e.v, set: v => (e.v = v) });
    else if (e.op === 'cmp') (walk(e.a), walk(e.b));
    else if (e.op === 'and' || e.op === 'or' || e.op === 'arith') e.args.forEach(walk);
    else if (e.op === 'not') walk(e.a);
  };
  clone.rules.forEach(r => walk(r.when));
  const round = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v / 100) * 100 : Math.round(v * 100) / 100);
  const variants: SkillProgram[] = [];
  for (const n of nums.slice(0, 8)) {
    if (n.v === 0 || n.v === 1) continue;
    for (const m of [0.85, 0.93, 1.07, 1.15]) {
      const original = n.v;
      n.set(round(original * m));
      variants.push(JSON.parse(JSON.stringify(clone)));
      n.set(original);
    }
  }
  return variants.filter(v => evaluate(domain, current, v, examples, lesson, h, hidden).gate === 'pass');
}
