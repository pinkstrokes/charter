import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import type { Entity, Invoice, Refund } from '../module_bindings/types';
import { ActorTag, Empty, Money, Result } from '../components/ui';
import { useConfig, useMe } from '../app/data';
import { openWhy, setSub, useNav } from '../app/nav';
import { day, daysBetween, money } from '../lib/format';
import { parseArr } from '../lib/json';
import { useAction } from '../stdb/actions';
import { useRows } from '../stdb/store';
import { InternalAudit, PeriodCloseView } from './Audit';

const TABS = [
  { key: 'books', label: 'Books and controls' },
  { key: 'receivables', label: 'Receivables' },
  { key: 'cash', label: 'Cash and debits' },
  { key: 'refunds', label: 'Refunds' },
  { key: 'audit', label: 'Internal audit' },
  { key: 'close', label: 'Close' },
];

export function Ledger() {
  const nav = useNav();
  const tab = TABS.some(t => t.key === nav.sub) ? nav.sub : 'books';
  return (
    <div className="page-inner">
      <div className="page-head">
        <h1 className="page-title">Ledger</h1>
        <p className="page-sub">Double entry, in cents. The kernel rolls back any change that breaks a control; this page re-adds the numbers itself.</p>
      </div>
      <div className="subtabs" role="tablist">
        {TABS.map(t => (
          <button key={t.key} className="subtab" role="tab" aria-selected={tab === t.key} onClick={() => setSub(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'books' && <Books />}
      {tab === 'receivables' && <Receivables />}
      {tab === 'cash' && <Cash />}
      {tab === 'refunds' && <Refunds />}
      {tab === 'audit' && <InternalAudit />}
      {tab === 'close' && <PeriodCloseView />}
    </div>
  );
}

function Books() {
  const gl = useRows('glBalance');
  const ctl = useRows('controlTotal');
  const invoices = useRows('invoice');
  const receipts = useRows('receipt');
  const bills = useRows('bill');
  const rows = useMemo(() => [...gl].sort((a, b) => a.account.localeCompare(b.account)), [gl]);
  const totals = useMemo(() => rows.reduce((t, r) => ({ d: t.d + r.debitCents, c: t.c + r.creditCents }), { d: 0n, c: 0n }), [rows]);
  const bal = (acct: string) => {
    const r = gl.find(x => x.account === acct);
    return r ? r.debitCents - r.creditCents : 0n;
  };
  const c = (k: string) => ctl.find(x => x.key === k)?.cents ?? 0n;
  const openBy = (kinds: string[]) => invoices.filter(i => kinds.includes(i.kind)).reduce((s, i) => s + i.openCents, 0n);
  const unappliedReceipts = receipts.reduce((s, r) => s + r.unappliedCents, 0n);
  const checks = [
    { label: 'Debits equal credits', left: totals.d, right: totals.c, src: 'every journal line, summed by account', ok: totals.d === totals.c, lname: 'debits', rname: 'credits' },
    { label: 'Royalty and trade receivables (1100)', left: bal('1100'), right: c('ar_royalty') + c('ar_trade') + c('ar_audit'), third: openBy(['royalty', 'trade', 'audit']), src: 'GL against the control total; open invoices re-added here', lname: 'GL', rname: 'control' },
    { label: 'Supply receivables (1110)', left: bal('1110'), right: c('ar_supply'), third: openBy(['supply']), src: 'GL against the control total; open invoices re-added here', lname: 'GL', rname: 'control' },
    { label: 'Fees and interest receivable (1120)', left: bal('1120'), right: c('ar_fee') + c('ar_interest'), third: openBy(['fee', 'interest']), src: 'GL against the control total; open invoices re-added here', lname: 'GL', rname: 'control' },
    { label: 'Unapplied cash (2100)', left: -bal('2100'), right: c('unapplied'), third: unappliedReceipts, src: 'GL against the control total; receipts not yet applied re-added here', lname: 'GL', rname: 'control' },
    { label: 'Cash (1000) against the bank statement', left: bal('1000'), right: c('bank'), src: 'GL against money the bank feed reported, kept apart from the journal', lname: 'GL', rname: 'bank' },
    ...(gl.some(g => g.account === '2000') || ctl.some(x => x.key === 'ap_open')
      ? [{ label: 'Accounts payable (2000)', left: -bal('2000'), right: c('ap_open'), third: bills.filter(b => b.status === 'approved' || b.status === 'scheduled').reduce((s, b) => s + b.openCents, 0n), src: 'GL against the control total; approved unpaid bills re-added here', lname: 'GL', rname: 'control' }]
      : []),
  ];
  return (
    <div className="split-even">
      <section className="sheet" aria-label="Trial balance">
        <div className="sheet-pad" style={{ paddingBottom: 8 }}>
          <div className="section-head">
            <h2 className="section-title">Trial balance</h2>
            <span className="aside">gl_balance</span>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Account</th>
              <th className="n">Debits</th>
              <th className="n">Credits</th>
              <th className="n">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.account}>
                <td>
                  <span className="num faint">{r.account}</span> {r.name}
                </td>
                <td className="n">{money(r.debitCents)}</td>
                <td className="n">{money(r.creditCents)}</td>
                <td className="n">{money(r.debitCents - r.creditCents)}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Total</td>
              <td className="n">{money(totals.d)}</td>
              <td className="n">{money(totals.c)}</td>
              <td className="n">{money(totals.d - totals.c)}</td>
            </tr>
          </tbody>
        </table>
        {!rows.length && <Empty title="Nothing posted yet" />}
      </section>
      <section className="sheet" aria-label="Controls">
        <div className="sheet-pad" style={{ paddingBottom: 8 }}>
          <div className="section-head">
            <h2 className="section-title">Controls</h2>
            <span className="aside">checked by the kernel after every command, and again here</span>
          </div>
        </div>
        <div className="checks">
          {checks.map(k => {
            const ok = k.ok ?? (k.left === k.right && (k.third === undefined || k.third === k.right));
            return (
              <div key={k.label} className={`check ${ok ? 'ok' : 'bad'}`}>
                {ok ? <Check size={15} /> : <X size={15} />}
                <span>{k.label}</span>
                <span className="sides muted">
                  {k.lname} {money(k.left)}
                </span>
                <span className="sides">
                  {k.rname} {money(k.right)}
                </span>
                <span className="src">
                  {k.src}
                  {k.third !== undefined && `: ${money(k.third)}`}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

const BUCKETS = ['current', '1–30', '31–60', '61–90', '90+'] as const;
const BUCKET_COLOR = ['var(--rule-strong)', 'var(--taro-line)', 'var(--taro)', 'var(--ink-2)', 'var(--ink)'];

function bucket(inv: Invoice, today: string): number {
  const late = daysBetween(inv.dueAt, today);
  if (late <= 0) return 0;
  if (late <= 30) return 1;
  if (late <= 60) return 2;
  if (late <= 90) return 3;
  return 4;
}

function Receivables() {
  const invoices = useRows('invoice');
  const entities = useRows('entity');
  const cfg = useConfig();
  const today = cfg?.simDate ?? '1970-01-01';
  const [openRow, setOpenRow] = useState('');
  const byEntity = useMemo(() => {
    const m = new Map<string, { e?: Entity; open: Invoice[]; all: number; buckets: bigint[]; total: bigint; disputed: number }>();
    for (const e of entities) m.set(e.code, { e, open: [], all: 0, buckets: [0n, 0n, 0n, 0n, 0n], total: 0n, disputed: 0 });
    for (const inv of invoices) {
      const x = m.get(inv.entityCode) ?? { open: [], all: 0, buckets: [0n, 0n, 0n, 0n, 0n], total: 0n, disputed: 0 };
      x.all++;
      if (inv.openCents > 0n) {
        x.open.push(inv);
        x.buckets[bucket(inv, today)] += inv.openCents;
        x.total += inv.openCents;
      }
      if (inv.status === 'disputed') x.disputed++;
      m.set(inv.entityCode, x);
    }
    return [...m.entries()].sort((a, b) => (b[1].total > a[1].total ? 1 : b[1].total < a[1].total ? -1 : a[0].localeCompare(b[0])));
  }, [invoices, entities, today]);
  const grand = byEntity.reduce((s, [, x]) => s + x.total, 0n);
  const grandBuckets = BUCKETS.map((_, i) => byEntity.reduce((s, [, x]) => s + x.buckets[i], 0n));
  return (
    <section className="sheet" aria-label="Receivables by customer">
      <div className="sheet-pad" style={{ paddingBottom: 8 }}>
        <div className="section-head">
          <h2 className="section-title">Open receivables by counterparty</h2>
          <span className="aside">aged by due date against the business date, {day(today, true)}</span>
        </div>
      </div>
      <div className="scroll-y" style={{ maxHeight: 'calc(100vh - 260px)' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Counterparty</th>
              <th className="n">Invoices</th>
              {BUCKETS.map(b => (
                <th key={b} className="n">
                  {b === 'current' ? 'Not yet due' : `${b} days`}
                </th>
              ))}
              <th className="n">Open</th>
              <th>Aging</th>
            </tr>
          </thead>
          <tbody>
            {byEntity.map(([code, x]) => (
              <Fragment key={code}>
                <tr className="clickable" onClick={() => setOpenRow(o => (o === code ? '' : code))}>
                  <td>
                    {openRow === code ? <ChevronDown size={13} /> : <ChevronRight size={13} />} <b style={{ fontWeight: 600 }}>{x.e?.name ?? code}</b> <span className="faint">{code}</span>
                    {x.e?.status === 'bankrupt' && <span className="chip" style={{ marginLeft: 6 }}>bankrupt</span>}
                    {x.disputed > 0 && <span className="chip" style={{ marginLeft: 6 }}>{x.disputed} disputed</span>}
                  </td>
                  <td className="n">
                    {x.open.length} of {x.all}
                  </td>
                  {x.buckets.map((b, i) => (
                    <td key={i} className="n">
                      {b ? money(b) : <span className="faint">—</span>}
                    </td>
                  ))}
                  <td className="n" style={{ fontWeight: 600 }}>
                    {money(x.total)}
                  </td>
                  <td>
                    <AgingBar buckets={x.buckets} total={x.total} />
                  </td>
                </tr>
                {openRow === code && (
                  <tr>
                    <td colSpan={9} style={{ background: 'var(--sheet-2)' }}>
                      <InvoiceList invoices={invoices.filter(i => i.entityCode === code)} today={today} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            <tr className="total">
              <td>All counterparties</td>
              <td className="n">{invoices.filter(i => i.openCents > 0n).length}</td>
              {grandBuckets.map((b, i) => (
                <td key={i} className="n">
                  {money(b)}
                </td>
              ))}
              <td className="n">{money(grand)}</td>
              <td>
                <AgingBar buckets={grandBuckets} total={grand} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AgingBar({ buckets, total }: { buckets: bigint[]; total: bigint }) {
  if (total <= 0n) return <span className="faint">—</span>;
  return (
    <span className="aging" aria-label="aging">
      {buckets.map((b, i) => (b > 0n ? <i key={i} style={{ width: `${Number((b * 1000n) / total) / 10}%`, background: BUCKET_COLOR[i] }} title={`${BUCKETS[i]}: ${money(b)}`} /> : null))}
    </span>
  );
}

function InvoiceList({ invoices, today }: { invoices: Invoice[]; today: string }) {
  const sorted = [...invoices].sort((a, b) => (a.dueAt < b.dueAt ? 1 : -1));
  return (
    <table className="table compact">
      <thead>
        <tr>
          <th>Invoice</th>
          <th>Kind</th>
          <th>Store</th>
          <th>Issued</th>
          <th>Due</th>
          <th className="n">Amount</th>
          <th className="n">Open</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(i => (
          <tr key={i.id}>
            <td>{i.id}</td>
            <td>{i.kind}</td>
            <td>{i.storeCode || '—'}</td>
            <td className="n">{day(i.issuedAt)}</td>
            <td className="n">
              {day(i.dueAt)}
              {i.openCents > 0n && daysBetween(i.dueAt, today) > 0 ? <span className="faint"> ({daysBetween(i.dueAt, today)}d)</span> : ''}
            </td>
            <td className="n">{money(i.amountCents)}</td>
            <td className="n">{money(i.openCents)}</td>
            <td>{i.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Cash() {
  const receipts = useRows('receipt');
  const debits = useRows('debitInstruction');
  const entities = useRows('entity');
  const name = (code: string) => entities.find(e => e.code === code)?.name ?? (code || 'unidentified');
  const sortedR = useMemo(() => [...receipts].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : b.id.localeCompare(a.id))), [receipts]);
  const sortedD = useMemo(() => [...debits].sort((a, b) => (a.scheduledFor < b.scheduledFor ? 1 : -1)), [debits]);
  const unapplied = receipts.filter(r => r.unappliedCents > 0n);
  const unappliedTotal = unapplied.reduce((s, r) => s + r.unappliedCents, 0n);
  return (
    <div className="stack">
      <section className="sheet" aria-label="Receipts">
        <div className="sheet-pad" style={{ paddingBottom: 8 }}>
          <div className="section-head">
            <h2 className="section-title">Receipts</h2>
            <span className="aside">
              {unapplied.length} with unapplied cash, <Money cents={unappliedTotal} /> in all
            </span>
          </div>
        </div>
        <div className="scroll-y">
          <table className="table">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Payer</th>
                <th>Counterparty</th>
                <th>Received</th>
                <th>Method</th>
                <th className="n">Amount</th>
                <th className="n">Unapplied</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedR.map(r => (
                <tr key={r.id}>
                  <td>
                    {r.id}
                    {r.reference && <div className="faint" style={{ fontSize: 12 }}>ref “{r.reference}”</div>}
                  </td>
                  <td>{r.payerName}</td>
                  <td>{name(r.entityCode)}</td>
                  <td className="n">{day(r.receivedAt)}</td>
                  <td>{r.method.replace(/_/g, ' ')}</td>
                  <td className="n">{money(r.amountCents)}</td>
                  <td className="n" style={{ fontWeight: r.unappliedCents > 0n ? 600 : 400 }}>
                    {money(r.unappliedCents)}
                  </td>
                  <td>{r.status.replace(/_/g, ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sortedR.length && <Empty title="No receipts yet" />}
        </div>
      </section>
      <section className="sheet" aria-label="Debit instructions">
        <div className="sheet-pad" style={{ paddingBottom: 8 }}>
          <div className="section-head">
            <h2 className="section-title">Debit instructions</h2>
            <span className="aside">Wednesday ACH pulls, only from accounts that came from a trusted source (C3)</span>
          </div>
        </div>
        <div className="scroll-y">
          <table className="table">
            <thead>
              <tr>
                <th>Debit</th>
                <th>Counterparty</th>
                <th>For</th>
                <th>Scheduled</th>
                <th>From account</th>
                <th className="n">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedD.map(d => (
                <tr key={d.id} className="clickable" onClick={() => openWhy(d.activityId)}>
                  <td>{d.id}</td>
                  <td>{name(d.entityCode)}</td>
                  <td style={{ fontSize: 12 }}>{parseArr<string>(d.invoiceIds).join(', ')}</td>
                  <td className="n">{day(d.scheduledFor)}</td>
                  <td>{d.bankAccount}</td>
                  <td className="n">{money(d.amountCents)}</td>
                  <td>{d.status === 'blocked' ? <span className="chip denied">blocked</span> : d.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sortedD.length && <Empty title="No debits scheduled yet" />}
        </div>
      </section>
    </div>
  );
}

function Refunds() {
  const refunds = useRows('refund');
  const entities = useRows('entity');
  const sorted = useMemo(() => [...refunds].sort((a, b) => (a.id < b.id ? 1 : -1)), [refunds]);
  return (
    <section className="sheet" aria-label="Refunds">
      <div className="sheet-pad" style={{ paddingBottom: 8 }}>
        <div className="section-head">
          <h2 className="section-title">Refunds</h2>
          <span className="aside">prepared by the refunds seat, released by someone else (C2); over $5,000 needs two people (C8)</span>
        </div>
      </div>
      {sorted.length === 0 ? (
        <Empty title="No refunds">The refunds seat prepares refunds of overpaid cash, always to the account on file.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Refund</th>
              <th>Counterparty</th>
              <th>To account</th>
              <th className="n">Amount</th>
              <th>Prepared by</th>
              <th>Approvals</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <RefundRow key={r.id.toString()} r={r} name={entities.find(e => e.code === r.entityCode)?.name ?? r.entityCode} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RefundRow({ r, name }: { r: Refund; name: string }) {
  const act = useAction();
  const me = useMe();
  const activity = useRows('activity');
  const approvals = parseArr<string>(r.approvals);
  const stopped = useMemo(() => activity.filter(a => (a.outcome === 'denied' || a.outcome === 'rejected') && parseArr<string>(a.used).includes(`refund:${r.id.toString()}`)), [activity, r.id]);
  return (
    <>
      <tr>
        <td>
          <button className="btn small quiet" onClick={() => openWhy(r.activityId)}>
            #{r.id.toString()}
          </button>
          <span className="faint num" style={{ fontSize: 12 }}>
            {day(r.createdAt)}
          </span>
        </td>
        <td>{name}</td>
        <td>{r.bankAccount}</td>
        <td className="n">{money(r.amountCents)}</td>
        <td>
          <ActorTag principal={r.requestedBy} />
        </td>
        <td>{approvals.length ? approvals.map(a => a.split(':')[1] ?? a).join(', ') : <span className="faint">none</span>}</td>
        <td>
          <span className={`chip ${r.status === 'cancelled' ? 'cancelled' : r.status === 'prepared' ? 'asked' : ''}`}>{r.status}</span>
        </td>
        <td className="n">
          {r.status === 'prepared' && (
            <button className="btn small primary" disabled={act.pending} onClick={() => void act.run({ call: c => c.reducers.releaseRefund({ refundId: r.id }) })} title={`Release as ${me.name}`}>
              Release as {me.name}
            </button>
          )}
        </td>
      </tr>
      {stopped.length > 0 && (
        <tr>
          <td colSpan={8} style={{ paddingTop: 0 }}>
            {stopped.map(s => (
              <div key={s.id.toString()} className="row red" style={{ gap: 6, fontSize: 12 }}>
                <button className="btn small quiet" style={{ height: 20, padding: '0 5px', color: 'inherit' }} onClick={() => openWhy(s.id)}>
                  #{s.id.toString()}
                </button>
                <ActorTag principal={s.principal} /> {day(s.at)}: {parseArr<string>(s.reasons).join('; ')}
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
