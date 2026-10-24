// How people's answers become labels. Pure, so the evolution tools use the
// same reading of an answer as the kernel does.

// What a person's choice on a cash-application question says the seat should have done.
export function allocationLabel(evidence: { features?: Record<string, unknown>; referenced?: string; remittance?: string[] }, answer: string): string {
  const f = evidence.features ?? {};
  if (answer === 'apply oldest first') return 'apply_by_terms';
  if (f.remittance_consistent === true && (evidence.remittance ?? []).slice().sort().join(' + ') === answer.split(' + ').sort().join(' + ')) return 'apply_unique';
  if (evidence.referenced && answer === evidence.referenced) return f.reference_matches_open === true ? 'apply_unique' : 'apply_to_reference';
  return 'leave_unapplied_ask';
}

// An outcome nobody may choose, a seat or a person: it would break the agreement
// with the counterparty. A label that says otherwise is a mistake to push back
// on, not a lesson, and a seat that declined it was right.
export function labelBreach(domain: string, features: Record<string, unknown>, outcome: string): string | null {
  if (domain === 'pre_chase' && outcome === 'chase' && Number(features.days_past_due) <= Number(features.grace_days))
    return `a notice on day ${features.days_past_due} past due breaks the ${features.grace_days}-day grace period in the agreement`;
  return null;
}
