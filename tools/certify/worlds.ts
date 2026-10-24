// A concrete world for every situation on the map, as close to a real moment as possible.
// Start from a recorded ledger and payment (company B's customer 15061 on 28 Dec 2010, the
// payment that taught the team its best lesson) and look for the fewest edits that land the
// payment in the situation: a different amount, a different reference, a remittance list, an
// invoice that is already paid, a second invoice of the same amount. Every candidate is read
// by the seat's own code; a situation no edit reaches is reported, never assumed.

import { run, type Expr } from '../../module/spacetimedb/src/core/dsl';
import { findSubsets, type OpenItem } from '../../module/spacetimedb/src/core/matching';
import { readPayment, type Invoice, type Ledger, type Payment } from './seat';

export interface Edit { says: string; cost: number }
export interface World { ledger: Ledger; payment: Payment; edits: Edit[]; features: Record<string, any>; treatments: Record<string, string> }

const holds = (atom: Expr, f: Record<string, any>) =>
  run({ domain: 'allocation', rules: [{ when: atom, then: { decide: 'y' } }], otherwise: { decide: 'n' } } as any, f).outcome.decide === 'y';
export const cellKey = (vocab: Expr[], f: Record<string, any>) => vocab.map(a => (holds(a, f) ? '1' : '0')).join('');
const money = (c: number) => '£' + (c / 100).toFixed(2);

function subsets(items: Invoice[], max = 3): Invoice[][] {
  const out: Invoice[][] = [];
  const rec = (start: number, cur: Invoice[]) => {
    if (cur.length) out.push([...cur]);
    if (cur.length === max) return;
    for (let i = start; i < items.length; i++) { cur.push(items[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}

// Every world reachable by up to a few edits of the real one, cheapest first, kept one per situation.
export function realize(base: Ledger, real: Payment, vocab: Expr[]): Map<string, World> {
  const found = new Map<string, World>();
  // The set search depends only on the ledger and the amount; the rest of the reading is cheap.
  // Cheapest edits win; the winner is read again in full by the seat's code before it is kept.
  const best = new Map<string, { ledger: Ledger; payment: Payment; edits: Edit[]; cost: number }>();
  const consider = (ledger: Ledger, payment: Payment, edits: Edit[], search: { solutions: string[][]; residuals: number[] }, items: OpenItem[]) => {
    const amount = payment.amount;
    const listed = payment.remitRefs.map(id => items.find(i => i.id === id)).filter((i): i is OpenItem => !!i);
    const referenced = ledger.invoices.filter(i => payment.reference.includes(i.id));
    const named = items.filter(i => payment.reference.includes(i.id) && Math.abs(i.openCents - amount) <= 100);
    const mentioned = items.filter(i => payment.reference.includes(i.id));
    const f = {
      solution_count: Math.min(search.solutions.length, 3), exact_match: search.residuals[0] === 0, residual_cents: search.residuals[0] ?? amount,
      remittance_present: payment.remitRefs.length > 0, remittance_consistent: payment.remitRefs.length > 0 && listed.length === payment.remitRefs.length && Math.abs(listed.reduce((x, i) => x + i.openCents, 0) - amount) <= 100,
      receipt_amount: amount, reference_paid: referenced.length > 0 && referenced.every(i => i.openCents === 0), reference_matches_open: named.length === 1,
      reference_names_open: mentioned.length > 0, reference_gap_cents: mentioned.length ? mentioned.reduce((x, i) => x + i.openCents, 0) - amount : 0, open_items: items.length,
    };
    const key = cellKey(vocab, f), cost = edits.reduce((s, e) => s + e.cost, 0);
    const prev = best.get(key);
    if (!prev || prev.cost > cost) best.set(key, { ledger, payment, edits, cost });
  };
  const open = base.invoices.filter(i => i.openCents > 0);
  const named = open.find(i => real.reference.includes(i.id))!;
  // Ledger variants: as recorded, with one invoice already paid, with a second invoice of an existing amount.
  const ledgers: { ledger: Ledger; edits: Edit[] }[] = [{ ledger: base, edits: [] }];
  const paid = (l: Ledger, ids: string[]) => ({ ...l, invoices: l.invoices.map(i => (ids.includes(i.id) ? { ...i, openCents: 0 } : i)) });
  for (const inv of open.slice(0, 7)) {
    ledgers.push({ ledger: paid(base, [inv.id]), edits: [{ says: `${inv.id} is already paid`, cost: 1 }] });
    const twin: Invoice = { ...inv, id: String(Number(inv.id) + 900000).slice(-6) };
    ledgers.push({ ledger: { ...base, invoices: [...base.invoices, twin] }, edits: [{ says: `a second invoice ${twin.id} for ${money(inv.openCents)}`, cost: 2 }] });
  }
  // A thinner ledger: the small invoices that make many sets add up are already paid.
  const small = open.filter(i => i.openCents < 40000).map(i => i.id);
  const thin = paid(base, small);
  ledgers.push({ ledger: thin, edits: [{ says: `the ${small.length} invoices under £400 (${small.join(', ')}) are already paid`, cost: 2 }] });
  for (const inv of open.filter(i => i.openCents >= 40000).slice(0, 4)) {
    const twin: Invoice = { ...inv, id: String(Number(inv.id) + 900000).slice(-6) };
    ledgers.push({ ledger: { ...thin, invoices: [...thin.invoices, twin] }, edits: [{ says: `the ${small.length} invoices under £400 are already paid`, cost: 2 }, { says: `a second invoice ${twin.id} for ${money(inv.openCents)}`, cost: 2 }] });
  }
  for (const { ledger, edits: le } of ledgers) {
    const items = ledger.invoices.filter(i => i.openCents > 0);
    const sets = subsets(items, 3);
    const paidIds = ledger.invoices.filter(i => i.openCents === 0).map(i => i.id);
    // Amounts: the real one, every small set's exact total, that total less a bank charge, and one nothing explains.
    const amounts: { amount: number; edit?: Edit }[] = [{ amount: real.amount }];
    for (const s of sets) {
      const total = s.reduce((x, i) => x + i.openCents, 0), ids = s.map(i => i.id).join(' + ');
      amounts.push({ amount: total, edit: { says: `pays ${money(total)}, exactly ${ids}`, cost: 1 } });
      amounts.push({ amount: total + 1200, edit: { says: `pays ${money(total + 1200)}, ${ids} and £12 more`, cost: 1 } });
      amounts.push({ amount: Math.max(1, total - 1200), edit: { says: `pays ${money(Math.max(1, total - 1200))}, ${ids} less £12 of bank charges`, cost: 1 } });
      amounts.push({ amount: total + 50, edit: { says: `pays ${money(total + 50)}, ${ids} and 50p more`, cost: 1 } });
      amounts.push({ amount: Math.max(1, total - 50), edit: { says: `pays ${money(Math.max(1, total - 50))}, ${ids} less 50p`, cost: 1 } });
    }
    amounts.push({ amount: 13, edit: { says: 'pays £0.13, which nothing explains', cost: 1 } });
    // References: the real one, none, another open invoice, two open invoices, an invoice already paid.
    const refs: { reference: string; edit?: Edit }[] = [{ reference: real.reference }, { reference: '', edit: { says: 'gives no reference', cost: 1 } }];
    for (const inv of items.slice(0, 6)) if (inv.id !== named?.id) refs.push({ reference: inv.id, edit: { says: `names ${inv.id}`, cost: 1 } });
    if (items.length > 1) refs.push({ reference: `${items[0].id} ${items[1].id}`, edit: { says: `names ${items[0].id} and ${items[1].id}`, cost: 1 } });
    for (const id of paidIds) refs.push({ reference: id, edit: { says: `names ${id}`, cost: 0 } });
    // Remittances: none, or a list of a small set.
    const remits: { refs: string[]; edit?: Edit }[] = [{ refs: real.remitRefs }];
    for (const s of sets.slice(0, 40)) remits.push({ refs: s.map(i => i.id), edit: { says: `sends a remittance listing ${s.map(i => i.id).join(', ')}`, cost: 1 } });
    const openItems: OpenItem[] = items.map(i => ({ id: i.id, kind: i.kind as any, openCents: i.openCents, dueDate: i.dueDate }));
    const baseCost = le.reduce((s, e) => s + e.cost, 0);
    for (const a of amounts) {
      const aCost = baseCost + (a.edit?.cost ?? 0);
      if (aCost > 6) continue;
      const search = findSubsets(a.amount, openItems, 2_500);
      for (const r of refs) for (const m of remits) {
        const edits = [...le, ...[a.edit, r.edit, m.edit].filter((e): e is Edit => !!e)];
        if (aCost + (r.edit?.cost ?? 0) + (m.edit?.cost ?? 0) > 6) continue;
        consider(ledger, { amount: a.amount, reference: r.reference, remitRefs: m.refs }, edits, search, openItems);
      }
    }
  }
  for (const [key, b] of best) {
    const r = readPayment(b.ledger, b.payment);
    if (cellKey(vocab, r.features) !== key) throw new Error(`the fast reading disagrees with the seat's for situation ${key}`);
    found.set(key, { ledger: b.ledger, payment: b.payment, edits: b.edits, features: r.features, treatments: r.treatments });
  }
  return found;
}
