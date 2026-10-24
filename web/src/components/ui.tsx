import { AlertTriangle, Check, Loader2, Lock, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Policy } from '../module_bindings/types';
import { actor as toActor, commandLabel, money } from '../lib/format';
import { summarize } from '../lib/summary';
import { labelOf, valueText } from '../lib/values';
import { policyKind } from '../lib/policies';
import { featureKind, featureLabel, featureSpec, featureValue } from '../lib/rules';
import type { ActionResult } from '../stdb/actions';
import { openWhy } from '../app/nav';

export function Money({ cents, className = '', whole }: { cents: bigint | number | string; className?: string; whole?: boolean }) {
  return <span className={`money ${className}`}>{money(cents, { whole })}</span>;
}

const OUTCOME_CLASS: Record<string, string> = {
  committed: 'committed',
  denied: 'denied',
  rejected: 'rejected',
  asked: 'asked',
  stored_untrusted: 'untrusted',
  pass: 'committed',
  fail: 'untrusted',
};

export function OutcomeChip({ outcome }: { outcome: string }) {
  const cls = OUTCOME_CLASS[outcome] ?? '';
  const label = outcome === 'stored_untrusted' ? 'untrusted' : outcome.replace(/_/g, ' ');
  return <span className={`chip ${cls}`}>{label}</span>;
}

export function StatusChip({ status, fraction }: { status: string; fraction?: number }) {
  const label = status === 'canary' && fraction !== undefined ? `canary ${Math.round(fraction * 100)}%` : status;
  return <span className={`chip ${status}`}>{label}</span>;
}

export function SeverityChip({ severity }: { severity: string }) {
  const tone = severity === 'critical' ? 'denied' : severity === 'major' ? 'rejected' : severity === 'minor' ? '' : 'untrusted';
  return <span className={`chip ${tone}`}>{severity}</span>;
}

export function ActorTag({ principal, role }: { principal: string; role?: string }) {
  const a = toActor(principal, role);
  const glyph = a.kind === 'person' ? a.label.charAt(0) : a.kind === 'seat' ? a.label.charAt(0) : a.kind === 'evolver' ? 'E' : '';
  return (
    <span className={`actor actor-${a.kind}`} title={principal}>
      {glyph && (
        <span className="glyph" aria-hidden>
          {glyph}
        </span>
      )}
      {a.label}
    </span>
  );
}

export function PolicyChip({ p, hit, withText }: { p: Policy; hit?: boolean; withText?: boolean }) {
  const kind = policyKind(p);
  return (
    <span className={`chip policy ${kind} ${hit ? 'hit' : ''}`} title={p.text}>
      {kind === 'constitution' && <Lock size={10} aria-hidden />}
      {p.policyId}
      {withText && <span style={{ fontWeight: 400 }}>{p.text}</span>}
    </span>
  );
}

export function Result({ r, pending, idle }: { r: ActionResult | null; pending?: boolean; idle?: ReactNode }) {
  if (pending)
    return (
      <div className="result" role="status">
        <Loader2 size={14} className="spin" aria-hidden /> Working…
      </div>
    );
  if (!r) return idle ? <>{idle}</> : null;
  const last = r.rows[r.rows.length - 1];
  if (r.status === 'error')
    return (
      <div className="result error" role="alert">
        <X size={14} aria-hidden />
        <span>
          Refused for {r.as}: {r.message}
        </span>
      </div>
    );
  if (r.status === 'denied') {
    const stopped = r.rows.find(x => x.outcome === 'denied' || x.outcome === 'rejected') ?? last;
    return (
      <div className="result denied" role="alert">
        <AlertTriangle size={14} aria-hidden />
        <span>
          {stopped?.outcome === 'rejected' ? 'Rejected' : 'Denied'} by the kernel: {r.message}
          {stopped && (
            <>
              {' '}
              <button className="link" onClick={() => openWhy(stopped.id)}>
                See #{stopped.id.toString()}
              </button>
            </>
          )}
        </span>
      </div>
    );
  }
  return (
    <div className="result" role="status">
      <Check size={14} aria-hidden />
      <span>
        {r.message || (last ? `${commandLabel(last.kind, last.command)}: ${summarize(last)}` : 'Done')}
        {last && (
          <>
            {' '}
            <button className="link" onClick={() => openWhy(last.id)}>
              recorded as #{last.id.toString()}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

// A domain's features as a compact two-column table; `used` rows are what the deciding rule read.
export function FeatureTable({ features, domain, used, limit }: { features: Record<string, unknown>; domain?: string; used?: Set<string>; limit?: number }) {
  const entries = Object.entries(features).filter(([, v]) => typeof v !== 'object' || v === null);
  const shown = limit ? entries.slice(0, limit) : entries;
  if (!shown.length) return null;
  return (
    <div className="features">
      <table>
        <tbody>
          {shown.map(([k, v]) => (
            <tr key={k} className={used?.has(k) ? 'used' : ''} title={featureSpec(domain ?? '', k)?.doc}>
              <td>{featureLabel(k)}</td>
              <td className={featureKind(k, domain) === 'money' ? 'money' : 'num'}>{featureValue(k, v, domain)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function KV({ data, keys, columns = 1 }: { data: Record<string, unknown>; keys?: string[]; columns?: 1 | 2 }) {
  const entries = (keys ?? Object.keys(data)).filter(k => k in data).map(k => [k, data[k]] as const);
  if (!entries.length) return <span className="faint">nothing</span>;
  const flat = entries.every(([, v]) => v === null || typeof v !== 'object' || (Array.isArray(v) && v.every(x => typeof x !== 'object')));
  return (
    <dl className={`kv ${columns === 2 && flat && entries.length > 5 ? 'two' : ''}`}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{labelOf(k)}</dt>
          <dd>{typeof v === 'object' && v !== null && !Array.isArray(v) ? <KV data={v as Record<string, unknown>} /> : Array.isArray(v) && v.some(x => typeof x === 'object' && x !== null) ? <JsonTable rows={v as Record<string, unknown>[]} /> : valueText(k, v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonTable({ rows, max = 50 }: { rows: Record<string, unknown>[]; max?: number }) {
  const objs = rows.filter(r => r && typeof r === 'object');
  if (!objs.length) return <span className="faint">none</span>;
  const cols = [...new Set(objs.flatMap(r => Object.keys(r)))];
  return (
    <table className="table compact">
      <thead>
        <tr>
          {cols.map(c => (
            <th key={c}>{c.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {objs.slice(0, max).map((r, i) => (
          <tr key={i}>
            {cols.map(c => (
              <td key={c} className={typeof r[c] === 'number' ? 'n' : ''}>
                {valueText(c, r[c])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Pill({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}
