// Canonical JSON and SHA-256 for the activity hash chain.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

export function chainHash(prevHash: string, record: unknown): string {
  return sha256Hex(prevHash + '|' + canonical(record));
}
