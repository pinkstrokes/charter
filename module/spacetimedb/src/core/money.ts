// Integer money helpers. Amounts are minor units; never floats in the ledger.

export function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer number of cents, got ${value}`);
}

// Basis-point share with banker's rounding so repeated splits do not drift.
export function bpOf(amount: number, bp: number): number {
  assertCents(amount, 'amount');
  const exact = (amount * bp) / 10_000;
  const floor = Math.floor(exact);
  const diff = exact - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function fmt(amount: number, currency = 'USD'): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const symbol = currency === 'GBP' ? '£' : '$';
  return `${sign}${symbol}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

// Day arithmetic on ISO dates (YYYY-MM-DD) without a clock dependency.
export function dayIndex(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function isoFromDayIndex(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return isoFromDayIndex(dayIndex(iso) + days);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return dayIndex(toIso) - dayIndex(fromIso);
}
