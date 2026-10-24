// Re-verify the activity hash chain in the browser with the kernel's own
// function (module core/hash.ts):
//   hash = chainHash(prevHash, {at, principal, role, kind, command, params,
//                               used, plan, outcome, reasons, claims, context})
// where the JSON columns are the stored canonical text parsed back. The first
// row points at 'genesis'; each row must point at the hash of the row before it.
import { chainHash } from '@module/core/hash';
import type { Activity } from '../module_bindings/types';

function parse(text: string, fallback: unknown): unknown {
  if (!text) return fallback;
  return JSON.parse(text);
}

export function hashedBody(r: Activity): Record<string, unknown> {
  return {
    at: r.at,
    principal: r.principal,
    role: r.role,
    kind: r.kind,
    command: r.command,
    params: parse(r.params, {}),
    used: parse(r.used, []),
    plan: parse(r.plan, []),
    outcome: r.outcome,
    reasons: parse(r.reasons, []),
    claims: parse(r.claims, []),
    context: parse(r.context, {}),
  };
}

export function rowHash(r: Activity): string {
  try {
    return chainHash(r.prevHash, hashedBody(r));
  } catch {
    return ''; // a column that is not JSON cannot match its hash
  }
}

export interface ChainReport {
  total: number;
  checked: number;
  verified: number;
  firstBreak: { id: bigint; why: string } | null;
  headMatches: boolean | null; // last row's hash equals chain_head.hash
  anchored: { hash: string; at: string; found: boolean } | null;
  ms: number;
  done: boolean;
  tampered: boolean;
}

// Chunked so a long chain never freezes the page; reports progress as it goes.
export function verifyChain(
  rows: Activity[],
  head: { hash: string; anchoredHash: string; anchoredAt: string } | undefined,
  onProgress: (r: ChainReport) => void,
  tamper?: (r: Activity) => Activity
): () => void {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const t0 = performance.now();
  let i = 0;
  let verified = 0;
  let prev = 'genesis';
  let firstBreak: ChainReport['firstBreak'] = null;
  let cancelled = false;
  const anchoredHash = head?.anchoredHash ?? '';
  let anchorFound = false;
  const report = (done: boolean): ChainReport => ({
    total: sorted.length,
    checked: i,
    verified,
    firstBreak,
    headMatches: done ? (sorted.length ? sorted[sorted.length - 1].hash === head?.hash : head ? head.hash === 'genesis' : null) : null,
    anchored: anchoredHash ? { hash: anchoredHash, at: head?.anchoredAt ?? '', found: anchorFound } : null,
    ms: Math.round(performance.now() - t0),
    done,
    tampered: !!tamper,
  });
  const step = () => {
    if (cancelled) return;
    const end = Math.min(sorted.length, i + 1200);
    for (; i < end; i++) {
      const r = tamper ? tamper(sorted[i]) : sorted[i];
      const linked = r.prevHash === prev;
      const hashOk = rowHash(r) === r.hash;
      if (linked && hashOk) verified++;
      else if (!firstBreak) firstBreak = { id: r.id, why: !hashOk ? 'its contents no longer match its hash' : 'it does not point at the row before it' };
      if (anchoredHash && r.hash === anchoredHash) anchorFound = true;
      // Follow the stored hash so one bad row is reported once, not for every row after it.
      prev = r.hash;
    }
    const done = i >= sorted.length;
    onProgress(report(done));
    if (!done) setTimeout(step, 0);
  };
  setTimeout(step, 0);
  return () => {
    cancelled = true;
  };
}
