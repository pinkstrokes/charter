// Ingestion: how the outside world (bank, card processor, ERP, inbox, call desk)
// reaches the organization. Trusted sources become facts and postings directly;
// email is stored as untrusted text for the quarantined extractor.
import { TRUSTED_SOURCES, type BankTxnPayload, type CallbackPayload, type CreditNotePayload, type ProcessorSettlementPayload, type SupplyInvoicePayload, type TradeInvoicePayload } from './core/contracts';
import { sha256Hex } from './core/hash';
import type { Action, Principal } from './core/policy';
import { AR_ACCOUNT_BY_KIND, appendActivity, bumpControl, exec, post, Rejection, simDate, type Tx } from './kernel';

const SYSTEM: Principal = { kind: 'system', id: 'erp', role: 'world' };
const AUTO_SETTLE: Principal = { kind: 'system', id: 'auto-settlement', role: 'cash_app' };

// Finance packs register the observation kinds they understand here, so the
// core never needs to know about receivables, payables or anything else.
export const INGESTORS: Record<string, (tx: Tx, obsId: bigint, data: any) => void> = {};

export function addFact(tx: Tx, subject: string, attr: string, value: unknown, validFrom: string, sourceObs: bigint, trusted: boolean, activityId = 0n): bigint {
  const row = tx.db.fact.insert({
    id: 0n,
    subject,
    attr,
    value: JSON.stringify(value),
    validFrom,
    knownAt: simDate(tx),
    sourceObs,
    trusted,
    activityId,
  });
  return row.id;
}

export function openWork(tx: Tx, seat: string, kind: string, subject: string, payload: unknown): bigint {
  const today = simDate(tx);
  return tx.db.workItem.insert({ id: 0n, kind, subject, seat, state: 'open', createdAt: today, updatedAt: today, payload: JSON.stringify(payload), checkpoint: '{}' }).id;
}

export function ingest(tx: Tx, kind: string, source: string, validAt: string, refKey: string, subject: string, payload: string): bigint {
  const existing = tx.db.observation.refKey.find(refKey);
  if (existing) return existing.id;
  const trusted = (TRUSTED_SOURCES as readonly string[]).includes(source);
  const obs = tx.db.observation.insert({
    id: 0n,
    kind,
    source,
    trusted,
    knownAt: simDate(tx),
    validAt,
    refKey,
    subject,
    payload,
    sha: sha256Hex(payload),
    status: kind === 'email' ? 'new' : 'done',
  });
  const data = JSON.parse(payload);
  switch (kind) {
    case 'processor_settlement':
      ingestSettlement(tx, obs.id, data as ProcessorSettlementPayload);
      break;
    case 'supply_invoice':
      ingestSupplyInvoice(tx, obs.id, data as SupplyInvoicePayload);
      break;
    case 'trade_invoice':
      ingestTradeInvoice(tx, obs.id, data as TradeInvoicePayload);
      break;
    case 'credit_note':
      ingestCreditNote(tx, obs.id, data as CreditNotePayload);
      break;
    case 'bank_txn':
      ingestBankTxn(tx, obs.id, data as BankTxnPayload);
      break;
    case 'callback':
      ingestCallback(tx, obs.id, data as CallbackPayload);
      break;
    case 'email':
      appendActivity(tx, { principal: 'inbox', role: 'world', kind: 'ingest', command: 'email_received', params: { observation: Number(obs.id), subject }, used: [`obs:${obs.id}`], outcome: 'stored_untrusted' });
      break;
    default:
      if (!INGESTORS[kind]) throw new Rejection(`unknown observation kind ${kind}`);
      INGESTORS[kind](tx, obs.id, data);
  }
  return obs.id;
}

function ingestSettlement(tx: Tx, obsId: bigint, p: ProcessorSettlementPayload): void {
  addFact(tx, `store:${p.storeCode}`, 'card_settled', { date: p.businessDate, cents: p.cardGrossCents }, p.businessDate, obsId, true);
}

export function createInvoice(
  tx: Tx,
  principal: Principal,
  inv: { id: string; kind: string; entityCode: string; storeCode: string; period: string; issuedAt: string; dueAt: string; amountCents: number; source: string },
  used: string[],
  plan: string[],
  revenueAccount: string,
  action: Action = 'post_invoice'
): { ok: boolean; reasons: string[]; activityId: bigint } {
  if (tx.db.invoice.id.find(inv.id)) return { ok: true, reasons: ['already exists'], activityId: 0n };
  const res = exec(tx, { principal, action, params: inv, used, plan, amountCents: inv.amountCents }, activityId => {
    if (inv.amountCents <= 0) throw new Rejection(`invoice ${inv.id} amount must be positive`);
    tx.db.invoice.insert({ ...inv, amountCents: BigInt(inv.amountCents), openCents: BigInt(inv.amountCents), status: 'open' });
    post(tx, `JE-${inv.id}`, [
      { account: AR_ACCOUNT_BY_KIND[inv.kind], debit: inv.amountCents, entity: inv.entityCode, memo: `${inv.kind} invoice ${inv.id}` },
      { account: revenueAccount, credit: inv.amountCents, entity: inv.entityCode, memo: `${inv.kind} invoice ${inv.id}` },
    ], activityId);
    bumpControl(tx, `ar_${inv.kind}`, inv.amountCents);
    return `${inv.kind} invoice ${inv.id} for ${inv.amountCents}`;
  });
  return { ok: res.ok, reasons: res.reasons, activityId: res.activityId };
}

function ingestSupplyInvoice(tx: Tx, obsId: bigint, p: SupplyInvoicePayload): void {
  createInvoice(tx, SYSTEM, { id: p.invoiceNo, kind: 'supply', entityCode: p.entityCode, storeCode: p.storeCode, period: p.date.slice(0, 7), issuedAt: p.date, dueAt: p.dueDate, amountCents: p.totalCents, source: `obs:${obsId}` }, [`obs:${obsId}`], [], '4100');
  addFact(tx, `store:${p.storeCode}`, 'supply_order', { date: p.date, drinks: p.impliedDrinks, cents: p.totalCents }, p.date, obsId, true);
}

function ingestTradeInvoice(tx: Tx, obsId: bigint, p: TradeInvoicePayload): void {
  createInvoice(tx, SYSTEM, { id: p.invoiceNo, kind: 'trade', entityCode: p.customerCode, storeCode: '', period: p.date.slice(0, 7), issuedAt: p.date, dueAt: p.dueDate, amountCents: p.netCents, source: `obs:${obsId}` }, [`obs:${obsId}`], [], '4000');
}

function ingestCreditNote(tx: Tx, obsId: bigint, p: CreditNotePayload): void {
  exec(tx, { principal: SYSTEM, action: 'post_invoice', params: p, used: [`obs:${obsId}`], amountCents: p.amountCents }, activityId => {
    const linked = p.linkedInvoiceNo ? tx.db.invoice.id.find(p.linkedInvoiceNo) : null;
    if (linked && linked.openCents >= BigInt(p.amountCents)) {
      tx.db.invoice.id.update({ ...linked, openCents: linked.openCents - BigInt(p.amountCents), status: linked.openCents === BigInt(p.amountCents) ? 'paid' : linked.status });
      post(tx, `JE-${p.creditNo}`, [
        { account: '4050', debit: p.amountCents, entity: p.customerCode, memo: `credit note ${p.creditNo} against ${linked.id}` },
        { account: '1100', credit: p.amountCents, entity: p.customerCode, memo: `credit note ${p.creditNo}` },
      ], activityId);
      bumpControl(tx, 'ar_trade', -p.amountCents);
      return `credit note ${p.creditNo} netted against ${linked.id}`;
    }
    post(tx, `JE-${p.creditNo}`, [
      { account: '4050', debit: p.amountCents, entity: p.customerCode, memo: `credit note ${p.creditNo}` },
      { account: '2200', credit: p.amountCents, entity: p.customerCode, memo: `customer credit ${p.creditNo}` },
    ], activityId);
    addFact(tx, `entity:${p.customerCode}`, 'customer_credit', { creditNo: p.creditNo, cents: p.amountCents }, p.date, obsId, true, activityId);
    return `credit note ${p.creditNo} held as customer credit`;
  });
}

function resolvePayer(tx: Tx, p: BankTxnPayload): string {
  if (p.debitId) {
    const d = tx.db.debitInstruction.id.find(p.debitId);
    if (d) return d.entityCode;
  }
  for (const e of tx.db.entity.iter()) if (e.bankAccount === p.counterpartyAccount && e.bankAccountTrusted) return e.code;
  // Payer names a person already matched to a customer (see answers.ts identify_payer).
  for (const f of tx.db.fact.subject.filter(aliasSubject(p.counterpartyName))) if (f.attr === 'payer_alias' && f.trusted) return JSON.parse(f.value).entityCode;
  return '';
}

export function aliasSubject(payerName: string): string {
  return `alias:${payerName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

function ingestBankTxn(tx: Tx, obsId: bigint, p: BankTxnPayload): void {
  const inflow = p.type === 'ach_debit_settled' || p.type === 'wire_in' || p.type === 'ach_credit_in' || p.type === 'check_deposit';
  if (inflow) {
    const entityCode = resolvePayer(tx, p);
    exec(tx, { principal: { kind: 'system', id: 'bank-feed', role: 'cash_app' }, action: 'apply_receipt', params: { txnId: p.txnId, amount: p.amountCents, type: p.type }, used: [`obs:${obsId}`] }, activityId => {
      tx.db.receipt.insert({
        id: p.txnId,
        entityCode,
        payerName: p.counterpartyName,
        amountCents: BigInt(p.amountCents),
        unappliedCents: BigInt(p.amountCents),
        receivedAt: p.date,
        method: p.type,
        reference: p.reference,
        status: 'unapplied',
      });
      post(tx, `JE-${p.txnId}`, [
        { account: '1000', debit: p.amountCents, entity: entityCode, memo: `${p.type} ${p.counterpartyName}` },
        { account: '2100', credit: p.amountCents, entity: entityCode, memo: `unapplied ${p.txnId}` },
      ], activityId);
      bumpControl(tx, 'bank', p.amountCents);
      bumpControl(tx, 'unapplied', p.amountCents);
      return `receipt ${p.txnId} recorded as unapplied cash`;
    });
    if (p.type === 'ach_debit_settled' && p.debitId) settleDebit(tx, obsId, p);
    else if (entityCode) openWork(tx, 'cash_app', 'apply_receipt', `entity:${entityCode}`, { receiptId: p.txnId });
    else openWork(tx, 'cash_app', 'identify_payer', `receipt:${p.txnId}`, { receiptId: p.txnId });
    return;
  }
  if (p.type === 'ach_debit_returned') {
    returnDebit(tx, obsId, p);
    return;
  }
  // Money leaving the bank that the organization did not initiate is recorded for the controller.
  exec(tx, { principal: { kind: 'system', id: 'bank-feed', role: 'cash_app' }, action: 'record_adjustment', params: p, used: [`obs:${obsId}`] }, activityId => {
    post(tx, `JE-${p.txnId}`, [
      { account: '2100', debit: p.amountCents, memo: `${p.type} ${p.reference}` },
      { account: '1000', credit: p.amountCents, memo: `${p.type} ${p.reference}` },
    ], activityId);
    bumpControl(tx, 'bank', -p.amountCents);
    bumpControl(tx, 'unapplied', -p.amountCents);
    return `${p.type} recorded`;
  });
}

export function applyToInvoice(tx: Tx, receiptId: string, invoiceId: string, cents: number, activityId: bigint): void {
  const r = tx.db.receipt.id.find(receiptId);
  const inv = tx.db.invoice.id.find(invoiceId);
  if (!r || !inv) throw new Rejection(`unknown receipt ${receiptId} or invoice ${invoiceId}`);
  const amt = BigInt(cents);
  if (amt <= 0n || amt > r.unappliedCents || amt > inv.openCents) throw new Rejection(`cannot apply ${cents} from ${receiptId} to ${invoiceId}`);
  tx.db.receipt.id.update({ ...r, unappliedCents: r.unappliedCents - amt, status: r.unappliedCents - amt === 0n ? 'applied' : 'partially_applied' });
  tx.db.invoice.id.update({ ...inv, openCents: inv.openCents - amt, status: inv.openCents - amt === 0n ? 'paid' : inv.status });
  tx.db.application.insert({ id: 0n, receiptId, invoiceId, amountCents: amt, activityId, reversed: false });
  post(tx, `JE-APP-${receiptId}-${invoiceId}-${activityId}`, [
    { account: '2100', debit: cents, entity: inv.entityCode, memo: `apply ${receiptId} to ${invoiceId}` },
    { account: AR_ACCOUNT_BY_KIND[inv.kind], credit: cents, entity: inv.entityCode, memo: `apply ${receiptId} to ${invoiceId}` },
  ], activityId);
  bumpControl(tx, 'unapplied', -cents);
  bumpControl(tx, `ar_${inv.kind}`, -cents);
}

function settleDebit(tx: Tx, obsId: bigint, p: BankTxnPayload): void {
  const d = tx.db.debitInstruction.id.find(p.debitId!);
  if (!d) return;
  const ids = JSON.parse(d.invoiceIds) as string[];
  exec(tx, { principal: AUTO_SETTLE, action: 'apply_receipt', params: { receiptId: p.txnId, debitId: d.id, invoices: ids }, used: [`obs:${obsId}`, `debit:${d.id}`] }, activityId => {
    for (const id of ids) {
      const inv = tx.db.invoice.id.find(id);
      const r = tx.db.receipt.id.find(p.txnId)!;
      if (!inv || inv.openCents === 0n) continue;
      const take = inv.openCents < r.unappliedCents ? inv.openCents : r.unappliedCents;
      if (take > 0n) applyToInvoice(tx, p.txnId, id, Number(take), activityId);
    }
    tx.db.debitInstruction.id.update({ ...d, status: 'settled' });
    return `debit ${d.id} settled and applied to ${ids.length} invoices`;
  });
  const left = tx.db.receipt.id.find(p.txnId);
  if (left && left.unappliedCents > 0n) openWork(tx, 'cash_app', 'apply_receipt', `entity:${d.entityCode}`, { receiptId: p.txnId });
}

function returnDebit(tx: Tx, obsId: bigint, p: BankTxnPayload): void {
  const original = p.originalTxnId ? tx.db.receipt.id.find(p.originalTxnId) : null;
  const entityCode = original?.entityCode ?? '';
  exec(tx, { principal: AUTO_SETTLE, action: 'reverse_application', params: { returnTxn: p.txnId, original: p.originalTxnId, code: p.returnCode }, used: [`obs:${obsId}`] }, activityId => {
    if (!original) throw new Rejection(`return ${p.txnId} references unknown receipt ${p.originalTxnId}`);
    for (const app of [...tx.db.application.receiptId.filter(original.id)]) {
      if (app.reversed) continue;
      const inv = tx.db.invoice.id.find(app.invoiceId)!;
      tx.db.invoice.id.update({ ...inv, openCents: inv.openCents + app.amountCents, status: 'open' });
      tx.db.application.id.update({ ...app, reversed: true });
      post(tx, `JE-REV-${app.id}`, [
        { account: AR_ACCOUNT_BY_KIND[inv.kind], debit: Number(app.amountCents), entity: inv.entityCode, memo: `reinstate ${inv.id}: debit returned ${p.returnCode}` },
        { account: '2100', credit: Number(app.amountCents), entity: inv.entityCode, memo: `reverse application ${app.id}` },
      ], activityId);
      bumpControl(tx, `ar_${inv.kind}`, app.amountCents);
      bumpControl(tx, 'unapplied', app.amountCents);
    }
    post(tx, `JE-${p.txnId}`, [
      { account: '2100', debit: p.amountCents, entity: entityCode, memo: `returned debit ${p.returnCode}` },
      { account: '1000', credit: p.amountCents, entity: entityCode, memo: `returned debit ${p.returnCode}` },
    ], activityId);
    bumpControl(tx, 'bank', -p.amountCents);
    bumpControl(tx, 'unapplied', -p.amountCents);
    tx.db.receipt.id.update({ ...tx.db.receipt.id.find(original.id)!, unappliedCents: 0n, status: 'returned' });
    if (p.debitId) {
      const d = tx.db.debitInstruction.id.find(p.debitId);
      if (d) tx.db.debitInstruction.id.update({ ...d, status: 'returned' });
    }
    return `debit returned (${p.returnCode}); invoices reinstated`;
  });
  openWork(tx, 'collections', 'ach_return', `entity:${entityCode}`, { returnTxn: p.txnId, code: p.returnCode, amount: p.amountCents });
}

function ingestCallback(tx: Tx, obsId: bigint, p: CallbackPayload): void {
  addFact(tx, `entity:${p.entityCode}`, 'callback', p, simDate(tx), obsId, true);
  for (const r of [...tx.db.routingRequest.entityCode.filter(p.entityCode)]) {
    if (r.status !== 'held') continue;
    if (p.outcome === 'denied') {
      tx.db.routingRequest.id.update({ ...r, status: 'rejected', callbackStatus: 'denied', decidedBy: 'callback' });
      tx.db.securityEvent.insert({ id: 0n, at: simDate(tx), kind: 'routing_fraud_stopped', subject: p.entityCode, detail: `owner denied requesting a change to ${r.requestedAccount}`, stoppedBy: 'callback to number on file', observationId: r.sourceObs });
    } else if (p.outcome === 'confirmed' && p.phoneSource === 'master_data_asof') {
      tx.db.routingRequest.id.update({ ...r, status: 'verified', callbackStatus: 'confirmed' });
    } else {
      tx.db.routingRequest.id.update({ ...r, callbackStatus: p.outcome });
    }
  }
}
