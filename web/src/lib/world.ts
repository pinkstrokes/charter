// A payment or a bill made up on the World screen, turned into the observation the world feeder
// delivers through ingest_obs, exactly as the simulation delivers its events; nothing about it tells
// a seat it was made up except the LIVE- prefix the bank gives it. Shared by the dev middleware
// (plugins/charter-core.ts) and the sandbox build, which delivers from the browser.

// Amounts in cents.
export interface WorldEvent {
  kind: 'payment' | 'bill';
  amountCents: number;
  type?: string;
  counterpartyName?: string;
  counterpartyAccount?: string;
  reference?: string;
  vendorCode?: string;
  billNo?: string;
  poNo?: string;
  dueDate?: string;
}

export interface WorldDelivery {
  id: string;
  kind: string;
  source: string;
  refKey: string;
  subject: string;
  payload: Record<string, unknown>;
}

// `date` is the database's business date. Throws with a message for the person filling the form.
export function worldDelivery(body: WorldEvent, date: string): WorldDelivery {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('the company has no business date yet');
  const cents = Number(body.amountCents);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 10_000_000_000) throw new Error('the amount must be positive');
  const text = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  if (body.kind === 'payment') {
    const type = ['wire_in', 'ach_credit_in', 'check_deposit'].includes(String(body.type)) ? String(body.type) : 'wire_in';
    const account = text(body.counterpartyAccount, 8);
    if (!/^\*{4}\d{4}$/.test(account)) throw new Error('the paying account is written ****1234');
    const name = text(body.counterpartyName, 80);
    if (!name) throw new Error('who is paying?');
    const id = `LIVE-${date.slice(2).replace(/-/g, '')}-${String(Math.floor(1000 + Math.random() * 9000))}`;
    return {
      id,
      kind: 'bank_txn',
      source: 'bank',
      refKey: `bank:${id}`,
      subject: `account:${account}`,
      payload: { txnId: id, date, type, amountCents: cents, counterpartyName: name, counterpartyAccount: account, reference: text(body.reference, 140) },
    };
  }
  if (body.kind === 'bill') {
    const vendorCode = text(body.vendorCode, 20);
    const billNo = text(body.billNo, 40);
    const dueDate = text(body.dueDate, 10);
    if (!vendorCode || !billNo) throw new Error('a bill needs a vendor and the vendor’s bill number');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error('the due date is written YYYY-MM-DD');
    const id = `${vendorCode}:${billNo}`;
    return {
      id,
      kind: 'vendor_invoice',
      source: 'erp',
      refKey: `bill:${id}`,
      subject: `vendor:${vendorCode}`,
      payload: { billNo, vendorCode, poNo: text(body.poNo, 40), date, dueDate, amountCents: cents },
    };
  }
  throw new Error('a made-up event is a payment or a bill');
}
