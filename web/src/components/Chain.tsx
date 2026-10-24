import { Link2, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { Activity } from '../module_bindings/types';
import { verifyChain, type ChainReport } from '../lib/chain';
import { num } from '../lib/format';
import { store, useRows } from '../stdb/store';

interface ChainState {
  report: ChainReport | null;
  running: boolean;
  rowsAtRun: number;
  from: bigint | null; // the Why row the check was started from, if any
}

let state: ChainState = { report: null, running: false, rowsAtRun: 0, from: null };
const listeners = new Set<() => void>();
let cancel: (() => void) | null = null;

function set(next: Partial<ChainState>): void {
  state = { ...state, ...next };
  listeners.forEach(fn => fn());
}

export function useChainState(): ChainState {
  return useSyncExternalStore(
    fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state
  );
}

// Verify every row; optionally pretend one row was edited in this browser's copy.
export function runVerify(tamperId?: bigint, from: bigint | null = null): void {
  cancel?.();
  const rows = store.rows.activity;
  const head = store.rows.chainHead[0];
  set({ running: true, report: null, rowsAtRun: rows.length, from });
  const tamper = tamperId === undefined ? undefined : (r: Activity) => (r.id === tamperId ? tamperRow(r) : r);
  cancel = verifyChain(rows, head, report => set({ report, running: !report.done }), tamper);
}

// The smallest edit a thief would want: change an amount, or failing that, who did it.
function tamperRow(r: Activity): Activity {
  try {
    const p = JSON.parse(r.params) as Record<string, unknown>;
    for (const k of ['amount', 'amountCents', 'cents', 'open']) {
      if (typeof p[k] === 'number') {
        p[k] = (p[k] as number) + 100;
        return { ...r, params: JSON.stringify(p) };
      }
    }
  } catch {
    /* fall through */
  }
  return { ...r, principal: `${r.principal} (edited)` };
}

export function ChainBadge() {
  const s = useChainState();
  const rows = useRows('activity');
  const r = s.report;
  const stale = r && r.done && rows.length !== s.rowsAtRun;
  return (
    <span className="row" style={{ gap: 6, fontSize: 12, flexWrap: 'nowrap' }}>
      {s.running && r ? (
        <span className="verify-out">
          <Loader2 size={13} className="spin" /> {num(r.checked)} / {num(r.total)}
        </span>
      ) : r && r.done && !r.tampered ? (
        r.firstBreak ? (
          <span className="verify-out bad">
            <ShieldAlert size={13} /> breaks at #{r.firstBreak.id.toString()}
          </span>
        ) : (
          <span className="verify-out ok" title={`${num(r.verified)} rows re-hashed in this browser in ${r.ms} ms`}>
            <ShieldCheck size={13} /> {num(r.verified)} of {num(r.total)} verify{stale ? ', since grown' : ''}
          </span>
        )
      ) : (
        <span className="faint">
          <Link2 size={12} style={{ verticalAlign: -2 }} /> {num(rows.length)} chained
        </span>
      )}
      <button className="btn small quiet" onClick={() => runVerify()} disabled={s.running} title="Recompute every hash in this browser">
        Verify
      </button>
    </span>
  );
}
