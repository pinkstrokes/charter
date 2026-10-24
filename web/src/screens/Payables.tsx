// The payables desk, added as a pack on the same kernel: the payables clerk
// matches each vendor bill against its purchase order and goods receipt, the
// payments seat prepares Friday runs, and a person releases every payment, only
// to verified accounts, two people above $25,000. The rules learned on the
// receivables side bind here too.
import { ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import type { Activity, Bill, Entity, Payment } from '../module_bindings/types';
import { ActorTag, Empty, FeatureTable, Result } from '../components/ui';
import { useConfig, useMe, usePolicyLookup } from '../app/data';
import { openWhy } from '../app/nav';
import { day, daysBetween, money } from '../lib/format';
import { parseArr, parseObj } from '../lib/json';
import { outcomeText } from '../lib/rules';
import { useAction } from '../stdb/actions';
import { useRows } from '../stdb/store';
import { DecisionBox } from './Why';

const BILL_TONE: Record<string, string> = {
  received: '',
  held: 'asked',
  approved: 'committed',
  scheduled: 'asked',
  paid: '',
  rejected: 'cancelled',
};

export function Payables() {
  const bills = useRows('bill');
  const payments = useRows('payment');
  const entities = useRows('entity');
  const routing = useRows('routingRequest');
  const activity = useRows('activity');
  const vendors = useMemo(() => entities.filter(e => e.kind === 'vendor'), [entities]);
  const vendorName = (code: string) => entities.find(e => e.code === code)?.name ?? code;
  // Every refused attempt that touched a payment or a bill, by what it touched.
  const stoppedBy = useMemo(() => {
    const m = new Map<string, Activity[]>();
    for (const a of activity) {
      if (a.outcome !== 'denied' && a.outcome !== 'rejected') continue;
      for (const u of parseArr<string>(a.used)) if (u.startsWith('payment:') || u.startsWith('bill:')) m.set(u, [...(m.get(u) ?? []), a]);
    }
    return m;
  }, [activity]);
  const vendorChanges = routing.filter(r => vendors.some(v => v.code === r.entityCode));
  if (!bills.length && !payments.length && !vendors.length)
    return (
      <div className="page-inner">
        <div className="sheet">
          <Empty title="No payables desk in this company">The payables pack adds vendors, bills and payment runs; this database has none.</Empty>
        </div>
      </div>
    );
  return (
    <div className="page-inner">
      <div className="page-head">
        <h1 className="page-title">Payables</h1>
        <p className="page-sub">Every bill is matched against its purchase order and what was received. Every payment is released by a person, only to an account confirmed by phone.</p>
      </div>
      <div className="stack">
        <PaymentRuns payments={payments} vendorName={vendorName} vendors={vendors} stoppedBy={stoppedBy} />
        <Bills bills={bills} vendorName={vendorName} stoppedBy={stoppedBy} />
        {vendorChanges.length > 0 && (
          <section className="sheet" aria-label="Vendor bank changes">
            <div className="sheet-pad" style={{ paddingBottom: 6 }}>
              <div className="section-head">
                <h2 className="section-title">Vendor bank-account changes</h2>
                <span className="aside">while one is unverified, no payment to that vendor leaves</span>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Vendor</th>
                  <th>Wants</th>
                  <th>Callback</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {vendorChanges.map(r => (
                  <tr key={r.id.toString()}>
                    <td className="num">{r.id.toString()}</td>
                    <td>
                      {vendorName(r.entityCode)}
                      <div className="faint" style={{ fontSize: 12 }}>
                        on file {entities.find(e => e.code === r.entityCode)?.bankAccount}
                      </div>
                    </td>
                    <td>{r.requestedAccount}</td>
                    <td>{r.callbackStatus === 'none' ? <span className="faint">not yet</span> : r.callbackStatus}</td>
                    <td>
                      <span className={`chip ${r.status === 'rejected' ? 'denied' : r.status === 'held' ? 'asked' : ''}`}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}

function PaymentRuns({ payments, vendorName, vendors, stoppedBy }: { payments: Payment[]; vendorName: (c: string) => string; vendors: Entity[]; stoppedBy: Map<string, Activity[]> }) {
  const sorted = useMemo(() => [...payments].sort((a, b) => (a.preparedAt < b.preparedAt ? 1 : a.preparedAt > b.preparedAt ? -1 : a.id.localeCompare(b.id))), [payments]);
  return (
    <section className="sheet" aria-label="Payment runs">
      <div className="sheet-pad" style={{ paddingBottom: 6 }}>
        <div className="section-head">
          <h2 className="section-title">Payment runs</h2>
          <span className="aside">prepared by the payments seat on Fridays; released by someone else (C13); two people above {money(2_500_000, { whole: true })} (C14)</span>
        </div>
      </div>
      {sorted.length === 0 ? (
        <Empty title="No payment runs yet">The payments seat prepares a run every Friday for approved bills due within a week.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Vendor</th>
              <th>Bills</th>
              <th>To account</th>
              <th className="n">Amount</th>
              <th>Approvals</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map(p => (
              <PaymentRow key={p.id} p={p} vendor={vendors.find(v => v.code === p.vendorCode)} vendorName={vendorName(p.vendorCode)} stopped={stoppedBy.get(`payment:${p.id}`) ?? []} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PaymentRow({ p, vendor, vendorName, stopped }: { p: Payment; vendor?: Entity; vendorName: string; stopped: Activity[] }) {
  const act = useAction();
  const me = useMe();
  const policyOf = usePolicyLookup();
  const approvals = parseArr<string>(p.approvals);
  const bills = parseArr<string>(p.billIds);
  const trusted = !!vendor && vendor.bankAccountTrusted && vendor.bankAccount === p.bankAccount;
  return (
    <>
      <tr>
        <td>
          <button className="btn small quiet" onClick={() => openWhy(p.activityId)} title="Why this run was prepared">
            {p.id}
          </button>
        </td>
        <td>{vendorName}</td>
        <td style={{ fontSize: 12 }}>{bills.join(', ')}</td>
        <td>
          {p.bankAccount}
          <div className={trusted ? 'faint' : 'red'} style={{ fontSize: 11 }}>
            {trusted ? 'on file, confirmed' : 'not the confirmed account'}
          </div>
        </td>
        <td className="n">{money(p.amountCents)}</td>
        <td>{approvals.length ? approvals.map(a => a.split(':')[1] ?? a).join(', ') : <span className="faint">none</span>}</td>
        <td>
          <span className={`chip ${p.status === 'cancelled' ? 'cancelled' : p.status === 'prepared' ? 'asked' : ''}`}>{p.status}</span>
        </td>
        <td className="n">
          {p.status === 'prepared' && (
            <button className="btn small primary" disabled={act.pending} onClick={() => void act.run({ call: c => c.reducers.releasePayment({ paymentId: p.id }) })}>
              Release as {me.name}
            </button>
          )}
        </td>
      </tr>
      {stopped.length > 0 && (
        <tr>
          <td colSpan={8} style={{ paddingTop: 0 }}>
            {stopped.map(s => (
              <div key={s.id.toString()} className="row" style={{ gap: 6, fontSize: 12, color: 'var(--red)' }}>
                <ShieldAlert size={12} />
                <button className="btn small quiet" style={{ height: 20, padding: '0 5px', color: 'inherit' }} onClick={() => openWhy(s.id)}>
                  #{s.id.toString()}
                </button>
                <ActorTag principal={s.principal} />
                <span>
                  {day(s.at)}:{' '}
                  {parseArr<string>(s.reasons)
                    .map(r => {
                      const pid = /^([A-Z][A-Za-z]*-?[A-Za-z0-9]*):/.exec(r)?.[1];
                      const pol = pid ? policyOf(pid) : undefined;
                      return pol ? `${pid}: ${pol.text}` : r;
                    })
                    .join('; ')}
                </span>
              </div>
            ))}
          </td>
        </tr>
      )}
      {(act.result || act.pending) && (
        <tr>
          <td colSpan={8}>
            <Result r={act.result} pending={act.pending} />
          </td>
        </tr>
      )}
    </>
  );
}

function Bills({ bills, vendorName, stoppedBy }: { bills: Bill[]; vendorName: (c: string) => string; stoppedBy: Map<string, Activity[]> }) {
  const decisions = useRows('decision');
  const skills = useRows('skill');
  const cfg = useConfig();
  const [open, setOpen] = useState('');
  const sorted = useMemo(() => [...bills].sort((a, b) => (a.billDate < b.billDate ? 1 : a.billDate > b.billDate ? -1 : a.id.localeCompare(b.id))), [bills]);
  const latest = (billId: string) => decisions.filter(d => d.domain === 'bill_match' && !d.shadow && d.subject === `bill:${billId}`).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  return (
    <section className="sheet" aria-label="Bills">
      <div className="sheet-pad" style={{ paddingBottom: 6 }}>
        <div className="section-head">
          <h2 className="section-title">Vendor bills</h2>
          <span className="aside">three-way match: the bill, its purchase order, and what was actually received</span>
        </div>
      </div>
      {sorted.length === 0 ? (
        <Empty title="No bills yet" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Bill</th>
              <th>Vendor</th>
              <th>Order</th>
              <th>Dated</th>
              <th>Due</th>
              <th className="n">Amount</th>
              <th className="n">Open</th>
              <th>Status</th>
              <th>Clerk decided</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(b => {
              const d = latest(b.id);
              const f = d ? parseObj(d.features) : null;
              const expanded = open === b.id;
              const stopped = stoppedBy.get(`bill:${b.id}`) ?? [];
              return (
                <Fragment key={b.id}>
                  <tr className="clickable" onClick={() => setOpen(expanded ? '' : b.id)}>
                    <td>
                      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />} <b style={{ fontWeight: 600 }}>{b.billNo}</b>
                    </td>
                    <td>{vendorName(b.vendorCode)}</td>
                    <td>{b.poNo || <span className="faint">none</span>}</td>
                    <td className="n">{day(b.billDate)}</td>
                    <td className="n">
                      {day(b.dueAt)}
                      {cfg && b.openCents > 0n && daysBetween(cfg.simDate, b.dueAt) < 0 ? <span className="faint"> (late)</span> : ''}
                    </td>
                    <td className="n">{money(b.amountCents)}</td>
                    <td className="n">{money(b.openCents)}</td>
                    <td>
                      <span className={`chip ${BILL_TONE[b.status] ?? ''}`}>{b.status}</span>
                      {b.note && (
                        <div className="faint" style={{ fontSize: 11, marginTop: 2, maxWidth: 220 }}>
                          {b.note}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 13 }}>
                      {d ? (
                        <>
                          {outcomeText(d.outcome)}
                          {typeof f?.duplicate_score === 'number' && f.duplicate_score >= 0.8 ? <span className="faint"> (looks like a duplicate)</span> : null}
                          {d.label && (
                            <div className="faint" style={{ fontSize: 11 }}>
                              checked: {d.label === d.outcome ? 'right' : `should be ${outcomeText(d.label).toLowerCase()}`}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="faint">not yet</span>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={9} style={{ background: 'var(--sheet-2)' }}>
                        <div className="split-even" style={{ gap: 14 }}>
                          <div>{f ? <FeatureTable features={f} domain="bill_match" /> : <span className="faint">The clerk has not looked at this bill yet.</span>}</div>
                          <div>{d ? <DecisionBox d={d} skills={skills} title="The clerk's decision" /> : null}</div>
                        </div>
                        {stopped.map(s => (
                          <div key={s.id.toString()} className="row red" style={{ gap: 6, fontSize: 12 }}>
                            <ShieldAlert size={12} /> #{s.id.toString()} {parseArr<string>(s.reasons).join('; ')}
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
