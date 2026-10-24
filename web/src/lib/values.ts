// Rendering arbitrary JSON values from params, evidence and proofs.
import { day, money } from './format';

const MONEY_KEYS = /(^|_)(amount|cents|open|overpaid|requested|benefit|cost|owed)($|_)|Cents$|^amount|^cents$/i;

export function valueText(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number' && Number.isInteger(v) && MONEY_KEYS.test(key) && !/count|days|^n$/i.test(key)) return money(v);
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : String(Math.round(v * 1000) / 1000);
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? day(v, true) : v;
  if (Array.isArray(v) && v.every(x => typeof x !== 'object' || x === null)) return v.length ? v.join(', ') : '—';
  return JSON.stringify(v);
}

export function labelOf(k: string): string {
  return k
    .replace(/Cents$/, '')
    .replace(/_cents$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

