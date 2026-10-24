// The third line of defence and the month-end close. The internal auditor reads
// everything and can only report (findings and an opinion per period); a
// controller closes a month only after the auditor has reported, and the close
// writes a certificate whose hash this page re-computes with the kernel's own
// hash function.
import { Check, FileCheck2, Lock, ShieldCheck, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { sha256Hex } from '@module/core/hash';
import type { AuditOpinion, Finding, PeriodClose } from '../module_bindings/types';
import { ActorTag, Empty, KV, Result, SeverityChip } from '../components/ui';
import { useConfig, useMe } from '../app/data';
import { openWhy } from '../app/nav';
import { day, money, num } from '../lib/format';
import { parseObj } from '../lib/json';
import { subjectLabel } from '../lib/lineage';
import { useAction } from '../stdb/actions';
import { toast } from '../components/Toast';
import { useRows } from '../stdb/store';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthName(period: string): string {
  const m = Number(period.slice(5, 7));
  return `${MONTHS[m - 1] ?? period} ${period.slice(0, 4)}`;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 };

export function InternalAudit() {
  const findings = useRows('finding');
  const opinions = useRows('auditOpinion');
  const [show, setShow] = useState<'open' | 'all'>('open');
  const sortedOpinions = useMemo(() => [...opinions].sort((a, b) => b.period.localeCompare(a.period)), [opinions]);
  const list = useMemo(
    () =>
      [...findings]
        .filter(f => show === 'all' || f.status === 'open')
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.period.localeCompare(a.period) || (a.id < b.id ? 1 : -1)),
    [findings, show]
  );
  return (
    <div className="stack">
      <section className="sheet" aria-label="Opinions">
        <div className="sheet-pad" style={{ paddingBottom: 6 }}>
          <div className="section-head">
            <h2 className="section-title">The auditor's opinion, month by month</h2>
            <span className="aside">a separate identity that can read everything and only report</span>
          </div>
        </div>
        {sortedOpinions.length === 0 ? (
          <Empty title="No opinion yet">The internal auditor samples each month after it ends and reports here; a month cannot be closed before it does.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Opinion</th>
                <th className="n">Sample</th>
                <th className="n">Projected misstatement</th>
                <th>Upper limit against tolerable</th>
              </tr>
            </thead>
            <tbody>
              {sortedOpinions.map(o => (
                <OpinionRow key={o.period} o={o} />
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="sheet" aria-label="Findings">
        <div className="sheet-pad" style={{ paddingBottom: 6 }}>
          <div className="section-head">
            <h2 className="section-title">Findings</h2>
            <div className="feed-filters" role="group" aria-label="Which findings">
              <button className="feed-filter" aria-pressed={show === 'open'} onClick={() => setShow('open')}>
                Open {findings.filter(f => f.status === 'open').length}
              </button>
              <button className="feed-filter" aria-pressed={show === 'all'} onClick={() => setShow('all')}>
                All {findings.length}
              </button>
            </div>
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            Major and critical findings become questions for a controller. A finding that shows a decision was wrong also counts against the rule that made it.
          </div>
        </div>
        {list.length === 0 ? (
          <Empty title={show === 'open' ? 'No open findings' : 'No findings yet'} />
        ) : (
          list.map(f => <FindingRow key={f.id.toString()} f={f} />)
        )}
      </section>
    </div>
  );
}

function OpinionRow({ o }: { o: AuditOpinion }) {
  const tol = Number(o.tolerableCents);
  const ul = Number(o.upperLimitCents);
  const pm = Number(o.projectedMisstatementCents);
  const within = tol > 0 && ul <= tol;
  const report = parseObj(o.report);
  const x = (v: number) => `${tol > 0 ? Math.min(100, (v / tol) * 50) : 0}%`;
  return (
    <>
    <tr>
      <td style={{ fontWeight: 600 }}>{monthName(o.period)}</td>
      <td>
        <span className={`chip ${o.opinion === 'adverse' ? 'denied' : o.opinion === 'qualified' ? 'tightened' : 'verified'}`}>{o.opinion}</span>
        <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>
          {day(o.at)}
        </div>
      </td>
      <td className="n">{o.sampleSize}</td>
      <td className="n">{money(pm)}</td>
      <td style={{ minWidth: 220 }}>
        <div className="num" style={{ fontSize: 12 }}>
          {money(ul)} against {money(tol)} tolerable {within ? <Check size={12} className="tick" style={{ verticalAlign: -1 }} /> : null}
        </div>
        <div style={{ position: 'relative', height: 8, marginTop: 3, background: 'var(--rule)', borderRadius: 4 }}>
          <span style={{ position: 'absolute', left: 0, width: x(pm), top: 1, bottom: 1, borderRadius: 3, background: 'var(--ink-2)' }} title="projected" />
          <span style={{ position: 'absolute', left: x(pm), width: `calc(${x(ul)} - ${x(pm)})`, top: 1, bottom: 1, borderRadius: 3, background: within ? 'var(--tick)' : 'var(--taro)', opacity: 0.6 }} title="upper limit" />
          <span style={{ position: 'absolute', left: '50%', top: -3, bottom: -3, width: 1.5, background: 'var(--ink-2)' }} title="tolerable" />
        </div>
      </td>
    </tr>
    <tr>
      <td colSpan={5} style={{ paddingTop: 0 }}>
        <ReportDetail report={report} />
      </td>
    </tr>
    </>
  );
}

// The report under its month: every control tested over the whole population,
// then each monetary-unit sample, in the auditor's own numbers.
function ReportDetail({ report }: { report: Record<string, unknown> }) {
  const controls = (report.controls as { id: string; name: string; population: number; exceptions: number }[] | undefined) ?? [];
  const samples = (report.samples as { name: string; population: number; sampleSize: number; projectedCents: number; upperLimitCents: number; tolerableCents: number }[] | undefined) ?? [];
  return (
    <div className="audit-detail">
      {controls.length > 0 && (
        <div>
          <div className="label">Controls, tested over every case</div>
          <div className="audit-controls">
            {controls.map(c => (
              <div key={c.id} className="audit-control">
                {c.exceptions ? <X size={13} style={{ color: 'var(--red)' }} /> : <Check size={13} className="tick" />}
                <span>{c.name}</span>
                <span className="num faint">{c.exceptions ? `${c.exceptions} of ${c.population}` : c.population}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {samples.length > 0 && (
        <div>
          <div className="label">Monetary-unit samples</div>
          {samples.map(m => (
            <div key={m.name} className="audit-control">
              {m.upperLimitCents <= m.tolerableCents ? <Check size={13} className="tick" /> : <X size={13} style={{ color: 'var(--red)' }} />}
              <span>
                {m.name}: {m.sampleSize} of {m.population} re-performed; projected {money(m.projectedCents)}, upper limit {money(m.upperLimitCents)} against {money(m.tolerableCents)} tolerable
              </span>
            </div>
          ))}
        </div>
      )}
      {typeof report.method === 'string' && (
        <div className="faint" style={{ fontSize: 12 }}>
          {report.method}
          {typeof report.reader === 'string' ? `; documents re-read by ${report.reader}` : ''}
        </div>
      )}
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const ev = parseObj(f.evidence);
  const label = ev.label as { domain?: string; subject?: string; correct?: string } | undefined;
  const rest = { ...ev };
  delete rest.label;
  return (
    <div className="event" style={{ gridTemplateColumns: '84px minmax(0,1fr) auto' }}>
      <span>
        <SeverityChip severity={f.severity} />
      </span>
      <span className="event-title">
        {f.test.replace(/_/g, ' ')} <span className="faint" style={{ fontWeight: 400 }}>on {subjectLabel(f.subject)}</span>
      </span>
      <span className="faint num" style={{ fontSize: 12 }}>
        #{f.id.toString()}, {f.period}, filed {day(f.at)}
      </span>
      <span className="event-detail">
        <span style={{ color: 'var(--ink)' }}>{f.detail}</span>
        {label?.correct && (
          <span className="muted">
            {' '}
            Counts as a check of the {label.domain} decision on {subjectLabel(label.subject ?? '')}: it should have been {label.correct.replace(/_/g, ' ')}.
          </span>
        )}
        {Object.keys(rest).length > 0 && (
          <details style={{ marginTop: 4 }}>
            <summary className="faint" style={{ cursor: 'pointer' }}>
              Evidence
            </summary>
            <KV data={rest} />
          </details>
        )}
        <div style={{ marginTop: 4 }}>
          {f.status === 'resolved' ? (
            <span className="row" style={{ gap: 6, fontSize: 12 }}>
              <span className="chip">resolved</span>
              {f.resolution} by <ActorTag principal={f.resolvedBy} />
            </span>
          ) : (
            <span className="chip asked">open</span>
          )}
        </div>
      </span>
    </div>
  );
}

// ---------- the close ----------

export function PeriodCloseView() {
  const closes = useRows('periodClose');
  const opinions = useRows('auditOpinion');
  const findings = useRows('finding');
  const invoices = useRows('invoice');
  const receipts = useRows('receipt');
  const bills = useRows('bill');
  const cfg = useConfig();
  const current = cfg?.simDate.slice(0, 7) ?? '';
  // Months that have books: anything invoiced, received or billed, oldest first.
  const periods = useMemo(() => {
    const set = new Set<string>();
    const add = (d: string) => /^\d{4}-\d{2}/.test(d) && set.add(d.slice(0, 7));
    invoices.forEach(i => add(i.issuedAt));
    receipts.forEach(r => add(r.receivedAt));
    bills.forEach(b => add(b.billDate));
    for (const c of closes) set.add(c.period);
    for (const o of opinions) set.add(o.period);
    if (current) set.add(current);
    return [...set].sort();
  }, [invoices, receipts, bills, closes, opinions, current]);
  const [open, setOpen] = useState<string>('');
  const firstOpen = periods.find(p => p < current && !closes.some(c => c.period === p));
  return (
    <div className="stack">
      <section className="sheet" aria-label="Periods">
        <div className="sheet-pad" style={{ paddingBottom: 6 }}>
          <div className="section-head">
            <h2 className="section-title">Closing the books</h2>
            <span className="aside">a closed month is never written to again; what is learned later is booked now and disclosed</span>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Status</th>
              <th>Auditor</th>
              <th className="n">Open findings</th>
              <th>Certificate</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...periods].reverse().map(p => {
              const c = closes.find(x => x.period === p);
              const o = opinions.find(x => x.period === p);
              const f = findings.filter(x => x.period === p && x.status === 'open').length;
              return (
                <tr key={p} className={c ? 'clickable' : ''} onClick={c ? () => setOpen(open === p ? '' : p) : undefined}>
                  <td style={{ fontWeight: 600 }}>{monthName(p)}</td>
                  <td>
                    {c ? (
                      <span className="row" style={{ gap: 6 }}>
                        <Lock size={12} /> closed {day(c.closedAt)} by <ActorTag principal={c.closedBy} />
                      </span>
                    ) : p >= current ? (
                      <span className="muted">in progress</span>
                    ) : (
                      <span className="muted">ended, open</span>
                    )}
                  </td>
                  <td>{o ? <span className={`chip ${o.opinion === 'adverse' ? 'denied' : o.opinion === 'qualified' ? 'tightened' : 'verified'}`}>{o.opinion}</span> : <span className="faint">not reported</span>}</td>
                  <td className="n">{f || <span className="faint">0</span>}</td>
                  <td>{c ? <span className="mono" style={{ fontSize: 12 }}>{c.certificateHash.slice(0, 16)}…</span> : <span className="faint">none</span>}</td>
                  <td className="n" onClick={e => e.stopPropagation()}>
                    {!c && p === firstOpen && <CloseButton period={p} hasOpinion={!!o} />}
                    {c && (
                      <button className="btn small quiet" onClick={() => setOpen(open === p ? '' : p)}>
                        {open === p ? 'Hide' : 'Certificate'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      {open && closes.find(c => c.period === open) && <Certificate c={closes.find(c => c.period === open)!} />}
    </div>
  );
}

function CloseButton({ period, hasOpinion }: { period: string; hasOpinion: boolean }) {
  const act = useAction();
  const me = useMe();
  return (
    <div style={{ display: 'grid', gap: 4, justifyItems: 'end' }}>
      <button
        className="btn small primary"
        disabled={act.pending}
        onClick={() =>
          void act.run({ call: c => c.reducers.closePeriod({ period }) }).then(r => {
            if (r.status === 'ok') toast(`${monthName(period)} closed by ${r.as}`, r.rows[r.rows.length - 1]?.id);
          })
        }
        title={hasOpinion ? `Close ${period} as ${me.name}` : 'The kernel will refuse until the auditor reports'}>
        <FileCheck2 size={13} /> Close {monthName(period).split(' ')[0]} as {me.name}
      </button>
      <div style={{ maxWidth: 420, textAlign: 'left' }}>
        <Result r={act.result} pending={act.pending} />
      </div>
    </div>
  );
}

interface CertificateBody {
  period: string;
  closedAt: string;
  closedBy: string;
  trialBalance: { account: string; debitCents: number; creditCents: number }[];
  invariantsHold: boolean;
  auditorOpinion: { opinion: string; projectedMisstatementCents: number; upperLimitCents: number; tolerableCents: number; sampleSize: number };
  openFindings: { id: number; severity: string; test: string }[];
  openQuestionsCarried: number;
  priorPeriodItems: { invoice: string; kind: string; amountCents: number; relatesTo: string; source: string }[];
  activeSkills: string[];
  activePolicies: string[];
  chain: { lastActivityId: number; head: string };
}

function Certificate({ c }: { c: PeriodClose }) {
  const gl = useRows('glBalance');
  const [verified, setVerified] = useState<boolean | null>(null);
  let cert: CertificateBody | null = null;
  try {
    cert = JSON.parse(c.certificate) as CertificateBody;
  } catch {
    cert = null;
  }
  if (!cert) return <div className="banner error">The certificate for {c.period} is not readable JSON.</div>;
  const name = (acct: string) => gl.find(g => g.account === acct)?.name ?? '';
  const ar = cert.trialBalance.filter(t => ['1100', '1110', '1120'].includes(t.account)).reduce((s, t) => s + t.debitCents - t.creditCents, 0);
  const totals = cert.trialBalance.reduce((s, t) => ({ d: s.d + t.debitCents, c: s.c + t.creditCents }), { d: 0, c: 0 });
  return (
    <section className="sheet" aria-label={`Certificate for ${c.period}`}>
      <div className="sheet-pad">
        <div className="section-head">
          <h2 className="section-title">Close certificate, {monthName(c.period)}</h2>
          <span className="aside">
            closed {day(cert.closedAt, true)} by {cert.closedBy.split(':')[1] ?? cert.closedBy}
          </span>
        </div>
        <div className="row" style={{ gap: 14, fontSize: 13, marginBottom: 10 }}>
          <span className="mono" style={{ fontSize: 12 }}>
            sha256 {c.certificateHash}
          </span>
          <button className="btn small" onClick={() => setVerified(sha256Hex(c.certificate) === c.certificateHash)}>
            <ShieldCheck size={13} /> Re-hash in this browser
          </button>
          {verified !== null && (
            <span className={`verify-out ${verified ? 'ok' : 'bad'}`}>
              {verified ? <Check size={14} /> : <X size={14} />} {verified ? 'the certificate matches its hash' : 'the certificate does not match its hash'}
            </span>
          )}
        </div>
        <div className="split-even">
          <div>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Account at close</th>
                  <th className="n">Debits</th>
                  <th className="n">Credits</th>
                </tr>
              </thead>
              <tbody>
                {cert.trialBalance.map(t => (
                  <tr key={t.account}>
                    <td>
                      <span className="faint num">{t.account}</span> {name(t.account)}
                    </td>
                    <td className="n">{money(t.debitCents)}</td>
                    <td className="n">{money(t.creditCents)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td className="n">{money(totals.d)}</td>
                  <td className="n">{money(totals.c)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
            <dl className="kv">
              <dt>receivables at close</dt>
              <dd className="num">{money(ar)}</dd>
              <dt>controls</dt>
              <dd>{cert.invariantsHold ? <span className="tick">all held</span> : <span className="red">broken</span>}</dd>
              <dt>auditor</dt>
              <dd>
                {cert.auditorOpinion.opinion}, projected {money(cert.auditorOpinion.projectedMisstatementCents)}, upper limit {money(cert.auditorOpinion.upperLimitCents)} against {money(cert.auditorOpinion.tolerableCents)} ({cert.auditorOpinion.sampleSize} sampled)
              </dd>
              <dt>open findings</dt>
              <dd>{cert.openFindings.length ? cert.openFindings.map(f => `#${f.id} ${f.severity} ${f.test.replace(/_/g, ' ')}`).join('; ') : 'none'}</dd>
              <dt>questions carried</dt>
              <dd className="num">{num(cert.openQuestionsCarried)}</dd>
              <dt>chain head</dt>
              <dd>
                <button className="btn small quiet" onClick={() => openWhy(BigInt(cert!.chain.lastActivityId))}>
                  #{cert.chain.lastActivityId}
                </button>{' '}
                <span className="mono" style={{ fontSize: 12 }}>
                  {cert.chain.head.slice(0, 20)}…
                </span>
              </dd>
            </dl>
            <div>
              <div className="label">Prior-period items disclosed</div>
              {cert.priorPeriodItems.length === 0 ? (
                <div className="faint" style={{ fontSize: 13 }}>
                  none
                </div>
              ) : (
                <table className="table compact" style={{ marginTop: 4 }}>
                  <tbody>
                    {cert.priorPeriodItems.map(i => (
                      <tr key={i.invoice}>
                        <td>{i.invoice}</td>
                        <td>{i.kind}</td>
                        <td>relates to {i.relatesTo}</td>
                        <td className="n">{money(i.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <div className="label">In force at close</div>
              <div className="chips" style={{ marginTop: 4 }}>
                {cert.activeSkills.map(k => (
                  <span key={k} className="chip active">
                    {k}
                  </span>
                ))}
                {cert.activePolicies
                  .filter(k => k.startsWith('P-'))
                  .map(k => (
                    <span key={k} className="chip policy promoted">
                      {k.split('@')[0]}
                    </span>
                  ))}
                <span className="faint" style={{ fontSize: 12 }}>
                  and {cert.activePolicies.filter(k => !k.startsWith('P-')).length} founding policies
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
