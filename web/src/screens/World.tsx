// The outside world, made up on the spot: a payment lands in the bank feed or a
// bill in the AP inbox. The dev server's world feeder delivers it through the same
// door as every event the simulation delivers (ingest_obs), so the seats treat it
// like any other; then this page follows it to what the seat decided, with which
// skill, or whom it asked. The public page has no feeder and no World screen.
import { Check, Clock, FileText, Landmark, Loader2, Send, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Activity, Ask, Decision, Entity, Invoice } from '../module_bindings/types';
import { Empty } from '../components/ui';
import { useConfig } from '../app/data';
import { go, openWhy, setSub, useNav } from '../app/nav';
import { currencySymbol, day, money } from '../lib/format';
import { parseLoose, parseObj } from '../lib/json';
import { actionsOf } from '../lib/lineage';
import { outcomeText } from '../lib/rules';
import { charterApi } from '../stdb/api';
import { charter } from '../stdb/client';
import { useRows } from '../stdb/store';

type Kind = 'payment' | 'bill';

const toCents = (s: string) => Math.round(Number(s.replace(/[^0-9.]/g, '')) * 100) || 0;
const fromCents = (c: number) => (c / 100).toFixed(2);
const newAccount = () => `****${String(Math.floor(1000 + Math.random() * 9000))}`;
const isOpen = (i: Invoice) => i.openCents > 0n && (i.status === 'open' || i.status === 'disputed');

async function deliver(event: Record<string, unknown>): Promise<{ id: string; existed: boolean }> {
  const res = await fetch(charterApi('world', charter.info.db), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  const body = (await res.json()) as { id?: string; existed?: boolean; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `the dev server answered ${res.status}`);
  return { id: body.id, existed: !!body.existed };
}

export function World() {
  const nav = useNav();
  const entities = useRows('entity');
  const [kindSub, idSub = ''] = nav.sub.split('/');
  const hasVendors = entities.some(e => e.kind === 'vendor');
  const kind: Kind = kindSub === 'bill' && hasVendors ? 'bill' : 'payment';
  // The item being followed lives in the URL, so a refresh mid-demo keeps it.
  const follow = (k: Kind, id: string) => setSub(`${k}/${id}`);
  return (
    <div className="page-inner">
      <div className="page-head">
        <h1 className="page-title">World</h1>
        <p className="page-sub">Make something arrive from outside. It comes in through the same door as everything the simulation delivers, and the seats pick it up within five seconds.</p>
      </div>
      <div className="split-even">
        <section className="sheet sheet-pad" aria-label="Something arrives">
          <div className="section-head">
            <h2 className="section-title">Something arrives</h2>
            {hasVendors && (
              <div className="subtabs" role="tablist" style={{ marginLeft: 'auto' }}>
                <button className="subtab" role="tab" aria-selected={kind === 'payment'} onClick={() => setSub('payment')}>
                  <Landmark size={13} /> A payment
                </button>
                <button className="subtab" role="tab" aria-selected={kind === 'bill'} onClick={() => setSub('bill')}>
                  <FileText size={13} /> A bill
                </button>
              </div>
            )}
          </div>
          {kind === 'payment' ? <PaymentForm onSent={id => follow('payment', id)} /> : <BillForm onSent={id => follow('bill', id)} />}
        </section>
        <section className="sheet sheet-pad" aria-label="What happened to it">
          <div className="section-head">
            <h2 className="section-title">What happened to it</h2>
          </div>
          {idSub ? <Follow kind={kind} id={idSub} /> : <Empty title="Nothing sent yet">Send one and follow it here, step by step, as the seats work.</Empty>}
        </section>
      </div>
    </div>
  );
}

function Chips({ chips }: { chips: { label: string; hint: string; apply: () => void }[] }) {
  return (
    <div className="attack-presets">
      {chips.map(c => (
        <button key={c.label} type="button" className="btn small option" title={c.hint} onClick={c.apply}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

function Sent({ state }: { state: { pending: boolean; error: string; note: string } }) {
  if (state.pending)
    return (
      <div className="result" role="status">
        <Loader2 size={14} className="spin" aria-hidden /> Delivering…
      </div>
    );
  if (state.error)
    return (
      <div className="result error" role="alert">
        {state.error}
      </div>
    );
  return state.note ? (
    <div className="result" role="status">
      <Check size={14} aria-hidden /> {state.note}
    </div>
  ) : null;
}

function PaymentForm({ onSent }: { onSent: (id: string) => void }) {
  const cfg = useConfig();
  const entities = useRows('entity');
  const invoices = useRows('invoice');
  const receipts = useRows('receipt');
  const sym = currencySymbol(cfg?.currency);
  // Whoever owes something, most open invoices first: a payment is usually for invoices.
  const payers = useMemo(() => {
    const open = new Map<string, number>();
    for (const i of invoices) if (isOpen(i)) open.set(i.entityCode, (open.get(i.entityCode) ?? 0) + 1);
    const all = entities.filter(e => e.kind !== 'vendor').map(e => ({ e, open: open.get(e.code) ?? 0 }));
    const owing = all.filter(p => p.open > 0);
    return (owing.length ? owing : all).sort((a, b) => b.open - a.open || a.e.name.localeCompare(b.e.name));
  }, [entities, invoices]);
  // How this company's customers usually pay.
  const type = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of receipts) if (['wire_in', 'ach_credit_in', 'check_deposit'].includes(r.method)) n.set(r.method, (n.get(r.method) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'wire_in';
  }, [receipts]);
  const [payer, setPayer] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [account, setAccount] = useState('');
  const [name, setName] = useState('');
  const [state, setState] = useState({ pending: false, error: '', note: '' });
  const openOf = (code: string) => invoices.filter(i => i.entityCode === code && isOpen(i)).sort((a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id));
  const open = useMemo(() => openOf(payer), [invoices, payer]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (ids: string[], list: Invoice[]) => {
    setPicked(ids);
    setAmount(fromCents(list.filter(i => ids.includes(i.id)).reduce((s, i) => s + Number(i.openCents), 0)));
    setReference(ids.join(' '));
  };
  // A payer starts from the ordinary case: the oldest open invoice, paid in full and named.
  const choose = (code: string) => {
    const e = entities.find(x => x.code === code);
    const list = openOf(code);
    setPayer(code);
    pick(list.slice(0, 1).map(i => i.id), list);
    setAccount(e?.bankAccount || newAccount());
    setName((e?.name ?? 'A N Other Ltd').toUpperCase());
    setState({ pending: false, error: '', note: '' });
  };
  useEffect(() => {
    if (!payer && payers[0]) choose(payers[0].e.code);
  }, [payers]); // eslint-disable-line react-hooks/exhaustive-deps
  const entity: Entity | undefined = entities.find(e => e.code === payer);
  const chips = [
    { label: `Less a ${sym}12 bank charge`, hint: 'a payment from abroad arrives short by the bank’s fee', apply: () => setAmount(a => fromCents(Math.max(1, toCents(a) - 1200))) },
    { label: 'No reference', hint: 'the payer wrote nothing on it', apply: () => setReference('') },
    { label: 'Half, on account', hint: 'half now, the rest later, no invoice named', apply: () => (setAmount(a => fromCents(Math.round(toCents(a) / 2))), setReference('ON ACCOUNT')) },
    { label: 'From a new account', hint: 'the money comes from an account we have never seen', apply: () => setAccount(newAccount()) },
  ];
  return (
    <form
      style={{ display: 'grid', gap: 10 }}
      onSubmit={e => {
        e.preventDefault();
        setState({ pending: true, error: '', note: '' });
        deliver({ kind: 'payment', amountCents: toCents(amount), type, counterpartyName: name, counterpartyAccount: account, reference })
          .then(r => {
            setState({ pending: false, error: '', note: `In the bank feed as ${r.id}` });
            onSent(r.id);
          })
          .catch(err => setState({ pending: false, error: err instanceof Error ? err.message : String(err), note: '' }));
      }}
    >
      <label className="field">
        <span>Who pays</span>
        <select className="select" value={payer} onChange={e => choose(e.target.value)}>
          {payers.map(({ e, open: n }) => (
            <option key={e.code} value={e.code}>
              {e.name} ({e.code}){n ? `, ${n} open` : ''}
            </option>
          ))}
        </select>
      </label>
      {open.length > 0 && (
        <div className="field">
          <span>What they owe: tick what this payment is for</span>
          <div className="pick-list">
            {open.slice(0, 8).map(i => (
              <label key={i.id} className="pick">
                <input type="checkbox" checked={picked.includes(i.id)} onChange={() => pick(picked.includes(i.id) ? picked.filter(x => x !== i.id) : [...picked, i.id], open)} />
                <span className="num">{i.id}</span>
                <span className="faint">{day(i.issuedAt)}</span>
                <span className="num" style={{ marginLeft: 'auto' }}>
                  {money(i.openCents)}
                </span>
              </label>
            ))}
            {open.length > 8 && <span className="faint" style={{ fontSize: 12 }}>and {open.length - 8} more</span>}
          </div>
        </div>
      )}
      <Chips chips={chips} />
      <div className="split-even" style={{ gap: 9 }}>
        <label className="field">
          <span>Amount ({sym})</span>
          <input className="input num" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
        </label>
        <label className="field">
          <span>Reference on the payment</span>
          <input className="input" value={reference} placeholder="nothing" onChange={e => setReference(e.target.value)} />
        </label>
      </div>
      <div className="split-even" style={{ gap: 9 }}>
        <label className="field">
          <span>From account</span>
          <input className="input num" value={account} onChange={e => setAccount(e.target.value)} />
        </label>
        <label className="field">
          <span>Name the bank shows</span>
          <input className="input" value={name} onChange={e => setName(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="btn primary" type="submit" disabled={state.pending || toCents(amount) <= 0}>
          <Send size={14} /> Send to the bank feed
        </button>
        <span className="faint" style={{ fontSize: 12 }}>
          {entity && account !== entity.bankAccount ? `not ${entity.name}’s account on file (${entity.bankAccount})` : `${type.replace(/_/g, ' ')} on ${day(cfg?.simDate)}`}
        </span>
      </div>
      <Sent state={state} />
    </form>
  );
}

interface Po {
  poNo: string;
  vendorCode: string;
  date: string;
  totalCents: number;
}

// The bill number after this one: INV-77001 becomes INV-77002.
const nextNumber = (n: string) => n.replace(/(\d+)(?!.*\d)/, d => String(Number(d) + 1).padStart(d.length, '0')) || `${n}-2`;

function BillForm({ onSent }: { onSent: (id: string) => void }) {
  const cfg = useConfig();
  const entities = useRows('entity');
  const bills = useRows('bill');
  const facts = useRows('fact');
  const sym = currencySymbol(cfg?.currency);
  const vendors = useMemo(() => entities.filter(e => e.kind === 'vendor').sort((a, b) => a.code.localeCompare(b.code)), [entities]);
  const allPos = useMemo(() => facts.filter(f => f.attr === 'po').map(f => parseLoose<Po>(f.value, { poNo: '', vendorCode: '', date: '', totalCents: 0 })), [facts]);
  const [vendor, setVendor] = useState('');
  const [billNo, setBillNo] = useState('');
  const [amount, setAmount] = useState('');
  const [poNo, setPoNo] = useState('');
  const [due, setDue] = useState('');
  const [state, setState] = useState({ pending: false, error: '', note: '' });
  const theirs = useMemo(() => bills.filter(b => b.vendorCode === vendor).sort((a, b) => b.billDate.localeCompare(a.billDate) || b.billNo.localeCompare(a.billNo)), [bills, vendor]);
  const pos = useMemo(() => allPos.filter(p => p.vendorCode === vendor).sort((a, b) => b.date.localeCompare(a.date)), [allPos, vendor]);
  const plusDays = (iso: string | undefined, n: number) => {
    const d = new Date(`${iso ?? '2026-01-01'}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // A vendor starts from the ordinary case: a bill for their newest order nobody has billed yet.
  const choose = (code: string) => {
    const mine = bills.filter(b => b.vendorCode === code).sort((a, b) => b.billDate.localeCompare(a.billDate));
    const billed = new Set(mine.map(b => b.poNo));
    const po = allPos.filter(p => p.vendorCode === code && !billed.has(p.poNo)).sort((a, b) => b.date.localeCompare(a.date))[0];
    setVendor(code);
    setBillNo(mine[0] ? nextNumber(mine[0].billNo) : `INV-${String(Math.floor(10000 + Math.random() * 90000))}`);
    setAmount(po ? fromCents(po.totalCents) : '');
    setPoNo(po?.poNo ?? '');
    setDue(plusDays(cfg?.simDate, 30));
    setState({ pending: false, error: '', note: '' });
  };
  useEffect(() => {
    if (!vendor && vendors[0]) choose(vendors[0].code);
  }, [vendors]); // eslint-disable-line react-hooks/exhaustive-deps
  const last = theirs[0];
  const po = pos.find(p => p.poNo === poNo);
  const chips = [
    ...(last ? [{ label: 'Their last bill again, renumbered', hint: `${last.billNo} for ${money(last.amountCents)} once more, under a new number`, apply: () => (setBillNo(nextNumber(theirs.map(b => b.billNo).sort().pop() ?? last.billNo)), setAmount(fromCents(Number(last.amountCents))), setPoNo(last.poNo)) }] : []),
    { label: 'No purchase order', hint: 'nobody here ordered this', apply: () => setPoNo('') },
    ...(po ? [{ label: '10% over the order', hint: `the order was for ${money(po.totalCents)}`, apply: () => setAmount(fromCents(Math.round(po.totalCents * 1.1))) }] : []),
  ];
  return (
    <form
      style={{ display: 'grid', gap: 10 }}
      onSubmit={e => {
        e.preventDefault();
        setState({ pending: true, error: '', note: '' });
        deliver({ kind: 'bill', vendorCode: vendor, billNo, amountCents: toCents(amount), poNo, dueDate: due })
          .then(r => {
            setState({ pending: false, error: '', note: r.existed ? `The AP inbox already had ${r.id}: the same vendor and number are one document` : `In the AP inbox as ${r.id}` });
            onSent(r.id);
          })
          .catch(err => setState({ pending: false, error: err instanceof Error ? err.message : String(err), note: '' }));
      }}
    >
      <label className="field">
        <span>From vendor</span>
        <select className="select" value={vendor} onChange={e => choose(e.target.value)}>
          {vendors.map(v => (
            <option key={v.code} value={v.code}>
              {v.name} ({v.code})
            </option>
          ))}
        </select>
      </label>
      {theirs.length > 0 && (
        <div className="field">
          <span>Their recent bills</span>
          <div className="pick-list">
            {theirs.slice(0, 4).map(b => (
              <div key={b.id} className="pick">
                <span className="num">{b.billNo}</span>
                <span className="faint">
                  {day(b.billDate)}, {b.poNo || 'no order'}, {b.status}
                </span>
                <span className="num" style={{ marginLeft: 'auto' }}>
                  {money(b.amountCents)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <Chips chips={chips} />
      <div className="split-even" style={{ gap: 9 }}>
        <label className="field">
          <span>Their bill number</span>
          <input className="input num" value={billNo} onChange={e => setBillNo(e.target.value)} />
        </label>
        <label className="field">
          <span>Amount ({sym})</span>
          <input className="input num" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
        </label>
      </div>
      <div className="split-even" style={{ gap: 9 }}>
        <label className="field">
          <span>For order</span>
          <select className="select" value={poNo} onChange={e => setPoNo(e.target.value)}>
            <option value="">none</option>
            {pos.slice(0, 12).map(p => (
              <option key={p.poNo} value={p.poNo}>
                {p.poNo}, {money(p.totalCents)}
              </option>
            ))}
            {poNo && !pos.some(p => p.poNo === poNo) && <option value={poNo}>{poNo}</option>}
          </select>
        </label>
        <label className="field">
          <span>Due</span>
          <input className="input num" value={due} onChange={e => setDue(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="btn primary" type="submit" disabled={state.pending || !vendor || !billNo || toCents(amount) <= 0}>
          <Send size={14} /> Send to the AP inbox
        </button>
      </div>
      <Sent state={state} />
    </form>
  );
}

interface Step {
  key: string;
  state: 'done' | 'wait' | 'stop';
  title: ReactNode;
  detail?: ReactNode;
  activity?: Activity;
}

function Follow({ kind, id }: { kind: Kind; id: string }) {
  const activity = useRows('activity');
  const decisions = useRows('decision');
  const asks = useRows('ask');
  const applications = useRows('application');
  const receipts = useRows('receipt');
  const bills = useRows('bill');
  const entities = useRows('entity');
  const subject = kind === 'payment' ? `receipt:${id}` : `bill:${id}`;
  const ds = decisions.filter(d => d.subject === subject && !d.shadow).sort((a, b) => (a.id < b.id ? -1 : 1));
  const qs = asks.filter(a => a.subject === subject).sort((a, b) => (a.id < b.id ? -1 : 1));
  const steps: Step[] = [];
  const decided = (d: Decision, seat: string): Step => {
    const lands = parseLoose<Record<string, string>>(d.treatments, {})[d.outcome];
    return {
      key: `d${d.id}`,
      state: 'done',
      title: (
        <>
          {seat}: {outcomeText(d.outcome)}
          {lands && lands !== 'ask' ? <span className="num"> → {lands}</span> : null}
        </>
      ),
      detail: (
        <>
          with <b>{d.skillKey}</b>, {d.ruleIndex >= 0 ? `rule ${d.ruleIndex + 1}` : 'its default'}
          {d.note ? `: “${d.note}”` : ''}
        </>
      ),
      activity: actionsOf(d, activity)[0] ?? undefined,
    };
  };
  const asked = (a: Ask): Step => ({
    key: `q${a.id}`,
    state: a.status === 'open' ? 'wait' : 'done',
    title: a.status === 'open' ? `Asked the ${a.toRole}` : `The ${a.toRole} answered: ${a.answer}`,
    detail: (
      <div style={{ display: 'grid', gap: 6 }}>
        <span>{a.question}</span>
        {a.status === 'open' ? (
          <div className="row">
            <button className="btn small" onClick={() => go('inbox')}>
              Answer it in the Inbox
            </button>
          </div>
        ) : (
          a.reason && <span className="quote">“{a.reason}” {a.answeredBy.split(':')[1] ?? a.answeredBy}</span>
        )}
      </div>
    ),
    activity: activity.find(x => x.kind === 'ask' && parseObj(x.params).ask === Number(a.id)),
  });
  if (kind === 'payment') {
    const r = receipts.find(x => x.id === id);
    const payer = r && entities.find(e => e.code === r.entityCode);
    const booked = activity.find(a => a.command === 'apply_receipt' && parseObj(a.params).txnId === id);
    steps.push(
      r
        ? {
            key: 'in',
            state: 'done',
            title: `${money(r.amountCents)} arrived from ${r.payerName}`,
            detail: `reference “${r.reference || 'none'}”; ${payer ? `recognised as ${payer.name}` : 'payer not recognised'}; booked as unapplied cash`,
            activity: booked,
          }
        : { key: 'in', state: 'wait', title: 'In the bank feed', detail: 'not booked yet' }
    );
    for (const d of ds) steps.push(decided(d, 'Cash application'));
    for (const a of qs) steps.push(asked(a));
    const applied = applications.filter(x => x.receiptId === id && !x.reversed);
    if (applied.length)
      steps.push({
        key: 'applied',
        state: 'done',
        title: `Applied to ${applied.map(x => x.invoiceId).join(' + ')}`,
        detail: applied.map(x => `${x.invoiceId} ${money(x.amountCents)}`).join('; ') + (r && r.unappliedCents > 0n ? `; ${money(r.unappliedCents)} still unapplied` : ''),
      });
  } else {
    const b = bills.find(x => x.id === id);
    steps.push(
      b
        ? { key: 'in', state: 'done', title: `Bill ${b.billNo} for ${money(b.amountCents)} received`, detail: `${entities.find(e => e.code === b.vendorCode)?.name ?? b.vendorCode}, ${b.poNo ? `for order ${b.poNo}` : 'no order named'}, due ${day(b.dueAt)}` }
        : { key: 'in', state: 'wait', title: 'In the AP inbox', detail: 'not recorded yet' }
    );
    for (const d of ds) steps.push(decided(d, 'Payables clerk'));
    for (const a of qs) steps.push(asked(a));
    if (b && (b.status === 'rejected' || b.status === 'held')) steps.push({ key: 'st', state: 'stop', title: b.status === 'rejected' ? 'Rejected' : 'Held: nothing will be paid on it', detail: b.note || undefined });
    if (b && b.status === 'approved') steps.push({ key: 'st', state: 'done', title: 'Approved for the next payment run', detail: 'paying it still needs a person to release the run' });
  }
  if (!ds.length && !qs.length) steps.push({ key: 'wait', state: 'wait', title: kind === 'payment' ? 'Waiting for Cash application' : 'Waiting for the Payables clerk', detail: 'the seats look every five seconds' });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <ol className="track">
        {steps.map(s => (
          <li key={s.key} className={s.state}>
            <span className="mark">{s.state === 'stop' ? <ShieldAlert size={12} /> : s.state === 'wait' ? <Clock size={12} /> : <Check size={12} />}</span>
            <div>
              <div className="track-title">
                {s.title}
                {s.activity && (
                  <button className="btn small quiet" style={{ marginLeft: 6, height: 22 }} onClick={() => openWhy(s.activity!.id)}>
                    Why #{s.activity.id.toString()}
                  </button>
                )}
              </div>
              {s.detail && <div className="track-detail">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
      <span className="faint" style={{ fontSize: 12 }}>
        {id}, live from {charter.info.db}; new rows appear as the seats work.
      </span>
    </div>
  );
}
