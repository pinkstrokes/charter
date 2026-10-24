// Receipt-to-invoice matching. Exact subset search with a uniqueness check: a
// solver that returns one of several equally valid subsets looks confident and
// is wrong half the time, so we count solutions and let the allocation skill
// decide what to do when the answer is not unique.

import type { InvoiceKind } from './contracts';

export interface OpenItem {
  id: string;
  kind: InvoiceKind;
  openCents: number;
  dueDate: string; // YYYY-MM-DD
}

export interface Allocation {
  id: string;
  cents: number;
}

export interface SubsetSearch {
  solutions: string[][]; // up to maxSolutions subsets, best (smallest residual) first
  residuals: number[]; // amount - sum(subset) for each solution
  searched: number; // items considered (oldest first)
}

const MAX_ITEMS = 24;

function subsetSums(items: OpenItem[]): { sum: number; mask: number }[] {
  const out: { sum: number; mask: number }[] = [];
  const n = items.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    let s = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s += items[i].openCents;
    out.push({ sum: s, mask });
  }
  return out;
}

// Subsets whose total is within [amount - tolerance, amount]: a payer may send
// slightly less than the invoices (bank fees) but never a subset larger than the
// money received.
export function findSubsets(amount: number, items: OpenItem[], toleranceCents: number, maxSolutions = 3): SubsetSearch {
  const pool = [...items].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id)).slice(0, MAX_ITEMS);
  const half = Math.floor(pool.length / 2);
  const left = pool.slice(0, half);
  const right = pool.slice(half);
  const leftSums = subsetSums(left);
  const rightSums = subsetSums(right).sort((a, b) => a.sum - b.sum);
  const found: { ids: string[]; residual: number }[] = [];
  for (const l of leftSums) {
    const lo = amount - toleranceCents - l.sum;
    const hi = amount - l.sum;
    if (hi < 0) continue;
    // binary search first right sum >= lo
    let a = 0;
    let b = rightSums.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (rightSums[m].sum < lo) a = m + 1;
      else b = m;
    }
    for (let k = a; k < rightSums.length && rightSums[k].sum <= hi; k++) {
      const total = l.sum + rightSums[k].sum;
      if (total === 0) continue;
      const ids: string[] = [];
      left.forEach((it, i) => l.mask & (1 << i) && ids.push(it.id));
      right.forEach((it, i) => rightSums[k].mask & (1 << i) && ids.push(it.id));
      found.push({ ids, residual: amount - total });
      if (found.length > 50) break;
    }
    if (found.length > 50) break;
  }
  found.sort((x, y) => x.residual - y.residual || x.ids.length - y.ids.length);
  const top = found.slice(0, maxSolutions);
  return { solutions: top.map(f => f.ids), residuals: top.map(f => f.residual), searched: pool.length };
}

// Contractual waterfall: apply to kinds in the contract's order, oldest first,
// the last item partially. Used when no subset explains the amount.
export function applyByTerms(amount: number, items: OpenItem[], order: InvoiceKind[]): { allocations: Allocation[]; residualCents: number } {
  const rank = (k: InvoiceKind) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  const sorted = [...items].sort((a, b) => rank(a.kind) - rank(b.kind) || a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  let left = amount;
  const allocations: Allocation[] = [];
  for (const it of sorted) {
    if (left <= 0) break;
    const take = Math.min(left, it.openCents);
    if (take > 0) {
      allocations.push({ id: it.id, cents: take });
      left -= take;
    }
  }
  return { allocations, residualCents: left };
}

export function allocationsForSubset(ids: string[], items: OpenItem[]): Allocation[] {
  const byId = new Map(items.map(i => [i.id, i]));
  return ids.map(id => ({ id, cents: byId.get(id)!.openCents }));
}
