// Payables pack. Vendor bills are matched against purchase orders and goods
// receipts by the payables clerk; approved bills are paid in Friday runs that
// the payments seat prepares and a person releases, only to verified accounts.
// Nothing here is special to the kernel: the same policies, skills, spot
// checks, audit and close apply to this desk as to receivables.
import type { FeatureMap } from '../core/dsl';
import { addDays, daysBetween } from '../core/money';
import type { Principal } from '../core/policy';
import { bumpControl, exec, factsFor, post, Rejection, simDate, type ExecResult, type Tx } from '../kernel';
import type { ProcCtx } from '../llm';
import { recordCheck } from '../reliability';
import { closeWork, decide, money, openAsk, useCurrency } from '../seats';
import { addFact, INGESTORS, openWork } from '../world';

export const AP_CLERK: Principal = { kind: 'seat', id: 'seat:ap_clerk', role: 'ap_clerk' };
export const PAYMENTS: Principal = { kind: 'seat', id: 'seat:payments', role: 'payments' };

interface PoPayload {
  poNo: string;
  vendorCode: string;
  date: string;
  totalCents: number;
  lines: { sku: string; qty: number; unitCents: number }[];
  buyer: string;
}
interface ReceiptPayload {
  receiptNo: string;
  poNo: string;
  vendorCode: string;
  date: string;
  receivedCents: number;
}
interface BillPayload {
  billNo: string;
  vendorCode: string;
  poNo: string;
  date: string;
  dueDate: string;
  amountCents: number;
}

INGESTORS.purchase_order = (tx, obsId, p: PoPayload) => {
  addFact(tx, `po:${p.poNo}`, 'po', p, p.date, obsId, true);
};
INGESTORS.goods_receipt = (tx, obsId, p: ReceiptPayload) => {
  addFact(tx, `po:${p.poNo}`, 'receipt', p, p.date, obsId, true);
};
INGESTORS.vendor_invoice = (tx, obsId, p: BillPayload) => {
  const id = `${p.vendorCode}:${p.billNo}`;
  if (tx.db.bill.id.find(id)) return;
  tx.db.bill.insert({ id, vendorCode: p.vendorCode, billNo: p.billNo, poNo: p.poNo ?? '', billDate: p.date, dueAt: p.dueDate, amountCents: BigInt(p.amountCents), openCents: BigInt(p.amountCents), status: 'received', note: '', sourceObs: obsId });
  openWork(tx, 'ap_clerk', 'match_bill', `bill:${id}`, { billId: id }, 'erp');
};

const digits = (s: string) => s.replace(/\D/g, '').replace(/^0+/, '');

export function billFeatures(tx: Tx, billId: string): FeatureMap {
  const b = tx.db.bill.id.find(billId)!;
  const facts = [...tx.db.fact.subject.filter(`po:${b.poNo}`)];
  const po = facts.filter(f => f.attr === 'po').map(f => JSON.parse(f.value) as PoPayload).pop();
  const received = facts.filter(f => f.attr === 'receipt').reduce((s, f) => s + (JSON.parse(f.value) as ReceiptPayload).receivedCents, 0);
  const amount = Number(b.amountCents);
  let duplicate = 0;
  for (const o of tx.db.bill.vendorCode.filter(b.vendorCode)) {
    if (o.id === b.id || o.status === 'rejected') continue;
    const sameAmount = Math.abs(Number(o.amountCents) - amount) <= Math.max(100, amount * 0.005);
    const sameNumber = digits(o.billNo) !== '' && digits(o.billNo) === digits(b.billNo);
    const near = Math.abs(daysBetween(o.billDate, b.billDate)) <= 10;
    duplicate = Math.max(duplicate, sameAmount && sameNumber ? 1 : sameAmount && near ? 0.8 : sameNumber ? 0.6 : sameAmount ? 0.3 : 0);
  }
  return {
    po_found: !!po,
    receipt_found: received > 0,
    amount_vs_po: po && po.totalCents > 0 ? amount / po.totalCents : 0,
    amount_vs_received: received > 0 ? amount / received : 0,
    duplicate_score: duplicate,
    vendor_bank_change_pending: factsFor(tx, b.vendorCode).routing_changed_unverified,
    days_to_due: daysBetween(simDate(tx), b.dueAt),
    amount,
  };
}

export function approveBill(tx: Tx, who: Principal, billId: string, plan: string[], extraUsed: string[] = []): ExecResult {
  const b = tx.db.bill.id.find(billId);
  if (!b) throw new Rejection(`no bill ${billId}`);
  const amount = Number(b.amountCents);
  return exec(tx, { principal: who, action: 'approve_bill', params: { bill: billId, amount }, used: [`bill:${billId}`, `po:${b.poNo}`, ...extraUsed], plan, amountCents: amount, facts: factsFor(tx, b.vendorCode) }, activityId => {
    if (b.status !== 'received' && b.status !== 'held') throw new Rejection(`bill ${billId} is ${b.status}`);
    tx.db.bill.id.update({ ...b, status: 'approved' });
    post(tx, `JE-AP-${billId}`, [
      { account: '1300', debit: amount, entity: b.vendorCode, memo: `bill ${b.billNo}` },
      { account: '2000', credit: amount, entity: b.vendorCode, memo: `bill ${b.billNo} payable` },
    ], activityId);
    bumpControl(tx, 'ap_open', amount);
    return `bill ${b.billNo} from ${b.vendorCode} approved for ${money(amount)}`;
  });
}

function matchBill(tx: Tx, workId: bigint, billId: string): void {
  const b = tx.db.bill.id.find(billId);
  if (!b || b.status !== 'received') {
    closeWork(tx, workId);
    return;
  }
  const features = billFeatures(tx, billId);
  const d = decide(tx, AP_CLERK.id, 'bill_match', `bill:${billId}`, features);
  if (d.decide === 'approve') {
    approveBill(tx, AP_CLERK, billId, [d.key], [`decision:${d.id}`]);
  } else if (d.decide === 'reject') {
    tx.db.bill.id.update({ ...b, status: 'rejected', note: d.note });
  } else {
    tx.db.bill.id.update({ ...b, status: 'held', note: d.note });
    openAsk(tx, {
      kind: 'bill_exception',
      subject: `bill:${billId}`,
      toRole: 'controller',
      question: `Bill ${b.billNo} from ${tx.db.entity.code.find(b.vendorCode)?.name ?? b.vendorCode} for ${money(Number(b.amountCents))}: ${d.note || 'it does not match its order and receipts'}. Approve, reject or keep holding?`,
      options: ['approve', 'reject', 'hold'],
      evidence: { features, skill: d.key, decision: Number(d.id) },
      confidence: 0.4,
      workItemId: workId,
      by: AP_CLERK.id,
    });
  }
  closeWork(tx, workId, 'done', { decision: d.decide, skill: d.key });
}

export function apClerkCycle(ctx: ProcCtx): string {
  return ctx.withTx(tx => {
    useCurrency(tx);
    let n = 0;
    for (const w of [...tx.db.workItem.seat.filter('ap_clerk')]) {
      if (w.state !== 'open' || w.kind !== 'match_bill') continue;
      matchBill(tx, w.id, JSON.parse(w.payload).billId);
      n++;
    }
    return `bills ${n}`;
  });
}

// Friday runs: every vendor with approved bills due within a week.
export function paymentsCycle(ctx: ProcCtx): string {
  return ctx.withTx(tx => {
    useCurrency(tx);
    const today = simDate(tx);
    if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 5) return 'not a payment day';
    let prepared = 0;
    for (const v of [...tx.db.entity.iter()]) {
      if (v.kind !== 'vendor') continue;
      const due = [...tx.db.bill.vendorCode.filter(v.code)].filter(b => b.status === 'approved' && b.openCents > 0n && b.dueAt <= addDays(today, 7));
      if (!due.length) continue;
      const id = `PAY-${today}-${v.code}`;
      if (tx.db.payment.id.find(id)) continue;
      const amount = due.reduce((s, b) => s + Number(b.openCents), 0);
      const facts = factsFor(tx, v.code);
      const res = exec(
        tx,
        {
          principal: PAYMENTS,
          action: 'prepare_payment',
          params: { payment: id, vendor: v.code, amount, bills: due.map(b => b.id), account: v.bankAccount },
          used: due.map(b => `bill:${b.id}`),
          amountCents: amount,
          facts,
          claims: [{ label: 'payment equals what the ledger shows open on these bills', lhs: amount, rhs: [], bills: due.map(b => b.id), tolerance: 0 }],
        },
        activityId => {
          tx.db.payment.insert({ id, vendorCode: v.code, billIds: JSON.stringify(due.map(b => b.id)), amountCents: BigInt(amount), bankAccount: v.bankAccount, status: 'prepared', preparedBy: PAYMENTS.id, approvals: '[]', preparedAt: today, activityId });
          for (const b of due) tx.db.bill.id.update({ ...b, status: 'scheduled' });
          openAsk(tx, {
            kind: 'payment_release',
            subject: `payment:${id}`,
            toRole: 'controller',
            question: `Release ${money(amount)} to ${v.name} at ${v.bankAccount} for ${due.length} bill${due.length > 1 ? 's' : ''}?${facts.routing_changed_unverified ? ' A change of this vendor’s bank account is waiting for a callback.' : ''}`,
            options: ['release', 'cancel'],
            evidence: { payment: id, bills: due.map(b => ({ id: b.id, amount: Number(b.openCents), due: b.dueAt })), facts },
            confidence: 0.6,
            by: PAYMENTS.id,
          });
          return `payment ${id} of ${money(amount)} prepared for ${v.name}`;
        }
      );
      if (res.ok) prepared++;
    }
    return `payments prepared ${prepared}`;
  });
}

// A person releases a prepared payment. Above $25,000 it takes two people.
export function releasePayment(tx: Tx, who: Principal, paymentId: string): ExecResult {
  const p = tx.db.payment.id.find(paymentId);
  if (!p || p.status !== 'prepared') throw new Rejection(`payment ${paymentId} is not waiting for release`);
  const v = tx.db.entity.code.find(p.vendorCode)!;
  const approvals = JSON.parse(p.approvals) as string[];
  if (!approvals.includes(who.id) && who.id !== p.preparedBy) approvals.push(who.id);
  const amount = Number(p.amountCents);
  const bills = JSON.parse(p.billIds) as string[];
  const res = exec(
    tx,
    {
      principal: who,
      action: 'release_payment',
      params: { payment: paymentId, vendor: p.vendorCode, amount, account: p.bankAccount },
      used: [`payment:${paymentId}`, ...bills.map(b => `bill:${b}`)],
      amountCents: amount,
      requestedBy: p.preparedBy,
      approvals: approvals.length,
      trustedFields: { bank_account: v.bankAccountTrusted && v.bankAccount === p.bankAccount },
      facts: factsFor(tx, p.vendorCode),
      claims: [{ label: 'payment equals what the ledger shows open on its bills', lhs: amount, rhs: [], bills, tolerance: 0 }],
    },
    activityId => {
      post(tx, `JE-PAY-${paymentId}`, [
        { account: '2000', debit: amount, entity: p.vendorCode, memo: `payment ${paymentId}` },
        { account: '1000', credit: amount, entity: p.vendorCode, memo: `payment ${paymentId} to ${p.bankAccount}` },
      ], activityId);
      for (const id of bills) {
        const b = tx.db.bill.id.find(id)!;
        tx.db.bill.id.update({ ...b, openCents: 0n, status: 'paid' });
      }
      bumpControl(tx, 'ap_open', -amount);
      bumpControl(tx, 'bank', -amount);
      tx.db.payment.id.update({ ...p, status: 'released', approvals: JSON.stringify(approvals) });
      return `payment ${paymentId} of ${money(amount)} released to ${v.name} at ${p.bankAccount}`;
    }
  );
  if (!res.ok) tx.db.payment.id.update({ ...p, approvals: JSON.stringify(approvals) });
  return res;
}

// Undo an approval a person has found wrong: reverse its posting, keep the record.
export function rejectBill(tx: Tx, who: Principal, billId: string, reason: string): ExecResult {
  const b = tx.db.bill.id.find(billId);
  if (!b) throw new Rejection(`no bill ${billId}`);
  const amount = Number(b.amountCents);
  return exec(tx, { principal: who, action: 'record_adjustment', params: { rejectBill: billId, reason }, used: [`bill:${billId}`], amountCents: amount, facts: factsFor(tx, b.vendorCode) }, activityId => {
    if (b.status === 'paid' || b.status === 'scheduled') throw new Rejection(`bill ${billId} is ${b.status}; cancel the payment first or recover the money`);
    if (b.status === 'rejected') throw new Rejection(`bill ${billId} is already rejected`);
    if (b.status === 'approved') {
      post(tx, `JE-AP-REV-${billId}`, [
        { account: '2000', debit: amount, entity: b.vendorCode, memo: `reverse bill ${b.billNo}: ${reason}` },
        { account: '1300', credit: amount, entity: b.vendorCode, memo: `reverse bill ${b.billNo}` },
      ], activityId);
      bumpControl(tx, 'ap_open', -amount);
    }
    tx.db.bill.id.update({ ...b, status: 'rejected', openCents: 0n, note: reason });
    return `bill ${b.billNo} from ${b.vendorCode} rejected: ${reason}`;
  });
}

// What people's answers on this desk mean.
export function answerPayables(tx: Tx, who: Principal, kind: string, subject: string, answer: string, plan: string[]): string | null {
  if (kind === 'bill_exception') {
    const billId = subject.replace('bill:', '');
    recordCheck(tx, 'bill_match', subject, answer === 'approve' ? 'approve' : answer === 'reject' ? 'reject' : 'hold_exception', 'answer', who.id);
    if (answer === 'approve') return approveBill(tx, who, billId, plan).summary;
    if (answer === 'reject') return rejectBill(tx, who, billId, `rejected by ${who.id}`).summary;
    return `bill ${billId}: still held`;
  }
  if (kind === 'payment_release') {
    const id = subject.replace('payment:', '');
    if (answer === 'release') return releasePayment(tx, who, id).summary;
    const p = tx.db.payment.id.find(id);
    if (p && p.status === 'prepared') {
      tx.db.payment.id.update({ ...p, status: 'cancelled' });
      for (const b of JSON.parse(p.billIds) as string[]) {
        const row = tx.db.bill.id.find(b);
        if (row && row.status === 'scheduled') tx.db.bill.id.update({ ...row, status: 'approved' });
      }
    }
    return `payment ${id} cancelled`;
  }
  return null;
}
