// How the team's knowledge changes. The evolver may only propose; a person moves
// a skill through shadow -> canary -> active and ratifies policies. A promoted
// policy may only add restrictions; the constitution can never be retired.
import { run, validate, type FeatureMap, type SkillProgram } from './core/dsl';
import { CONSTITUTION, isTightening, ROLE_MATRIX, type PolicyTemplate, type Principal } from './core/policy';
import { SEED_SKILLS } from './core/seed_skills';
import { appendActivity, exec, Rejection, simDate, type ExecResult, type Tx } from './kernel';
import { openAsk } from './seats';

export const SKILL_STATUSES = ['proposed', 'shadow', 'canary', 'active', 'retired', 'rejected'] as const;

export function seedGovernance(tx: Tx): void {
  const today = simDate(tx);
  for (const rule of [...CONSTITUTION, ...ROLE_MATRIX]) {
    tx.db.policy.insert({
      key: `${rule.id}@${rule.version}`,
      policyId: rule.id,
      version: rule.version,
      template: JSON.stringify(rule.tpl),
      text: rule.text,
      status: 'active',
      constitutional: rule.constitutional,
      sourceSkill: '',
      approvedBy: 'founding charter',
      approvedAt: today,
      proof: '',
    });
  }
  for (const [domain, program] of Object.entries(SEED_SKILLS)) {
    tx.db.skill.insert({ key: `${domain}@1`, domain, version: 1, status: 'active', program: JSON.stringify(program), scope: '{}', parent: '', provenance: 'hand-written starting point', proof: '', record: '{}', createdAt: today });
  }
  appendActivity(tx, { principal: 'founders', role: 'admin', kind: 'policy', command: 'charter_founded', params: { constitution: CONSTITUTION.map(r => r.id), roles: ROLE_MATRIX.map(r => r.id), skills: Object.keys(SEED_SKILLS) }, outcome: 'committed' });
}

export function proposeSkill(tx: Tx, who: Principal, domain: string, program: SkillProgram, parent: string, provenance: string, proof: string): ExecResult {
  const versions = [...tx.db.skill.domain.filter(domain)].map(s => s.version);
  const version = (versions.length ? Math.max(...versions) : 0) + 1;
  const key = `${domain}@${version}`;
  return exec(tx, { principal: who, action: 'propose_skill', params: { key, parent, provenance }, used: parent ? [`skill:${parent}`] : [] }, () => {
    if (program.domain !== domain) throw new Rejection(`program is for ${program.domain}, not ${domain}`);
    const problems = validate(program);
    if (problems.length) throw new Rejection(`invalid skill: ${problems.join('; ')}`);
    tx.db.skill.insert({ key, domain, version, status: 'proposed', program: JSON.stringify(program), scope: '{}', parent, provenance, proof, record: '{}', createdAt: simDate(tx) });
    return `proposed ${key}`;
  });
}

export function setSkillStatus(tx: Tx, who: Principal, key: string, status: string, fraction: number): ExecResult {
  const s = tx.db.skill.key.find(key);
  if (!s) throw new Rejection(`no skill ${key}`);
  if (!(SKILL_STATUSES as readonly string[]).includes(status)) throw new Rejection(`unknown status ${status}`);
  return exec(tx, { principal: who, action: 'activate_skill', params: { key, from: s.status, to: status, fraction }, used: [`skill:${key}`] }, () => {
    if (status === 'active' || status === 'canary') {
      // One version per role: activating retires the old active (or replaces the old canary).
      for (const other of [...tx.db.skill.domain.filter(s.domain)]) {
        if (other.key === key) continue;
        if (status === 'active' && (other.status === 'active' || other.status === 'canary')) tx.db.skill.key.update({ ...other, status: other.status === 'active' ? 'retired' : 'shadow' });
        if (status === 'canary' && other.status === 'canary') tx.db.skill.key.update({ ...other, status: 'shadow' });
      }
    }
    tx.db.skill.key.update({ ...s, status, scope: status === 'canary' ? JSON.stringify({ fraction }) : s.scope });
    const reopened = status === 'active' ? replayHistory(tx, key, JSON.parse(s.program) as SkillProgram) : 0;
    return `${key}: ${s.status} -> ${status}${reopened ? `; replay over past weeks opened ${reopened} audit questions` : ''}`;
  });
}

// When a new version goes live, it re-reads every past report it would have
// judged differently. Weeks it now flags become audit questions for a person.
function replayHistory(tx: Tx, key: string, program: SkillProgram): number {
  if (program.domain !== 'underreport') return 0;
  const latest = new Map<string, { features: string; outcome: string; seat: string }>();
  for (const d of [...tx.db.decision.domain.filter('underreport')].sort((a, b) => (a.id < b.id ? -1 : 1))) if (!d.shadow) latest.set(d.subject, { features: d.features, outcome: d.outcome, seat: d.seat });
  const audited = new Set<string>();
  for (const f of tx.db.fact.iter()) if (f.attr === 'audit') {
    const v = JSON.parse(f.value) as { store: string; week: string };
    audited.add(`store:${v.store}:${v.week}`);
  }
  let opened = 0;
  for (const [subject, d] of latest) {
    if (d.outcome !== 'accept' || audited.has(subject)) continue;
    const features = JSON.parse(d.features) as FeatureMap;
    const r = run(program, features);
    if (r.outcome.decide === 'accept') continue;
    const [, store, week] = subject.split(':');
    const name = tx.db.store.code.find(store)?.name ?? store;
    tx.db.decision.insert({ id: 0n, at: simDate(tx), seat: d.seat, domain: 'underreport', subject, features: d.features, skillKey: key, outcome: r.outcome.decide, ruleIndex: r.trace.ruleIndex, note: `replay: ${r.outcome.note ?? ''}`, shadow: false });
    openAsk(tx, {
      kind: 'audit',
      subject,
      toRole: 'consultant',
      question: `The team's new skill ${key} re-read past reports and flags ${name}, week of ${week}: ${r.outcome.note || 'the sources disagree'}. Request a sales audit?`,
      options: ['request audit', 'explained — accept report'],
      evidence: { features, skill: key, replay: true },
      confidence: 0.5,
    });
    opened++;
  }
  return opened;
}

export function proposePolicy(tx: Tx, who: Principal, tpl: PolicyTemplate, text: string, sourceSkill: string, proof: string): ExecResult {
  const promoted = [...tx.db.policy.iter()].filter(p => p.policyId.startsWith('P-')).map(p => Number(p.policyId.slice(2)));
  const policyId = `P-${(promoted.length ? Math.max(...promoted) : 0) + 1}`;
  return exec(tx, { principal: who, action: 'propose_policy', params: { policyId, tpl, text, sourceSkill }, used: sourceSkill ? [`skill:${sourceSkill}`] : [] }, () => {
    if (!isTightening(tpl)) throw new Rejection('a promoted policy may only restrict, never grant');
    tx.db.policy.insert({ key: `${policyId}@1`, policyId, version: 1, template: JSON.stringify(tpl), text, status: 'proposed', constitutional: false, sourceSkill, approvedBy: '', approvedAt: '', proof });
    return `proposed ${policyId}: ${text}`;
  });
}

export function decidePolicy(tx: Tx, who: Principal, key: string, approve: boolean): ExecResult {
  const p = tx.db.policy.key.find(key);
  if (!p) throw new Rejection(`no policy ${key}`);
  return exec(tx, { principal: who, action: 'activate_policy', params: { key, approve, from: p.status }, used: [`policy:${key}`] }, () => {
    if (p.constitutional) throw new Rejection('the constitution cannot be changed');
    const status = approve ? 'active' : p.status === 'active' ? 'retired' : 'rejected';
    tx.db.policy.key.update({ ...p, status, approvedBy: approve ? who.id : p.approvedBy, approvedAt: approve ? simDate(tx) : p.approvedAt });
    return `${key}: ${p.status} -> ${status}`;
  });
}
