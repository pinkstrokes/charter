// Calling the module as a persona, and reading back what the kernel did with it.
// A reducer can fail in two ways: the module refuses outright (wrong role, bad
// input: the call rejects with the kernel's message) or the kernel records the
// attempt as denied (policy said no: the call succeeds and a red row lands in
// the activity chain). Both come back here so the UI can show them inline.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { Activity } from '../module_bindings/types';
import { parseArr } from '../lib/json';
import { policyById } from '../lib/policies';
import { charter, message } from './client';
import { store } from './store';

export interface ActionResult {
  status: 'ok' | 'denied' | 'error';
  message: string;
  rows: Activity[];
  value?: unknown;
  as: string; // persona name
}

export interface ActOptions {
  persona?: string;
  call: (conn: DbConnection) => Promise<unknown>;
  // Which new activity rows belong to this action. Defaults to rows recorded under the caller's principal.
  match?: (row: Activity, principalId: string) => boolean;
  wait?: number;
}

export function principalId(role: string, name: string): string {
  return `${role}:${name}`;
}

function maxActivityId(): bigint {
  let m = 0n;
  for (const r of store.rows.activity) if (r.id > m) m = r.id;
  return m;
}

function waitForRows(after: bigint, match: (r: Activity) => boolean, timeout: number): Promise<Activity[]> {
  return new Promise(resolve => {
    let found = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const collect = () => store.rows.activity.filter(r => r.id > after && match(r)).sort((a, b) => (a.id < b.id ? -1 : 1));
    const finish = () => {
      unsub();
      clearTimeout(hard);
      if (settle) clearTimeout(settle);
      resolve(collect());
    };
    const check = () => {
      const n = collect().length;
      if (n > found) {
        found = n;
        if (settle) clearTimeout(settle);
        settle = setTimeout(finish, 150);
      }
    };
    const unsub = store.subscribe(check);
    const hard = setTimeout(finish, timeout);
    check();
  });
}

export async function act(opts: ActOptions): Promise<ActionResult> {
  const pc = opts.persona ? charter.persona(opts.persona) : charter.activePersona();
  const as = pc?.persona.name ?? 'nobody';
  if (!pc || !pc.conn) return { status: 'error', message: 'no persona is connected', rows: [], as };
  if (pc.state !== 'live') return { status: 'error', message: `${as} is not connected (${pc.error || pc.state})`, rows: [], as };
  // The kernel records the principal by its bound role and name; read them from the table when present.
  const identity = (pc.identity || pc.persona.identity).toLowerCase().replace(/^0x/, '');
  const bound = store.rows.principal.find(p => p.identity.toHexString().toLowerCase().replace(/^0x/, '') === identity);
  const pid = bound ? principalId(bound.role, bound.name) : principalId(pc.persona.role, pc.persona.name);
  const before = maxActivityId();
  const match = opts.match ? (r: Activity) => opts.match!(r, pid) : (r: Activity) => r.principal === pid;
  let value: unknown;
  try {
    value = await opts.call(pc.conn);
  } catch (e) {
    return { status: 'error', message: message(e), rows: [], as };
  }
  const rows = await waitForRows(before, match, opts.wait ?? 2500);
  const stopped = rows.filter(r => r.outcome === 'denied' || r.outcome === 'rejected');
  if (stopped.length) {
    // The kernel's reasons name a policy and its check ("P-3: forbidden while ..."); say them in the policy's own words.
    const reasons = stopped.flatMap(r => parseArr<string>(r.reasons)).map(r => {
      const id = /^([A-Z]+-?\d+):/.exec(r)?.[1];
      const p = id ? policyById(store.rows.policy, id) : undefined;
      return p?.text ? `${id}: ${p.text.replace(/\.$/, '')}` : r;
    });
    return { status: 'denied', message: reasons.join('; ') || 'denied by the kernel', rows, value, as };
  }
  return { status: 'ok', message: typeof value === 'string' ? value : '', rows, value, as };
}

export function useAction(): { run: (opts: ActOptions) => Promise<ActionResult>; pending: boolean; result: ActionResult | null; clear: () => void } {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async (opts: ActOptions) => {
    setPending(true);
    setResult(null);
    const r = await act(opts);
    if (alive.current) {
      setPending(false);
      setResult(r);
    }
    return r;
  }, []);
  const clear = useCallback(() => setResult(null), []);
  return { run, pending, result, clear };
}
