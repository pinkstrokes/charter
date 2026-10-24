// The third line of defence. The internal auditor can read everything and do one
// thing: report. Material findings go to the controller; a finding that shows a
// decision was wrong also counts against the rule that made it.
import type { Principal } from './core/policy';
import { exec, Rejection, simDate, type ExecResult, type Tx } from './kernel';
import { recordCheck } from './reliability';
import { openAsk } from './seats';

export interface FindingInput {
  period: string;
  test: string;
  subject: string;
  severity: string;
  detail: string;
  evidence: string; // JSON; may carry {label: {domain, subject, correct}}
}

export function fileFinding(tx: Tx, who: Principal, f: FindingInput): ExecResult {
  if (!['info', 'minor', 'major', 'critical'].includes(f.severity)) throw new Rejection(`unknown severity ${f.severity}`);
  return exec(tx, { principal: who, action: 'file_finding', params: { test: f.test, subject: f.subject, severity: f.severity }, used: [f.subject] }, () => {
    const row = tx.db.finding.insert({ id: 0n, at: simDate(tx), period: f.period, test: f.test, subject: f.subject, severity: f.severity, detail: f.detail, evidence: f.evidence, status: 'open', resolution: '', resolvedBy: '' });
    const ev = JSON.parse(f.evidence || '{}') as { label?: { domain: string; subject: string; correct: string } };
    if (ev.label) recordCheck(tx, ev.label.domain, ev.label.subject, ev.label.correct, 'internal_audit', who.id);
    if (f.severity === 'major' || f.severity === 'critical') {
      openAsk(tx, { kind: 'finding', subject: `finding:${row.id}`, toRole: 'controller', question: `Internal audit (${f.test}): ${f.detail}`, options: ['acknowledge', 'disagree'], evidence: JSON.parse(f.evidence || '{}'), confidence: 0.8 });
    }
    return `${f.severity} finding on ${f.subject}: ${f.test}`;
  });
}

export interface OpinionInput {
  period: string;
  opinion: string;
  projectedMisstatementCents: number;
  upperLimitCents: number;
  tolerableCents: number;
  sampleSize: number;
  report: string;
}

export function recordOpinion(tx: Tx, who: Principal, o: OpinionInput): ExecResult {
  if (!['clean', 'qualified', 'adverse'].includes(o.opinion)) throw new Rejection(`unknown opinion ${o.opinion}`);
  return exec(tx, { principal: who, action: 'file_finding', params: { opinion: o.opinion, period: o.period, upperLimitCents: o.upperLimitCents, tolerableCents: o.tolerableCents }, used: [`period:${o.period}`] }, () => {
    const row = { period: o.period, at: simDate(tx), opinion: o.opinion, projectedMisstatementCents: BigInt(o.projectedMisstatementCents), upperLimitCents: BigInt(o.upperLimitCents), tolerableCents: BigInt(o.tolerableCents), sampleSize: o.sampleSize, report: o.report };
    if (tx.db.auditOpinion.period.find(o.period)) tx.db.auditOpinion.period.update(row);
    else tx.db.auditOpinion.insert(row);
    return `internal audit opinion on ${o.period}: ${o.opinion}`;
  });
}
