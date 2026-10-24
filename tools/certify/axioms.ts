// What every real feature map satisfies, read off the code that computes it. Without these
// the solver would invent situations no ledger can produce (an exact match that leaves money
// over, a reference that names an open invoice and an already-paid one at once). Each axiom
// is checked against every recorded decision before it is used.

import type { Encoder } from './encode';

export interface Axiom { id: string; says: string; f: (enc: Encoder) => any; holds: (x: Record<string, any>) => boolean }

// seats.ts processReceipt and matching.ts findSubsets, for a company whose tolerance is `tol` cents.
export function allocationAxioms(Z3: any, tol: number): Axiom[] {
  const v = (enc: Encoder, n: string) => enc.vars[n].t;
  return [
    { id: 'A1', says: 'at most three sets are counted', f: e => Z3.And(v(e, 'solution_count').ge(0), v(e, 'solution_count').le(3)), holds: x => x.solution_count >= 0 && x.solution_count <= 3 },
    { id: 'A2', says: 'money arrives in positive amounts', f: e => v(e, 'receipt_amount').ge(1), holds: x => x.receipt_amount >= 1 },
    { id: 'A3', says: 'a payer has zero or more open invoices', f: e => v(e, 'open_items').ge(0), holds: x => x.open_items >= 0 },
    { id: 'A4', says: 'an exact match is a set that leaves nothing over', f: e => v(e, 'exact_match').eq(Z3.And(v(e, 'solution_count').ge(1), v(e, 'residual_cents').eq(0))), holds: x => x.exact_match === (x.solution_count >= 1 && x.residual_cents === 0) },
    { id: 'A5', says: 'with no set, all of the payment is left over', f: e => Z3.Implies(v(e, 'solution_count').eq(0), v(e, 'residual_cents').eq(v(e, 'receipt_amount'))), holds: x => x.solution_count !== 0 || x.residual_cents === x.receipt_amount },
    { id: 'A6', says: 'a near set leaves something, at most the tolerance', f: e => Z3.Implies(Z3.And(v(e, 'solution_count').ge(1), Z3.Not(v(e, 'exact_match'))), Z3.And(v(e, 'residual_cents').ge(1), v(e, 'residual_cents').le(tol))), holds: x => !(x.solution_count >= 1 && !x.exact_match) || (x.residual_cents >= 1 && x.residual_cents <= tol) },
    { id: 'A7', says: 'a set needs an open invoice', f: e => Z3.Implies(v(e, 'solution_count').ge(1), v(e, 'open_items').ge(1)), holds: x => x.solution_count < 1 || x.open_items >= 1 },
    { id: 'A8', says: 'naming an open invoice needs one', f: e => Z3.Implies(v(e, 'reference_names_open'), v(e, 'open_items').ge(1)), holds: x => !x.reference_names_open || x.open_items >= 1 },
    { id: 'A9', says: 'a reference that matches an open invoice names one', f: e => Z3.Implies(v(e, 'reference_matches_open'), v(e, 'reference_names_open')), holds: x => !x.reference_matches_open || x.reference_names_open },
    { id: 'A10', says: 'a reference whose invoices are all paid names none that is open', f: e => Z3.Implies(v(e, 'reference_paid'), Z3.Not(v(e, 'reference_names_open'))), holds: x => !x.reference_paid || !x.reference_names_open },
    { id: 'A11', says: 'the gap is zero unless the reference names an open invoice', f: e => Z3.Implies(Z3.Not(v(e, 'reference_names_open')), v(e, 'reference_gap_cents').eq(0)), holds: x => x.reference_names_open || x.reference_gap_cents === 0 },
    { id: 'A12', says: 'named invoices have something open, so the gap is more than minus the payment', f: e => Z3.Implies(v(e, 'reference_names_open'), v(e, 'reference_gap_cents').gt(v(e, 'receipt_amount').neg())), holds: x => !x.reference_names_open || x.reference_gap_cents > -x.receipt_amount },
    { id: 'A13', says: 'an agreeing remittance is a remittance', f: e => Z3.Implies(v(e, 'remittance_consistent'), v(e, 'remittance_present')), holds: x => !x.remittance_consistent || x.remittance_present },
    { id: 'A14', says: 'what is left over is part of the payment', f: e => Z3.And(v(e, 'residual_cents').ge(0), v(e, 'residual_cents').le(v(e, 'receipt_amount'))), holds: x => x.residual_cents >= 0 && x.residual_cents <= x.receipt_amount },
  ];
}
