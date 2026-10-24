// How the team's knowledge got here: from a person's sentence to a skill
// version, through shadow and canary to active, into policies, and on to the
// cases it changed and the seats that inherited it. Everything is derived from
// public tables; nothing here is stored by the UI.
import type { Activity, Ask, Decision, Policy, Skill } from '../module_bindings/types';
import { day } from './format';
import { parseArr, parseLoose, parseObj } from './json';
import { parseProgram, run, skillVersion, type FeatureMap } from './rules';

export function askRefs(text: string): bigint[] {
  const out: bigint[] = [];
  const re = /\bask\s*[#:]\s*(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(BigInt(m[1]));
  const j = parseLoose<Record<string, unknown> | null>(text, null);
  if (j && typeof j === 'object') {
    for (const k of ['ask', 'askId', 'ask_id', 'fromAsk']) {
      const v = (j as Record<string, unknown>)[k];
      if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) out.push(BigInt(v));
    }
    const asks = (j as Record<string, unknown>).asks;
    if (Array.isArray(asks)) for (const v of asks) if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) out.push(BigInt(v));
  }
  return [...new Set(out.map(String))].map(s => BigInt(s));
}

export interface Transition {
  at: string;
  activityId: bigint;
  from: string;
  to: string;
  by: string;
  fraction?: number;
}

export function skillTransitions(key: string, activity: Activity[]): Transition[] {
  const out: Transition[] = [];
  for (const a of activity) {
    if (a.outcome !== 'committed') continue;
    if (a.command === 'propose_skill') {
      const p = parseObj(a.params);
      if (p.key === key) out.push({ at: a.at, activityId: a.id, from: '', to: 'proposed', by: a.principal });
    } else if (a.command === 'activate_skill') {
      const p = parseObj(a.params);
      if (p.key === key) out.push({ at: a.at, activityId: a.id, from: String(p.from ?? ''), to: String(p.to ?? ''), by: a.principal, fraction: typeof p.fraction === 'number' ? p.fraction : undefined });
    } else if (a.command === 'charter_founded') {
      const p = parseObj(a.params);
      const skills = Array.isArray(p.skills) ? (p.skills as string[]) : [];
      const { domain, version } = skillVersion(key);
      if (version === 1 && skills.includes(domain)) out.push({ at: a.at, activityId: a.id, from: '', to: 'active', by: a.principal });
    }
  }
  return out.sort((x, y) => (x.activityId < y.activityId ? -1 : 1));
}

// Re-run a parent version on the features a child decided, in the browser,
// with the kernel's interpreter: where they differ, the child changed the case.
export interface Changed {
  decision: Decision;
  was: string;
  now: string;
}

export function changedCases(child: Skill, parent: Skill | undefined, decisions: Decision[]): Changed[] {
  if (!parent) return [];
  const pp = parseProgram(parent.program);
  if (!pp) return [];
  const out: Changed[] = [];
  for (const d of decisions) {
    if (d.skillKey !== child.key || d.shadow) continue;
    const f = parseLoose<FeatureMap | null>(d.features, null);
    if (!f) continue;
    try {
      const was = run(pp, f).outcome.decide;
      if (was !== d.outcome) out.push({ decision: d, was, now: d.outcome });
    } catch {
      /* the parent read a feature this case lacks */
    }
  }
  return out;
}

// Replay a candidate against its parent on the latest live decision for every
// subject of its domain, the way the evolution engine gates proposals
// (tools/evolve/skills.ts), but over everything this browser can see.
export interface Replay {
  cases: number;
  flips: { decision: Decision; before: string; after: string }[];
  errors: number;
  ms: number;
}

export function replay(candidate: Skill, parent: Skill | undefined, decisions: Decision[]): Replay {
  const t0 = performance.now();
  const prog = parseProgram(candidate.program);
  const base = parent ? parseProgram(parent.program) : null;
  const res: Replay = { cases: 0, flips: [], errors: 0, ms: 0 };
  if (!prog) return res;
  const latest = new Map<string, Decision>();
  for (const d of [...decisions].sort((a, b) => (a.id < b.id ? -1 : 1))) if (d.domain === candidate.domain && !d.shadow) latest.set(d.subject, d);
  for (const d of latest.values()) {
    const f = parseLoose<FeatureMap | null>(d.features, null);
    if (!f || !Object.keys(f).length) continue;
    res.cases++;
    try {
      const after = run(prog, f).outcome.decide;
      const before = base ? run(base, f).outcome.decide : d.outcome;
      if (after !== before) res.flips.push({ decision: d, before, after });
    } catch {
      res.errors++;
    }
  }
  res.ms = Math.round(performance.now() - t0);
  return res;
}

export interface Inherit {
  activity: Activity;
  seat: string;
  skills: string[];
  policies: string[];
}

export function hires(activity: Activity[]): Inherit[] {
  const out: Inherit[] = [];
  for (const a of activity) {
    if (a.command !== 'hire_seat' || a.outcome !== 'committed') continue;
    const p = parseObj(a.params);
    const inh = (p.inherits ?? {}) as { skills?: string[]; policies?: string[] };
    out.push({ activity: a, seat: String(p.seat ?? ''), skills: inh.skills ?? [], policies: inh.policies ?? [] });
  }
  return out;
}

export interface LineageStep {
  kind: 'origin' | 'proposed' | 'proof' | 'status' | 'policy' | 'changed' | 'reopened' | 'inherited';
  at: string;
  order: number;
  title: string;
  detail?: string;
  by?: string;
  activityId?: bigint;
  status?: string;
  ok?: boolean;
}

export interface Origin {
  text: string;
  by: string; // principal id, e.g. consultant:Lee
  answer: string;
  subject: string;
  askId?: bigint;
  at: string;
  kind: string; // the ask kind, or 'lesson' when only the proof carries it
}

export interface Lineage {
  skill: Skill;
  parent?: Skill;
  origins: Origin[];
  steps: LineageStep[];
  changed: Changed[];
  live: Changed[]; // decisions made on new work that the parent would have made differently
  reopened: Changed[]; // past weeks the activation replay flagged
  policies: Policy[];
  inherited: Inherit[];
  replayAsks: Ask[];
}

export interface ProofSummary {
  gate?: string;
  fixed?: number;
  broken?: number;
  changed?: { n: number; total: number; limit?: number };
  newLeads: string[];
  violations?: number;
  raw: Record<string, unknown> | null;
}

export function proofSummary(proofText: string): ProofSummary {
  const raw = parseLoose<Record<string, unknown> | null>(proofText, null);
  if (!raw || typeof raw !== 'object') return { raw: null, newLeads: [] };
  const gate = typeof raw.gate === 'string' ? raw.gate : typeof raw.gate === 'boolean' ? (raw.gate ? 'pass' : 'fail') : undefined;
  const labeled = (raw.labeled ?? null) as { fixed?: unknown[]; broken?: unknown[] } | null;
  const ch = (raw.changed ?? null) as { n?: number; total?: number; limit?: number } | null;
  const vio = raw.safetyViolations ?? raw.violations;
  return {
    gate,
    fixed: Array.isArray(labeled?.fixed) ? labeled!.fixed!.length : undefined,
    broken: Array.isArray(labeled?.broken) ? labeled!.broken!.length : undefined,
    changed: ch && typeof ch.n === 'number' ? { n: ch.n, total: ch.total ?? 0, limit: ch.limit } : undefined,
    newLeads: Array.isArray(raw.newLeads) ? (raw.newLeads as string[]) : [],
    violations: Array.isArray(vio) ? vio.length : typeof vio === 'number' ? vio : undefined,
    raw,
  };
}

// The people a version learned from: asks it cites, or the lesson in its proof.
export function originsOf(skill: Skill, asks: Ask[]): Origin[] {
  const out: Origin[] = [];
  for (const id of askRefs(skill.provenance)) {
    const a = asks.find(x => x.id === id);
    if (a) out.push({ text: a.reason || a.answer, by: a.answeredBy, answer: a.answer, subject: a.subject, askId: a.id, at: a.answeredAt || a.createdAt, kind: a.kind });
  }
  if (out.length) return out;
  const proof = parseLoose<{ lesson?: { cases?: { subject: string; label: string; source: string; reason: string }[] } } | null>(skill.proof, null);
  for (const c of proof?.lesson?.cases ?? []) {
    const by = /answered by (\S+)/.exec(c.source)?.[1] ?? /audit by (\S+)/.exec(c.source)?.[1] ?? c.source;
    out.push({ text: c.reason, by, answer: c.label, subject: c.subject, at: '', kind: 'lesson' });
  }
  return out;
}

export function buildLineage(skill: Skill, all: { skills: Skill[]; asks: Ask[]; activity: Activity[]; decisions: Decision[]; policies: Policy[] }): Lineage {
  const parent = all.skills.find(s => s.key === skill.parent);
  const origins = originsOf(skill, all.asks);
  const steps: LineageStep[] = [];
  let order = 0;
  for (const o of origins) {
    const who = o.by.split(':')[1] ?? o.by;
    steps.push({ kind: 'origin', at: o.at, order: order++, title: `${who} ${o.kind.startsWith('correction') ? 'corrected' : 'answered'} “${o.answer.replace(/_/g, ' ')}”`, detail: subjectLabel(o.subject), by: o.by });
  }
  const transitions = skillTransitions(skill.key, all.activity);
  const proposed = transitions.find(t => t.to === 'proposed');
  if (proposed) steps.push({ kind: 'proposed', at: proposed.at, order: order++, title: `${skill.key} proposed`, by: proposed.by, activityId: proposed.activityId, detail: parent ? `a child of ${parent.key}` : undefined });
  const ps = proofSummary(skill.proof);
  if (ps.raw) {
    const bits: string[] = [];
    if (ps.fixed !== undefined) bits.push(`fixes ${ps.fixed} taught case${ps.fixed === 1 ? '' : 's'}${ps.broken ? `, breaks ${ps.broken}` : ', breaks none'}`);
    if (ps.newLeads.length) bits.push(`finds ${ps.newLeads.length} more past ${ps.newLeads.length === 1 ? 'week' : 'weeks'}`);
    if (ps.changed) bits.push(`changes ${ps.changed.n} of ${ps.changed.total} past decisions`);
    steps.push({ kind: 'proof', at: proposed?.at ?? skill.createdAt, order: order++, title: ps.gate ? `Replay gate: ${ps.gate}` : 'Replay proof', detail: bits.join('; '), ok: ps.gate ? ps.gate === 'pass' : undefined });
  }
  const replayAsks = all.asks.filter(a => {
    if (a.kind !== 'audit') return false;
    const e = parseObj(a.evidence);
    return e.replay === true && e.skill === skill.key;
  });
  for (const t of transitions) {
    if (t.to === 'proposed') continue;
    const title = t.to === 'canary' && t.fraction !== undefined ? `Canary on ${Math.round(t.fraction * 100)}% of cases` : t.to === 'active' ? 'Active for the whole team' : t.to === 'shadow' ? 'Shadowing live work' : t.to === 'retired' ? 'Retired' : t.to === 'rejected' ? 'Rejected' : t.to;
    const detail = t.to === 'active' && replayAsks.length ? `activation reopened ${replayAsks.length} past ${replayAsks.length === 1 ? 'week' : 'weeks'} for audit` : undefined;
    steps.push({ kind: 'status', at: t.at, order: order++, title, by: t.by, activityId: t.activityId, status: t.to, detail });
  }
  const policies = all.policies.filter(p => p.sourceSkill === skill.key && !p.constitutional);
  for (const p of policies) {
    const proposal = all.activity.find(a => a.command === 'propose_policy' && a.outcome === 'committed' && parseObj(a.params).policyId === p.policyId);
    const ratified = p.approvedBy && p.approvedAt;
    steps.push({
      kind: 'policy',
      at: ratified ? p.approvedAt : proposal?.at ?? '',
      order: order++,
      title: ratified ? `${p.policyId} ratified` : p.status === 'rejected' ? `${p.policyId} rejected` : `${p.policyId} proposed`,
      detail: p.text,
      by: ratified ? p.approvedBy : proposal?.principal,
      status: p.status,
      activityId: proposal?.id,
    });
  }
  const changed = changedCases(skill, parent, all.decisions);
  const reopened = changed.filter(c => c.decision.note.startsWith('replay:'));
  const live = changed.filter(c => !c.decision.note.startsWith('replay:'));
  for (const c of live.slice(0, 4)) {
    steps.push({ kind: 'changed', at: c.decision.at, order: order++, title: `${subjectLabel(c.decision.subject)}: ${c.now.replace(/_/g, ' ')}`, detail: `${parent?.key ?? 'the parent'} would have said ${c.was.replace(/_/g, ' ')}` });
  }
  if (live.length > 4) steps.push({ kind: 'changed', at: live[live.length - 1].decision.at, order: order++, title: `and ${live.length - 4} more`, detail: 'decisions the old version would have made differently' });
  const derivedKeys = new Set(policies.map(p => p.key));
  const inherited = hires(all.activity).filter(h => h.skills.includes(skill.key) || h.policies.some(k => derivedKeys.has(k)));
  for (const h of inherited) {
    const learned = [...(h.skills.includes(skill.key) ? [skill.key] : []), ...h.policies.filter(k => derivedKeys.has(k)).map(k => k.split('@')[0])];
    steps.push({ kind: 'inherited', at: h.activity.at, order: order++, title: `${h.seat === 'cash_app' ? 'Cash application' : h.seat.charAt(0).toUpperCase() + h.seat.slice(1).replace('_', ' ')} seat hired`, detail: `starts knowing ${learned.join(' and ')}`, by: h.activity.principal, activityId: h.activity.id });
  }
  steps.sort((a, b) => {
    const ra = a.kind === 'origin' ? 0 : 1;
    const rb = b.kind === 'origin' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (a.at && b.at && a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.order - b.order;
  });
  return { skill, parent, origins, steps, changed, live, reopened, policies, inherited, replayAsks };
}

export function subjectLabel(subject: string): string {
  const parts = subject.split(':');
  if (parts[0] === 'store' && parts.length >= 3) return `Store ${parts[1].replace(/^S0*/, '')}, week of ${day(parts[2])}`;
  if (parts[0] === 'receipt') return `Receipt ${parts.slice(1).join(':')}`;
  if (parts[0] === 'entity') return parts[2] ? `${parts[1]} on ${day(parts[2])}` : `Counterparty ${parts[1]}`;
  if (parts[0] === 'obs') return `Email #${parts[1]}`;
  if (parts[0] === 'routing') return /^\d+$/.test(parts[1] ?? '') ? `Bank-change request #${parts[1]}` : `Bank change for ${parts[1]}`;
  if (parts[0] === 'refund') return `Refund ${parts[1]}`;
  if (parts[0] === 'payment') return `Payment ${parts.slice(1).join(':')}`;
  if (parts[0] === 'bill') return `Bill ${parts.slice(2).join(':') || parts[1]} from ${parts[1]}`;
  if (parts[0] === 'finding') return `Finding #${parts[1]}`;
  return subject;
}

export function planSkills(plan: string): string[] {
  return parseArr<string>(plan).filter(p => /@\d+$/.test(p));
}

export function planPolicies(plan: string): string[] {
  return parseArr<string>(plan).filter(p => !/@\d+$/.test(p) && /^[A-Z]/.test(p));
}

// The decision row behind a seat's command. Decisions carry no activity id, so
// match on skill, seat, business date and the subject the command was about.
export function decisionFor(a: Activity, decisions: Decision[]): Decision | undefined {
  // Exact: the module names the decision behind an action in its used list.
  const ref = parseArr<string>(a.used).find(u => u.startsWith('decision:'));
  if (ref) {
    const hit = decisions.find(d => d.id.toString() === ref.slice(9));
    if (hit) return hit;
  }
  const skills = planSkills(a.plan);
  if (!skills.length) return undefined;
  const p = parseObj(a.params);
  const subjects: ((s: string) => boolean)[] = [];
  const eq = (v: string) => (s: string) => s === v;
  if (typeof p.store === 'string' && typeof p.week === 'string') subjects.push(eq(`store:${p.store}:${p.week}`));
  if (typeof p.storeCode === 'string' && typeof p.period === 'string') subjects.push(eq(`store:${p.storeCode}:${p.period}`));
  if (typeof p.receiptId === 'string') subjects.push(eq(`receipt:${p.receiptId}`));
  if (typeof p.entityCode === 'string') subjects.push(s => s.startsWith(`routing:${p.entityCode}:`));
  if (typeof p.entity === 'string') subjects.push(eq(`entity:${p.entity}:${a.at}`));
  const candidates = decisions.filter(d => skills.includes(d.skillKey.split('+')[0]) && !d.shadow && d.at === a.at && (a.principal.startsWith('seat:') ? d.seat === a.principal : true));
  const matched = subjects.length ? candidates.filter(d => subjects.some(f => f(d.subject))) : candidates;
  return matched[matched.length - 1];
}

// Every action the module recorded as caused by this decision.
export function actionsOf(d: Decision, activity: Activity[]): Activity[] {
  const tag = `decision:${d.id.toString()}`;
  return activity.filter(a => parseArr<string>(a.used).includes(tag)).sort((x, y) => (x.id < y.id ? -1 : 1));
}
