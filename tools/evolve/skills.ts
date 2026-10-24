// Skill evolution for one domain. People's answers are the only teacher; every
// candidate is replayed over the features the seats actually saw, and must pass
// the gate before a person is even asked to look at it.
import { ASKS, complexity, DOMAINS, ESCALATING, parseTreatments, run, sameTreatment, validate, type Expr, type FeatureMap, type SkillProgram, type Treatments } from '../../module/spacetimedb/src/core/dsl';
import { createHash } from 'node:crypto';
import { llmJson, parseJson, type Db, type Row } from './lib';
import { allocationLabel, labelBreach, landing } from '../../module/spacetimedb/src/core/labels';

export type Domain = keyof typeof DOMAINS;

export interface Example {
  subject: string;
  features: FeatureMap;
  label: string; // the outcome a person (or a field audit) said was right
  treatments?: Treatments; // what each outcome would have done with this case
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
    db.sql('SELECT id, at, seat, domain, subject, features, skill_key, outcome, shadow, treatments FROM decision'),
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
export const agrees = (domain: Domain, a: string, b: string, treatments?: Treatments): boolean => sameTreatment(domain, a, b, treatments);

// The answer key's verdict on an outcome, for grading only. Cash is right when the
// money would land on the invoices the payer meant, or, when no outcome would put
// it there, when a person is asked.
export function graded(domain: Domain, outcome: string, expected: string, truthInvoices?: string[], treatments?: Treatments): boolean {
  if (domain !== 'allocation' || !treatments || !truthInvoices) return agrees(domain, outcome, expected);
  const truth = landing(truthInvoices.map(id => ({ id })));
  return treatments[outcome] === (Object.values(treatments).includes(truth) ? truth : ASKS);
}

// Domain safety rules a candidate may never break on any past case.
const SAFETY: Record<Domain, (f: FeatureMap, outcome: string) => string | null> = {
  underreport: () => null,
  pre_chase: (f, o) => labelBreach('pre_chase', f, o),
  allocation: (f, o) =>
    o === 'apply_unique' && Number(f.solution_count) > 1 && f.remittance_consistent !== true && f.reference_matches_open !== true
      ? 'applies cash when several invoice sets fit and the payer did not say which'
      : o === 'apply_to_reference' && f.reference_names_open !== true
        ? 'applies to a reference that names no single open invoice'
        : null,
  routing_change: (f, o) => (o === 'ask_controller' && f.source_trusted !== true && f.callback_status !== 'confirmed' ? 'sends an unverified bank change to approval' : null),
  bill_match: (f, o) => (o === 'approve' && f.po_found !== true ? 'approves a bill with no purchase order' : null),
};

// The same rules in words, for the proposer.
export const SAFETY_TEXT: Record<Domain, string> = {
  underreport: 'none beyond the audit budget',
  pre_chase: 'never chase inside the contractual grace period',
  allocation: 'never apply cash when several invoice sets fit unless the payer said which (remittance_consistent or reference_matches_open); apply_to_reference only when reference_names_open',
  routing_change: 'never send an unverified bank change to approval',
  bill_match: 'never approve a bill that has no purchase order',
};

// What a lesson asks of a candidate: cases it must now get right (the current
// version settled them alone and was wrong) and cases it may take over (the
// current version asked a person who then said it could have been settled).
export function splitLessons(domain: Domain, current: SkillProgram, examples: Example[]): { required: Example[]; optional: Example[] } {
  const escalating = ESCALATING[domain] ?? [];
  const required: Example[] = [];
  const optional: Example[] = [];
  for (const e of examples) {
    const out = run(current, e.features).outcome.decide;
    if (agrees(domain, out, e.label, e.treatments)) continue;
    if (escalating.includes(out) && !escalating.includes(e.label)) optional.push(e);
    else required.push(e);
  }
  return { required, optional };
}

// Taking work away from people needs precedent: every rule that settles cases a
// person used to see must rest on at least this many labeled cases, all agreeing.
export const MIN_SUPPORT = 3;

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
    const ev = parseJson<{ features?: FeatureMap; treatments?: Treatments }>(a.evidence, {});
    let label: string | undefined;
    let subject = a.subject;
    if (a.kind === `correction:${domain}`) {
      label = a.answer; // a person marked a decision wrong and said what it should have been
    } else if (a.kind === `spot_check:${domain}`) {
      label = a.answer === 'correct' ? String((ev as { decided?: string }).decided ?? '') : a.answer;
    } else if (a.kind === 'label_check' && (ev as { domain?: string }).domain === domain) {
      // The person looked again: a slip confirms the seat, otherwise the verdict stands.
      const v = ev as { decided?: string; verdict?: string };
      label = String((a.answer.startsWith('a slip') ? v.decided : v.verdict) ?? '');
    } else if (a.kind === 'allocation' && domain === 'allocation') {
      // The person picked the payer's own list when it was there: the seat could have applied it.
      label = allocationLabel(ev as never, a.answer);
    } else {
      const spec = ASK_LABELS[a.kind];
      if (!spec || spec.domain !== domain) continue;
      label = spec.map[a.answer];
      if (domain === 'pre_chase') subject = `${a.subject}:${a.created_at}`;
    }
    if (!label) continue;
    const features = ev.features ?? parseJson<FeatureMap>(latest.get(subject)?.features ?? '{}', {});
    const treatments = parseTreatments(JSON.stringify(ev.treatments ?? {})) ?? parseTreatments(latest.get(subject)?.treatments);
    // A verdict that breaks the agreement was pushed back on, not learned from.
    if (!Object.keys(features).length || labelBreach(domain, features, label)) continue;
    bySubject.set(subject, { subject, features, label, treatments, source: `ask #${a.id} answered by ${a.answered_by}`, reason: a.reason, at: a.answered_at });
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
  // A verdict still waiting for the person to look again teaches nothing yet.
  const pending = new Set(h.asks.filter(a => a.kind === 'label_check' && a.status === 'open').map(a => a.subject));
  return [...bySubject.values()].filter(e => !hidden.has(e.subject) && !pending.has(e.subject));
}

export interface Evaluation {
  problems: string[];
  labeled: { n: number; correctBefore: number; correctAfter: number; fixed: string[]; broken: string[]; asksAgain: string[] };
  lesson: { subjects: string[]; fixed: boolean; handled: string[]; optionalFixed: number; optionalTotal: number };
  budget: { flagged: number; total: number; rate: number; limit: number } | null;
  changed: { n: number; total: number; rate: number; limit: number };
  newLeads: string[];
  safety: string[];
  complexity: number;
  robustness: number; // share of ±10% perturbations of labeled cases still decided as people said
  gate: 'pass' | 'fail';
  why: string[];
  offenders: number[]; // candidate rules behind a failure: thin takeovers, broken cases, safety violations
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
        if (agrees(domain, run(p, g).outcome.decide, e.label, e.treatments)) ok++;
      } catch {
        /* counts as wrong */
      }
    }
  return ok / n;
}

export function evaluate(domain: Domain, current: SkillProgram, candidate: SkillProgram, examples: Example[], lesson: Example[], h: History, hidden: Set<string>, optional: Example[] = []): Evaluation {
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
  const asksAgain: string[] = [];
  let before = 0;
  let after = 0;
  const escalating = ESCALATING[domain] ?? [];
  for (const e of examples) {
    const cur = decide(current, e.features);
    const cand = decide(candidate, e.features);
    const b = agrees(domain, cur, e.label, e.treatments);
    const a = agrees(domain, cand, e.label, e.treatments);
    before += b ? 1 : 0;
    after += a ? 1 : 0;
    if (!b && a) fixed.push(e.subject);
    // Broken: settled alone and wrongly where the current version was right or
    // asked a person. Asking where the current version was right puts no money in
    // the wrong place, it hands autonomy back, and has to be paid for with fixes.
    if (!a && !escalating.includes(cand) && (b || escalating.includes(cur))) broken.push(e.subject);
    else if (b && !a) asksAgain.push(e.subject);
  }
  const optionalFixed = optional.filter(e => agrees(domain, decide(candidate, e.features), e.label, e.treatments)).length;
  // Takeovers grouped by the candidate rule that settles them.
  const takeovers = new Map<number, { n: number; disagree: number }>();
  for (const e of examples) {
    const cur = decide(current, e.features);
    if (!escalatingOf(domain).includes(cur)) continue;
    const r = runRule(candidate, e.features);
    if (!r || escalatingOf(domain).includes(r.decide)) continue;
    const t = takeovers.get(r.rule) ?? { n: 0, disagree: 0 };
    t.n++;
    if (!agrees(domain, r.decide, e.label, e.treatments)) t.disagree++;
    takeovers.set(r.rule, t);
  }
  const thin = [...takeovers.entries()].filter(([, t]) => t.n < MIN_SUPPORT || t.disagree > 0);
  // No evidence, no removal: a rule of the current version may be changed or
  // dropped only if a labeled case shows it deciding wrongly.
  const sig = (r: SkillProgram['rules'][number]) => JSON.stringify([r.when, r.then?.decide]);
  const keptRules = new Set(candidate.rules?.map(sig) ?? []);
  const wrongBy = new Set<number>();
  for (const e of examples) {
    const r = runRule(current, e.features);
    if (r && !agrees(domain, r.decide, e.label, e.treatments)) wrongBy.add(r.rule);
  }
  const dropped = current.rules.flatMap((r, i) => (!keptRules.has(sig(r)) && !wrongBy.has(i) ? [`rule ${i} ("${r.then.note ?? r.then.decide}")`] : []));
  if (candidate.otherwise?.decide !== current.otherwise.decide && !wrongBy.has(-1)) dropped.push(`the default ("${current.otherwise.decide}")`);
  const offenders = new Set<number>(thin.map(([rule]) => rule));
  for (const e of examples) if (broken.includes(e.subject)) offenders.add(runRule(candidate, e.features)?.rule ?? -1);
  // People's answers carry slips: a candidate must handle at least one case they
  // taught and break nothing they labeled; the lessons it leaves are listed in its
  // proof and stay lessons for the next round.
  const lessonsHandled = lesson.filter(e => agrees(domain, decide(candidate, e.features), e.label, e.treatments)).map(e => e.subject);
  const lessonFixed = lesson.length ? lessonsHandled.length > 0 : optionalFixed > 0;
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
    // Labeled cases are judged by fixed/broken; the budget guards unknown territory.
    if (!agrees(domain, o, c, parseTreatments(d.treatments)) && !labeledSubjects.has(d.subject)) changedN++;
    if (domain === 'underreport' && ESCALATE.has(o)) flagged++;
    if (domain === 'underreport' && ESCALATE.has(o) && !ESCALATE.has(c) && !labeledSubjects.has(d.subject)) newLeads.push(d.subject);
    const s = SAFETY[domain](f, o);
    if (s) safety.push(`${d.subject}: ${s}`);
    if (s) offenders.add(runRule(candidate, f)?.rule ?? -1);
    if (o.startsWith('error')) safety.push(`${d.subject}: ${o}`);
  }
  const total = past.length || 1;
  const budget = domain === 'underreport' ? { flagged, total: past.length, rate: flagged / total, limit: AUDIT_BUDGET } : null;
  const changed = { n: changedN, total: past.length, rate: changedN / total, limit: CHANGE_BUDGET };
  const why: string[] = [];
  if (problems.length) why.push(`invalid: ${problems.join('; ')}`);
  if (!lessonFixed) why.push(lesson.length ? 'handles none of the cases people just taught' : 'takes over none of the cases people said could be settled');
  if (broken.length) why.push(`gets ${broken.length} case(s) wrong that the current version gets right`);
  if (asksAgain.length && after <= before) why.push(`asks a person again about ${asksAgain.length} case(s) the current version settles rightly, and fixes no more than that`);
  if (budget && budget.rate > budget.limit) why.push(`would send ${(budget.rate * 100).toFixed(1)}% of store-weeks to audit (limit ${budget.limit * 100}%)`);
  if (changed.rate > changed.limit) why.push(`changes ${(changed.rate * 100).toFixed(1)}% of past decisions (limit ${changed.limit * 100}%)`);
  if (safety.length) why.push(`${safety.length} safety violation(s)`);
  for (const d of dropped) why.push(`changes or drops ${d} of the current version though no labeled case shows it was wrong`);
  for (const [rule, t] of thin) why.push(`rule ${rule} would take over work people did on the strength of ${t.n} labeled case(s)${t.disagree ? `, ${t.disagree} of which disagree` : ''} (needs ${MIN_SUPPORT}, unanimous)`);
  return {
    problems,
    labeled: { n: examples.length, correctBefore: before, correctAfter: after, fixed, broken, asksAgain },
    lesson: { subjects: lesson.map(e => e.subject), fixed: lessonFixed, handled: lessonsHandled, optionalFixed, optionalTotal: optional.length },
    budget,
    changed,
    newLeads,
    safety: safety.slice(0, 20),
    complexity: problems.length ? 0 : complexity(candidate),
    robustness: problems.length ? 0 : robustness(domain, candidate, examples),
    gate: why.length === 0 ? 'pass' : 'fail',
    why,
    offenders: [...offenders].filter(r => r >= 0).sort((a, b) => a - b),
  };
}

// No evidence, no new rule: a rule the candidate adds or changes that decides
// none of the cases the organization has seen would act only on cases nobody
// has checked, so it is dropped before the gate. Dropping it changes no
// replayed decision. Rules carried over from the current version stay.
export function prune(domain: Domain, current: SkillProgram, cand: SkillProgram, examples: Example[], h: History, hidden: Set<string>): SkillProgram {
  const sig = (r: SkillProgram['rules'][number]) => JSON.stringify([r.when, r.then?.decide]);
  const inherited = new Set(current.rules.map(sig));
  const fired = new Set<number>();
  const mark = (f: FeatureMap) => {
    const r = runRule(cand, f);
    if (r) fired.add(r.rule);
  };
  for (const e of examples) mark(e.features);
  for (const d of latestBySubject(h, domain).values()) if (!hidden.has(d.subject)) mark(parseJson<FeatureMap>(d.features, {}));
  const rules = cand.rules.filter((r, i) => fired.has(i) || inherited.has(sig(r)));
  return rules.length === cand.rules.length ? cand : { ...cand, rules };
}

// A whole program can fail on one rule the evidence does not support. Dropping
// the rules behind the failure, together or one at a time, keeps what the
// lesson needs; the result goes through the same gate.
export function repair(domain: Domain, current: SkillProgram, cand: SkillProgram, ev: Evaluation, examples: Example[], lesson: Example[], h: History, hidden: Set<string>, optional: Example[] = []): SkillProgram[] {
  if (!ev.offenders.length || ev.offenders.length >= cand.rules.length) return [];
  const without = (drop: number[]) => ({ ...cand, rules: cand.rules.filter((_, i) => !drop.includes(i)) });
  const variants = [without(ev.offenders), ...(ev.offenders.length > 1 ? ev.offenders.map(r => without([r])) : [])];
  return variants.filter(v => evaluate(domain, current, v, examples, lesson, h, hidden, optional).gate === 'pass');
}

function escalatingOf(domain: Domain): string[] {
  return ESCALATING[domain] ?? [];
}

function runRule(p: SkillProgram, f: FeatureMap): { rule: number; decide: string } | null {
  try {
    const r = run(p, f);
    return { rule: r.trace.ruleIndex, decide: r.outcome.decide };
  } catch {
    return null;
  }
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

// Outcomes that would have done what the label says on this case, for the proposer.
function alike(domain: Domain, e: Example): string {
  const t = e.treatments;
  const same = t && e.label in t ? (DOMAINS[domain].outcomes as readonly string[]).filter(o => o !== e.label && t[o] === t[e.label]) : [];
  return same.length ? ` (on this case ${same.map(o => `"${o}"`).join(' and ')} would do the same)` : '';
}

const STYLES = [
  { temperature: 0.2, hint: 'Make the smallest change that handles the new lesson: add or adjust one rule and keep the rest.' },
  { temperature: 0.6, hint: 'Be robust to confounders: compare a store with its own history and with its peers, and require two independent signals before escalating, so stores that are legitimately different are not flagged.' },
  { temperature: 0.9, hint: 'Think about what pattern the person described in general terms, and encode that pattern as simply as possible.' },
];

export async function propose(model: string, domain: Domain, current: SkillProgram, lesson: Example[], examples: Example[], h: History, optional: Example[] = []): Promise<{ program: SkillProgram; rationale: string; style: number; cached: boolean }[]> {
  const keep = examples.filter(e => !lesson.some(l => l.subject === e.subject) && !optional.some(o => o.subject === e.subject)).slice(-12);
  const user = [
    describeDomain(domain),
    `\nCurrent team skill:\n${JSON.stringify(current)}`,
    lesson.length ? `\nMistakes people found (the current skill settled these alone and was wrong; the new version must get them right):\n${lesson.map(e => `- ${e.subject}: correct outcome "${e.label}"${alike(domain, e)}. ${e.source}: "${e.reason}"\n  features: ${show(e.features)}`).join('\n')}` : '',
    optional.length ? `\nCases the current skill asked a person about, who settled them (take these over only if it is safe; otherwise keep asking):\n${optional.slice(-12).map(e => `- ${e.subject}: person decided "${e.label}"${alike(domain, e)}. "${e.reason}"\n  features: ${show(e.features)}`).join('\n')}` : '',
    `\nSafety rule that must never be broken: ${SAFETY_TEXT[domain]}.`,
    keep.length ? `\nOther cases people have labeled (keep these right):\n${keep.map(e => `- ${e.subject}: "${e.label}"${alike(domain, e)}; ${show(e.features)}`).join('\n')}` : '',
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

// Thresholds the model wrote sit wherever it guessed, often hugging the cases it
// was shown. Each constant of a new rule moves to the middle of the widest range
// of values that gets the most labeled cases right, leaves every unlabeled past
// decision as it was and passes the gate — when known cases bound that range on
// both sides. Rules carried over keep their constants.
export function center(domain: Domain, current: SkillProgram, cand: SkillProgram, examples: Example[], lesson: Example[], h: History, hidden: Set<string>, optional: Example[] = []): SkillProgram {
  const sig = (r: SkillProgram['rules'][number]) => JSON.stringify([r.when, r.then?.decide]);
  const inherited = new Set(current.rules.map(sig));
  const prog = JSON.parse(JSON.stringify(cand)) as SkillProgram;
  const nums: { set: (v: number) => void; v: number }[] = [];
  const walk = (e: Expr) => {
    if (e.op === 'num') nums.push({ v: e.v, set: v => (e.v = v) });
    else if (e.op === 'cmp') (walk(e.a), walk(e.b));
    else if (e.op === 'and' || e.op === 'or' || e.op === 'arith') e.args.forEach(walk);
    else if (e.op === 'not') walk(e.a);
  };
  prog.rules.forEach(r => inherited.has(sig(r)) || walk(r.when));
  const decide = (f: FeatureMap) => {
    try {
      return run(prog, f).outcome.decide;
    } catch {
      return 'error';
    }
  };
  const labeled = new Set(examples.map(e => e.subject));
  const unlabeled = [...latestBySubject(h, domain).values()].filter(d => !hidden.has(d.subject) && !labeled.has(d.subject)).map(d => ({ f: parseJson<FeatureMap>(d.features, {}), t: parseTreatments(d.treatments) }));
  const before = unlabeled.map(u => decide(u.f));
  const right = () => examples.filter(e => agrees(domain, decide(e.features), e.label, e.treatments)).length;
  const round = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v / 100) * 100 : Math.round(v * 1000) / 1000);
  for (const n of nums.slice(0, 8)) {
    const v0 = n.v;
    if (v0 === 0) continue;
    const grid = [...new Set(Array.from({ length: 121 }, (_, k) => round(v0 * (0.4 + k * 0.01))))].sort((a, b) => a - b);
    n.set(v0);
    const floor = right();
    const ok = grid.map(v => {
      n.set(v);
      if (!unlabeled.every((u, i) => agrees(domain, decide(u.f), before[i], u.t))) return -1;
      const r = right();
      return r >= floor && evaluate(domain, current, prog, examples, lesson, h, hidden, optional).gate === 'pass' ? r : -1;
    });
    const best = Math.max(...ok);
    let run0 = -1;
    let bestRun: [number, number] = [-1, -1];
    for (let i = 0; i <= grid.length; i++) {
      if (i < grid.length && ok[i] === best && best >= 0) {
        if (run0 < 0) run0 = i;
      } else if (run0 >= 0) {
        if (i - run0 > bestRun[1] - bestRun[0]) bestRun = [run0, i];
        run0 = -1;
      }
    }
    // Centre only between two known cases: a range that runs to the edge of the
    // scan has no evidence on that side, and the model's value stays.
    const bounded = bestRun[0] > 0 && bestRun[1] < grid.length;
    n.set(bestRun[0] < 0 || !bounded ? v0 : round((grid[bestRun[0]] + grid[bestRun[1] - 1]) / 2));
  }
  return prog;
}

// The model proposes structure; the evaluator tunes its constants by replay.
export function tune(domain: Domain, current: SkillProgram, cand: SkillProgram, examples: Example[], lesson: Example[], h: History, hidden: Set<string>, optional: Example[] = []): SkillProgram[] {
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
  return variants.filter(v => evaluate(domain, current, v, examples, lesson, h, hidden, optional).gate === 'pass');
}
