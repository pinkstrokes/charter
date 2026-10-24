// Autonomy is earned per rule. Any decision can be checked later: a spot check,
// a person's answer, a field audit, a correction, an internal-audit finding.
// The inspection rate follows switching rules from acceptance sampling: a new
// rule starts on probation, a proven one gets reduced inspection, a recent error
// tightens it, and a rule we are 95% sure is worse than the tolerable error rate
// is suspended, so its cases go to a person until a new version replaces it.
import { ESCALATING, sameTreatment } from './core/dsl';
import { labelBreach } from './core/labels';
import { lower95, upper95 } from './core/stats';

export { lower95, upper95 };
import { appendActivity, simDate, type Tx } from './kernel';

export const TOLERABLE: Record<string, number> = { underreport: 0.05, pre_chase: 0.1, allocation: 0.02, routing_change: 0.02, bill_match: 0.02 };
export const SAMPLE_RATE: Record<string, number> = { probation: 0.25, normal: 0.1, reduced: 0.03, tightened: 0.4, suspended: 0 };

// Stronger evidence overrides weaker evidence about the same decision.
const STRENGTH: Record<string, number> = { answer: 1, spot_check: 2, correction: 2, field_audit: 3, internal_audit: 3 };

type StatRow = NonNullable<ReturnType<Tx['db']['ruleStat']['key']['find']>>;

export function statFor(tx: Tx, domain: string, skillKey: string, ruleIndex: number): StatRow {
  const key = `${skillKey}#${ruleIndex}`;
  const row = tx.db.ruleStat.key.find(key);
  if (row) return row;
  return tx.db.ruleStat.insert({ key, domain, skillKey, ruleIndex, decisions: 0, checked: 0, errors: 0, alarmsChecked: 0, falseAlarms: 0, recent: '[]', state: 'probation', sampleRate: SAMPLE_RATE.probation, updatedAt: simDate(tx) });
}

export function nextState(s: { domain: string; checked: number; errors: number; recent: string; state: string }): string {
  const recent = JSON.parse(s.recent) as number[];
  const tolerable = TOLERABLE[s.domain] ?? 0.05;
  if (s.checked >= 5 && lower95(s.errors, s.checked) > tolerable) return 'suspended';
  if (recent.slice(-5).includes(1)) return 'tightened';
  // Tightened inspection ends after ten correct checks in a row.
  let clean = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i] === 0; i--) clean++;
  if (s.state === 'tightened' && clean < 10) return 'tightened';
  if (s.checked < 20) return 'probation';
  if (s.checked >= 40 && upper95(s.errors, s.checked) <= tolerable) return 'reduced';
  return 'normal';
}

// Record that a person or an audit established the right outcome for a past decision.
// Returns why a check was not counted, when the verdict itself breaks the agreement.
export function recordCheck(tx: Tx, domain: string, subject: string, correct: string, source: keyof typeof STRENGTH, by: string): string | null {
  let d: NonNullable<ReturnType<Tx['db']['decision']['id']['find']>> | null = null;
  for (const x of tx.db.decision.subject.filter(subject)) if (x.domain === domain && !x.shadow && (!d || x.id > d.id)) d = x;
  if (!d) return null;
  const breach = labelBreach(domain, JSON.parse(d.features), correct);
  if (breach) {
    appendActivity(tx, { principal: 'kernel', role: 'system', kind: 'reliability', command: 'verdict_declined', params: { decision: Number(d.id), subject, decided: d.outcome, verdict: correct, by, source }, used: [`decision:${d.id}`], outcome: 'kept', reasons: [breach] });
    return breach;
  }
  const wrong = sameTreatment(domain, d.outcome, correct) ? 0 : 1;
  const stat = statFor(tx, domain, d.skillKey, d.ruleIndex);
  if ((ESCALATING[domain as keyof typeof ESCALATING] ?? []).includes(d.outcome)) {
    // An escalation is never a risk; when a person finds it unnecessary it is a false alarm.
    if (d.label) return null;
    tx.db.decision.id.update({ ...d, label: correct, labelSource: `${source}:${by}` });
    tx.db.ruleStat.key.update({ ...stat, alarmsChecked: stat.alarmsChecked + 1, falseAlarms: stat.falseAlarms + wrong, updatedAt: simDate(tx) });
    return null;
  }
  let { checked, errors } = stat;
  const recent = JSON.parse(stat.recent) as number[];
  if (d.label) {
    const prev = d.labelSource.split(':')[0];
    if ((STRENGTH[source] ?? 0) <= (STRENGTH[prev] ?? 0)) return null;
    // A stronger check of an already-checked decision replaces the earlier verdict.
    const was = sameTreatment(domain, d.outcome, d.label) ? 0 : 1;
    errors += wrong - was;
    if (wrong !== was) recent.push(wrong);
  } else {
    checked += 1;
    errors += wrong;
    recent.push(wrong);
  }
  tx.db.decision.id.update({ ...d, label: correct, labelSource: `${source}:${by}` });
  const next = { ...stat, checked, errors, recent: JSON.stringify(recent.slice(-20)) };
  const state = nextState(next);
  tx.db.ruleStat.key.update({ ...next, state, sampleRate: SAMPLE_RATE[state], updatedAt: simDate(tx) });
  if (state !== stat.state) {
    appendActivity(tx, {
      principal: 'kernel',
      role: 'system',
      kind: 'reliability',
      command: 'inspection_level',
      params: { rule: stat.key, from: stat.state, to: state, checked, errors, upper95: Number(upper95(errors, checked).toFixed(4)), lower95: Number(lower95(errors, checked).toFixed(4)), tolerable: TOLERABLE[domain] ?? 0.05 },
      used: [`decision:${d.id}`],
      outcome: state,
    });
  }
  return null;
}
