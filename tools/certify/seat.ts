// What the cash seat sees in a payment and what each outcome would do with it, as a pure
// function of a ledger. The lines follow seats.ts processReceipt and use matching.ts itself,
// so a world built here is read the way the seat would read it.

import { applyByTerms, allocationsForSubset, findSubsets, type OpenItem } from '../../module/spacetimedb/src/core/matching';

export interface Invoice { id: string; kind: string; amountCents: number; openCents: number; dueDate: string }
export interface Payment { amount: number; reference: string; remitRefs: string[] }
export interface Ledger { payer: string; asOf: string; invoices: Invoice[]; order: string[] }

export const OUTCOMES = ['apply_unique', 'apply_to_reference', 'apply_by_terms', 'leave_unapplied_ask'] as const;

export function readPayment(l: Ledger, p: Payment) {
  const amount = p.amount;
  const items: OpenItem[] = l.invoices.filter(i => i.openCents > 0).map(i => ({ id: i.id, kind: i.kind as any, openCents: i.openCents, dueDate: i.dueDate }));
  const search = findSubsets(amount, items, 2_500);
  const listed = p.remitRefs.map(id => items.find(i => i.id === id)).filter((i): i is OpenItem => !!i);
  const remitConsistent = p.remitRefs.length > 0 && listed.length === p.remitRefs.length && Math.abs(listed.reduce((s, i) => s + i.openCents, 0) - amount) <= 100;
  const referenced = l.invoices.filter(i => p.reference.includes(i.id));
  const named = items.filter(i => p.reference.includes(i.id) && Math.abs(i.openCents - amount) <= 100);
  const mentioned = items.filter(i => p.reference.includes(i.id));
  const features = {
    solution_count: Math.min(search.solutions.length, 3),
    exact_match: search.residuals[0] === 0,
    residual_cents: search.residuals[0] ?? amount,
    remittance_present: p.remitRefs.length > 0,
    remittance_consistent: remitConsistent,
    receipt_amount: amount,
    reference_paid: referenced.length > 0 && referenced.every(i => i.openCents === 0),
    reference_matches_open: named.length === 1,
    reference_names_open: mentioned.length > 0,
    reference_gap_cents: mentioned.length ? mentioned.reduce((s, i) => s + i.openCents, 0) - amount : 0,
    open_items: items.length,
  };
  const plan = (o: string): { id: string; cents: number }[] => {
    if (o === 'apply_unique' && (remitConsistent || named.length === 1 || search.solutions.length >= 1))
      return allocationsForSubset(remitConsistent ? p.remitRefs : named.length === 1 ? [named[0].id] : search.solutions[0], items);
    if (o === 'apply_to_reference' && mentioned.length) return applyByTerms(amount, mentioned, l.order as any).allocations;
    if (o === 'apply_by_terms') return applyByTerms(amount, items, l.order as any).allocations;
    return [];
  };
  const plans = Object.fromEntries(OUTCOMES.map(o => [o, plan(o)]));
  const landing = (a: { id: string }[]) => (a.length ? [...new Set(a.map(x => x.id))].sort().join(' + ') : 'ask');
  return { features, plans, treatments: Object.fromEntries(OUTCOMES.map(o => [o, landing(plans[o])])) as Record<string, string> };
}
