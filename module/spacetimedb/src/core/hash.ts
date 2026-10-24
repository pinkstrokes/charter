// Canonical JSON and SHA-256 for the activity hash chain.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// Same value semantics as JSON.stringify (undefined object fields are dropped,
// undefined array items become null), so any JSON parser can rebuild the input.
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(v => canonical(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function chainHash(prevHash: string, record: unknown): string {
  return sha256Hex(prevHash + '|' + canonical(record));
}
