// Exact binomial bounds. Pure, so the evolution tools, the report and the
// benchmark harness use the same arithmetic as the kernel.

function binomTail(errors: number, n: number, p: number): number {
  let s = 0;
  let term = Math.pow(1 - p, n);
  for (let k = 0; k <= errors; k++) {
    s += term;
    term *= ((n - k) / (k + 1)) * (p / (1 - p));
  }
  return s;
}

// One-sided exact (Clopper-Pearson) 95% bounds on an error rate.
export function upper95(errors: number, n: number): number {
  if (n === 0) return 1;
  let lo = errors / n;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (binomTail(errors, n, mid) > 0.05) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function lower95(errors: number, n: number): number {
  if (errors === 0) return 0;
  // P(X >= errors | p) = 0.05
  let lo = 0;
  let hi = errors / n;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (1 - binomTail(errors - 1, n, mid) < 0.05) lo = mid;
    else hi = mid;
  }
  return lo;
}
