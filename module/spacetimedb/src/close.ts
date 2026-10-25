// Closing the books for a month. Only a person can do it, only after the month
// has ended, the earlier months are closed and the internal auditor has
// reported. A closed month is never rewritten: what is learned about it later is
// booked in the open month and disclosed as a prior-period item.
import { canonical, sha256Hex } from './core/hash';
import type { Principal } from './core/policy';
import { byId, checkInvariants, exec, Rejection, simDate, type ExecResult, type Tx } from './kernel';

function monthOf(dateOrPeriod: string): string {
  return dateOrPeriod.slice(0, 7);
}

export function closePeriod(tx: Tx, who: Principal, period: string): ExecResult {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Rejection(`period must look like 2026-03, not ${period}`);
  const today = simDate(tx);
  return exec(tx, { principal: who, action: 'close_period', params: { period }, used: [`period:${period}`] }, activityId => {
    if (monthOf(today) <= period) throw new Rejection(`${period} has not ended yet (business date ${today})`);
    if (tx.db.periodClose.period.find(period)) throw new Rejection(`${period} is already closed`);
    const journal = [...tx.db.journal.iter()];
    const earlier = [...new Set(journal.map(j => j.period))].filter(p => p < period).sort();
    const open = earlier.filter(p => !tx.db.periodClose.period.find(p));
    if (open.length) throw new Rejection(`close ${open.join(', ')} first`);
    const opinion = tx.db.auditOpinion.period.find(period);
    if (!opinion) throw new Rejection(`the internal auditor has not reported on ${period}`);
    const broken = checkInvariants(tx);
    if (broken.length) throw new Rejection(`books do not tie: ${broken.join('; ')}`);

    // Balances as of the end of the period, from the journal itself.
    const balances: Record<string, { debit: number; credit: number }> = {};
    for (const j of journal) {
      if (j.period > period) continue;
      const b = (balances[j.account] ??= { debit: 0, credit: 0 });
      b.debit += Number(j.debitCents);
      b.credit += Number(j.creditCents);
    }
    // Recognised this month but belonging to an earlier, closed month.
    const priorPeriodItems = [...tx.db.invoice.iter()]
      .filter(i => monthOf(i.issuedAt) === period && i.period && monthOf(i.period) < period && (i.kind === 'audit' || i.kind === 'royalty'))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(i => ({ invoice: i.id, kind: i.kind, amountCents: Number(i.amountCents), relatesTo: i.period, source: i.source }));
    const head = tx.db.chainHead.id.find(0)!;
    const certificate = {
      period,
      closedAt: today,
      closedBy: who.id,
      trialBalance: Object.entries(balances).sort().map(([account, b]) => ({ account, debitCents: b.debit, creditCents: b.credit })),
      invariantsHold: true,
      auditorOpinion: { opinion: opinion.opinion, projectedMisstatementCents: Number(opinion.projectedMisstatementCents), upperLimitCents: Number(opinion.upperLimitCents), tolerableCents: Number(opinion.tolerableCents), sampleSize: opinion.sampleSize },
      openFindings: [...tx.db.finding.iter()].filter(f => f.status === 'open' && f.period <= period).sort(byId).map(f => ({ id: Number(f.id), severity: f.severity, test: f.test })),
      openQuestionsCarried: [...tx.db.ask.status.filter('open')].length,
      priorPeriodItems,
      activeSkills: [...tx.db.skill.iter()].filter(s => s.status === 'active').map(s => s.key).sort(),
      activePolicies: [...tx.db.policy.iter()].filter(p => p.status === 'active').map(p => p.key).sort(),
      // What those rules said, not only their names: the rules in force are part of what is certified.
      rulesHash: sha256Hex(canonical([...tx.db.policy.iter()].filter(p => p.status === 'active').sort((a, b) => (a.key < b.key ? -1 : 1)).map(p => ({ key: p.key, template: p.template, text: p.text })))),
      chain: { lastActivityId: Number(head.lastActivityId), head: head.hash },
    };
    const text = canonical(certificate);
    const hash = sha256Hex(text);
    tx.db.periodClose.insert({ period, closedAt: today, closedBy: who.id, certificate: text, certificateHash: hash, activityId });
    return `${period} closed; certificate ${hash.slice(0, 16)}… (${priorPeriodItems.length} prior-period items disclosed)`;
  });
}
