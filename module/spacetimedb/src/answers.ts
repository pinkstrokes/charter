// What happens when a person answers a seat's question, and the things only
// people may do: release refunds, endorse bank changes, waive or credit charges.
// Every path goes through the kernel, so a person is bound by the same policies.
import type { CallbackPayload } from './core/contracts';
import { DOMAINS } from './core/dsl';
import { allocationLabel } from './core/labels';
import { applyByTerms, allocationsForSubset } from './core/matching';
import { addDays, bpOf } from './core/money';
import type { Principal } from './core/policy';
import { AR_ACCOUNT_BY_KIND, bumpControl, exec, factsFor, post, Rejection, simDate, type ExecResult, type Tx } from './kernel';
import { applyAllocations, CASH, closeWork, money, useCurrency, openItemsFor, preChaseFeatures, sendNotice, termsForEntity, termsForStore, underreportFeatures } from './seats';
import { addFact, aliasSubject, createInvoice, ingest, openWork } from './world';
import { recordCheck } from './reliability';
import { routeHeldEmail, type Extracted } from './seats';
import { answerPayables, rejectBill } from './packs/payables';

export function answerAsk(tx: Tx, who: Principal, askId: bigint, answer: string, reason: string): string {
  useCurrency(tx);
  const a = tx.db.ask.id.find(askId);
  if (!a) throw new Rejection(`no question #${askId}`);
  if (a.status !== 'open') throw new Rejection(`question #${askId} is already ${a.status}`);
  if (who.role !== 'controller' && who.role !== a.toRole) throw new Rejection(`question #${askId} is for the ${a.toRole}`);
  const options = JSON.parse(a.options) as string[];
  if (a.kind !== 'identify_payer' && !options.includes(answer)) throw new Rejection(`answer with one of: ${options.join(', ')}`);
  const res = exec(tx, { principal: who, action: 'answer_ask', params: { ask: Number(askId), kind: a.kind, subject: a.subject, answer, reason }, used: [`ask:${askId}`] }, () => {
    tx.db.ask.id.update({ ...a, status: 'answered', answer, reason, answeredBy: who.id, answeredAt: simDate(tx) });
    return `answered question #${askId}: ${answer}`;
  });
  if (!res.ok) return res.summary;
  const outcome = applyAnswer(tx, who, a, answer);
  if (a.workItemId !== 0n) closeWork(tx, a.workItemId, 'done', { ask: Number(askId), answer });
  return outcome;
}

type AskRow = NonNullable<ReturnType<Tx['db']['ask']['id']['find']>>;



function applyAnswer(tx: Tx, who: Principal, a: AskRow, answer: string): string {
  const today = simDate(tx);
  const evidence = JSON.parse(a.evidence || '{}');
  const plan = [`ask:${a.id}`];
  const payables = answerPayables(tx, who, a.kind, a.subject, answer, plan);
  if (payables !== null) return payables;
  if (a.kind.startsWith('spot_check:')) {
    const domain = a.kind.slice('spot_check:'.length);
    const correct = answer === 'correct' ? String(evidence.decided) : answer;
    recordCheck(tx, domain, a.subject, correct, 'spot_check', who.id);
    if (answer !== 'correct' && domain === 'underreport') {
      const [, store, week] = a.subject.split(':');
      const st = tx.db.store.code.find(store);
      if (st) addFact(tx, `entity:${st.entityCode}`, 'audit', { store, week, status: 'open', by: who.id }, today, 0n, true);
    }
    return answer === 'correct' ? `spot check of ${a.subject} passed` : `spot check of ${a.subject}: should have been ${answer}`;
  }
  switch (a.kind) {
    case 'audit': {
      const [, store, week] = a.subject.split(':');
      const s = tx.db.store.code.find(store);
      if (!s) return 'unknown store';
      const status = answer === 'request audit' ? 'open' : 'cleared';
      addFact(tx, `entity:${s.entityCode}`, 'audit', { store, week, status, by: who.id }, today, 0n, true);
      recordCheck(tx, 'underreport', a.subject, status === 'open' ? 'flag_audit' : 'accept', 'answer', who.id);
      return status === 'open' ? `audit opened for ${store}, week of ${week}` : `report for ${store}, week of ${week} accepted`;
    }
    case 'callback': {
      const rr = tx.db.routingRequest.id.find(BigInt(a.subject.split(':')[1]));
      if (!rr) return 'unknown bank-change request';
      const e = tx.db.entity.code.find(rr.entityCode)!;
      const payload: CallbackPayload = { entityCode: rr.entityCode, phoneUsed: e.phoneOnFile, phoneSource: 'master_data_asof', outcome: answer as CallbackPayload['outcome'], note: `called by ${who.id}` };
      ingest(tx, 'callback', 'callback_desk', today, `callback:${a.id}`, `entity:${rr.entityCode}`, JSON.stringify(payload));
      return `callback to ${e.phoneOnFile}: ${answer}`;
    }
    case 'allocation': {
      const receiptId = a.subject.replace('receipt:', '');
      const r = tx.db.receipt.id.find(receiptId);
      if (!r) return 'unknown receipt';
      recordCheck(tx, 'allocation', a.subject, allocationLabel(evidence, answer), 'answer', who.id);
      const items = openItemsFor(tx, r.entityCode);
      const picked = answer.split(' + ').filter(id => items.some(i => i.id === id));
      const allocations =
        answer === 'apply oldest first'
          ? applyByTerms(Number(r.unappliedCents), items, termsForEntity(tx, r.entityCode)?.applicationOrder ?? ['interest', 'fee', 'royalty', 'supply', 'trade']).allocations
          : picked.length === 1
            ? [{ id: picked[0], cents: Math.min(Number(r.unappliedCents), items.find(i => i.id === picked[0])!.openCents) }]
            : allocationsForSubset(picked, items);
      return applyAllocations(tx, CASH, receiptId, allocations, plan) ? `applied ${receiptId} as told` : `could not apply ${receiptId}`;
    }
    case 'identify_payer': {
      const receiptId = a.subject.replace('receipt:', '');
      const r = tx.db.receipt.id.find(receiptId);
      const e = tx.db.entity.code.find(answer);
      if (!r || !e) throw new Rejection('unknown receipt or customer');
      tx.db.receipt.id.update({ ...r, entityCode: e.code });
      addFact(tx, aliasSubject(r.payerName), 'payer_alias', { entityCode: e.code, payerName: r.payerName, by: who.id }, today, 0n, true);
      openWork(tx, 'cash_app', 'apply_receipt', `entity:${e.code}`, { receiptId });
      return `"${r.payerName}" is ${e.name}; remembered for next time`;
    }
    case 'collections': {
      const entityCode = a.subject.replace('entity:', '');
      recordCheck(tx, 'pre_chase', `${a.subject}:${a.createdAt}`, answer === 'chase' ? 'chase' : answer === 'hold 7 days' ? 'hold' : 'escalate_controller', 'answer', who.id);
      if (answer === 'chase') {
        const f = preChaseFeatures(tx, entityCode, today);
        return f && sendNotice(tx, entityCode, f, plan) ? `notice sent to ${entityCode}` : `no notice sent to ${entityCode}`;
      }
      const until = addDays(today, answer === 'escalate' ? 30 : 7);
      addFact(tx, `entity:${entityCode}`, 'collections_hold', { until, by: who.id, answer }, today, 0n, true);
      return `collections for ${entityCode} paused until ${until}`;
    }
    case 'dispute': {
      const entityCode = a.subject.replace('entity:', '');
      const refs: string[] = evidence.refs ?? [];
      const invoices = [...tx.db.invoice.entityCode.filter(entityCode)];
      if (answer === 'uphold') {
        for (const inv of invoices) if (inv.status === 'disputed') tx.db.invoice.id.update({ ...inv, status: 'open' });
        return `dispute by ${entityCode} rejected; invoices back to open`;
      }
      const targets = answer === 'waive fees' ? invoices.filter(i => i.kind === 'fee' && i.openCents > 0n) : invoices.filter(i => refs.includes(i.id) && i.openCents > 0n);
      const done = targets.map(inv => (answer === 'waive fees' ? waiveFee(tx, who, inv.id, plan) : creditInvoice(tx, who, inv.id, Number(inv.openCents), plan)));
      return done.map(r => r.summary).join('; ') || 'nothing to adjust';
    }
    case 'refund_release': {
      const refundId = BigInt(a.subject.split(':')[1]);
      if (answer === 'release') return releaseRefund(tx, who, refundId).summary;
      const rf = tx.db.refund.id.find(refundId);
      if (rf && rf.status === 'prepared') tx.db.refund.id.update({ ...rf, status: 'cancelled' });
      return `refund ${refundId} cancelled`;
    }
    case 'unapplied_cash': {
      const r = tx.db.receipt.id.find(a.subject.replace('receipt:', ''));
      if (!r) return 'unknown receipt';
      if (answer === 'refund') {
        openWork(tx, 'refunds', 'refund_request', `entity:${r.entityCode}`, { amount: Number(r.unappliedCents), obs: 0, newAccount: '', receipt: r.id });
        return `refund of ${money(Number(r.unappliedCents))} handed to the refunds seat`;
      }
      return `${money(Number(r.unappliedCents))} kept as credit for ${r.entityCode}`;
    }
    case 'reading_conflict': {
      const obsId = BigInt(evidence.observation);
      if (answer === 'ignore the email') {
        const obs = tx.db.observation.id.find(obsId);
        if (obs) tx.db.observation.id.update({ ...obs, status: 'done' });
        return 'email set aside';
      }
      routeHeldEmail(tx, obsId, (answer === 'reading A' ? evidence.readingA : evidence.readingB) as Extracted);
      return `email handled with ${answer}`;
    }
    case 'finding': {
      const f = tx.db.finding.id.find(BigInt(a.subject.split(':')[1]));
      if (f) tx.db.finding.id.update({ ...f, status: 'resolved', resolution: answer, resolvedBy: who.id });
      return `finding ${a.subject}: ${answer}`;
    }
    case 'royalty_decrease':
      return answer === 'issue credit' ? creditInvoice(tx, who, a.subject, Number(evidence.delta ?? 0), plan).summary : 'original royalty kept';
    default:
      return 'noted';
  }
}

// Refunds draw down overpaid (unapplied) cash and go only to the account on file.
// A person releases them; above the two-person limit a second person must too.
export function releaseRefund(tx: Tx, who: Principal, refundId: bigint): ExecResult {
  const rf = tx.db.refund.id.find(refundId);
  if (!rf || rf.status !== 'prepared') throw new Rejection(`refund ${refundId} is not waiting for release`);
  const e = tx.db.entity.code.find(rf.entityCode)!;
  const approvals = JSON.parse(rf.approvals) as string[];
  if (!approvals.includes(who.id) && who.id !== rf.requestedBy) approvals.push(who.id);
  const amount = Number(rf.amountCents);
  const res = exec(
    tx,
    {
      principal: who,
      action: 'issue_refund',
      params: { refund: Number(rf.id), entity: rf.entityCode, amount, account: rf.bankAccount },
      used: [`refund:${rf.id}`],
      amountCents: amount,
      requestedBy: rf.requestedBy,
      approvals: approvals.length,
      trustedFields: { bank_account: e.bankAccountTrusted && e.bankAccount === rf.bankAccount },
      facts: factsFor(tx, rf.entityCode),
    },
    activityId => {
      const receipts = [...tx.db.receipt.entityCode.filter(rf.entityCode)].filter(r => r.unappliedCents > 0n);
      if (receipts.reduce((s, r) => s + Number(r.unappliedCents), 0) < amount) throw new Rejection('overpaid cash is now smaller than the refund');
      let left = amount;
      for (const r of receipts) {
        const take = Math.min(left, Number(r.unappliedCents));
        if (take <= 0) break;
        const rest = r.unappliedCents - BigInt(take);
        tx.db.receipt.id.update({ ...r, unappliedCents: rest, status: rest === 0n ? 'refunded' : r.status });
        left -= take;
      }
      post(tx, `JE-RF-${rf.id}`, [
        { account: '2100', debit: amount, entity: rf.entityCode, memo: `refund ${rf.id} of overpaid cash` },
        { account: '1000', credit: amount, entity: rf.entityCode, memo: `refund ${rf.id} to ${rf.bankAccount}` },
      ], activityId);
      bumpControl(tx, 'unapplied', -amount);
      bumpControl(tx, 'bank', -amount);
      tx.db.refund.id.update({ ...rf, status: 'released', approvals: JSON.stringify(approvals), activityId });
      return `refund ${rf.id} of ${money(amount)} released to ${rf.bankAccount}`;
    }
  );
  if (!res.ok) tx.db.refund.id.update({ ...rf, approvals: JSON.stringify(approvals) });
  return res;
}

// A bank change takes effect only after a callback to the number on file confirmed it.
export function endorseRouting(tx: Tx, who: Principal, requestId: bigint): ExecResult {
  const rr = tx.db.routingRequest.id.find(requestId);
  if (!rr) throw new Rejection(`no bank-change request ${requestId}`);
  return exec(tx, { principal: who, action: 'endorse_routing_change', params: { request: Number(requestId), entity: rr.entityCode, account: rr.requestedAccount }, used: [`routing:${requestId}`], facts: factsFor(tx, rr.entityCode) }, () => {
    if (rr.status !== 'verified') throw new Rejection(`request ${requestId} is ${rr.status}; it needs a confirmed callback to the number on file`);
    const e = tx.db.entity.code.find(rr.entityCode)!;
    tx.db.entity.code.update({ ...e, bankAccount: rr.requestedAccount, bankAccountTrusted: true });
    tx.db.routingRequest.id.update({ ...rr, status: 'applied', decidedBy: who.id });
    return `${e.name} now pays from ${rr.requestedAccount}`;
  });
}

export function waiveFee(tx: Tx, who: Principal, invoiceId: string, plan: string[]): ExecResult {
  const inv = tx.db.invoice.id.find(invoiceId);
  if (!inv) throw new Rejection(`no invoice ${invoiceId}`);
  const cents = Number(inv.openCents);
  return exec(tx, { principal: who, action: 'waive_fee', params: { invoice: invoiceId, cents }, used: [`invoice:${invoiceId}`], plan, amountCents: cents, facts: factsFor(tx, inv.entityCode) }, activityId => {
    if (inv.kind !== 'fee' && inv.kind !== 'interest') throw new Rejection(`${invoiceId} is not a fee`);
    if (cents <= 0) throw new Rejection(`${invoiceId} has nothing open`);
    tx.db.invoice.id.update({ ...inv, openCents: 0n, status: 'waived' });
    post(tx, `JE-WV-${invoiceId}`, [
      { account: '4200', debit: cents, entity: inv.entityCode, memo: `waive ${invoiceId}` },
      { account: '1120', credit: cents, entity: inv.entityCode, memo: `waive ${invoiceId}` },
    ], activityId);
    bumpControl(tx, `ar_${inv.kind}`, -cents);
    return `waived ${money(cents)} on ${invoiceId}`;
  });
}

export function creditInvoice(tx: Tx, who: Principal, invoiceId: string, cents: number, plan: string[]): ExecResult {
  const inv = tx.db.invoice.id.find(invoiceId);
  if (!inv) throw new Rejection(`no invoice ${invoiceId}`);
  return exec(tx, { principal: who, action: 'record_adjustment', params: { invoice: invoiceId, cents }, used: [`invoice:${invoiceId}`], plan, amountCents: cents, facts: factsFor(tx, inv.entityCode) }, activityId => {
    if (cents <= 0 || BigInt(cents) > inv.openCents) throw new Rejection(`cannot credit ${money(cents)} on ${invoiceId} with ${money(Number(inv.openCents))} open`);
    const open = inv.openCents - BigInt(cents);
    tx.db.invoice.id.update({ ...inv, openCents: open, status: open === 0n ? 'credited' : inv.status });
    post(tx, `JE-CR-${invoiceId}-${activityId}`, [
      { account: '4050', debit: cents, entity: inv.entityCode, memo: `credit on ${invoiceId}` },
      { account: AR_ACCOUNT_BY_KIND[inv.kind], credit: cents, entity: inv.entityCode, memo: `credit on ${invoiceId}` },
    ], activityId);
    bumpControl(tx, `ar_${inv.kind}`, -cents);
    return `credited ${money(cents)} on ${invoiceId}`;
  });
}

// A person noticed something the seats did not. The note is recorded as an
// answered question carrying the case's features: what the evolver learns from.
export function raiseConcern(tx: Tx, who: Principal, store: string, week: string, note: string): string {
  const f = underreportFeatures(tx, store, week);
  const s = tx.db.store.code.find(store);
  if (!f || !s) throw new Rejection(`no sales report for ${store}, week of ${week}`);
  const subject = `store:${store}:${week}`;
  const res = exec(tx, { principal: who, action: 'answer_ask', params: { concern: subject, note }, used: [`fact:${f.reportFactId}`] }, () => {
    const today = simDate(tx);
    tx.db.ask.insert({
      id: 0n, createdAt: today, kind: 'audit', subject, toRole: who.role,
      question: `${who.id} raised a concern about ${s.name}, week of ${week}`,
      options: JSON.stringify(['request audit', 'explained — accept report']),
      evidence: JSON.stringify({ features: f.features, raisedBy: who.id }),
      confidence: 1, precedent: '', status: 'answered', answer: 'request audit', reason: note,
      answeredBy: who.id, answeredAt: today, deadline: today, workItemId: 0n,
    });
    addFact(tx, `entity:${s.entityCode}`, 'audit', { store, week, status: 'open', by: who.id }, today, 0n, true);
    return `concern on ${store}, week of ${week} recorded; audit opened`;
  });
  return res.summary;
}

// The field audit's finding. Royalty on sales that were not reported is billed.
export function closeAudit(tx: Tx, who: Principal, store: string, week: string, auditedGrossCents: number, note: string): string {
  const s = tx.db.store.code.find(store);
  const terms = termsForStore(tx, store);
  if (!s || !terms) throw new Rejection(`no store ${store}`);
  const prefix = `R-${store}-${week}`;
  const billed = [...tx.db.invoice.entityCode.filter(s.entityCode)].filter(i => (i.kind === 'royalty' && i.id.startsWith(prefix)) || i.id === `A-${store}-${week}`).reduce((sum, i) => sum + Number(i.amountCents), 0);
  const owed = bpOf(auditedGrossCents, terms.royaltyBp) - billed;
  const res = exec(tx, { principal: who, action: 'answer_ask', params: { audit: `${store}:${week}`, auditedGrossCents, owed, note }, used: [`audit:${store}:${week}`] }, () => {
    addFact(tx, `entity:${s.entityCode}`, 'audit', { store, week, status: 'closed', auditedGrossCents, owedCents: Math.max(0, owed), by: who.id, note }, simDate(tx), 0n, true);
    recordCheck(tx, 'underreport', `store:${store}:${week}`, owed > 0 ? 'flag_audit' : 'accept', 'field_audit', who.id);
    return `audit of ${store}, week of ${week} closed: ${owed > 0 ? `${money(owed)} royalty under-billed` : 'report was right'}`;
  });
  if (res.ok && owed > 0) {
    const today = simDate(tx);
    createInvoice(tx, CASH, { id: `A-${store}-${week}`, kind: 'audit', entityCode: s.entityCode, storeCode: store, period: week, issuedAt: today, dueAt: addDays(today, terms.paymentTermsDays), amountCents: owed, source: `audit by ${who.id}` }, [`audit:${store}:${week}`], [`activity:${res.activityId}`], '4000', 'record_adjustment');
  }
  return res.summary;
}

// Any decision a seat made can be marked wrong by a person, with one line of
// why. That correction is a labeled case: the evolver learns from it.
export function correctDecision(tx: Tx, who: Principal, decisionId: bigint, outcome: string, reason: string): string {
  const d = tx.db.decision.id.find(decisionId);
  if (!d) throw new Rejection(`no decision #${decisionId}`);
  const spec = DOMAINS[d.domain as keyof typeof DOMAINS];
  if (!spec || !(spec.outcomes as readonly string[]).includes(outcome)) throw new Rejection(`${d.domain} decisions are one of: ${spec ? spec.outcomes.join(', ') : 'unknown domain'}`);
  if (!reason.trim()) throw new Rejection('say in one line why');
  const res = exec(tx, { principal: who, action: 'answer_ask', params: { correction: Number(decisionId), domain: d.domain, subject: d.subject, was: d.outcome, should: outcome, reason }, used: [`decision:${decisionId}`] }, () => {
    const today = simDate(tx);
    tx.db.ask.insert({
      id: 0n, createdAt: d.at, kind: `correction:${d.domain}`, subject: d.subject, toRole: who.role,
      question: `${who.id} says the ${d.domain} decision on ${d.subject} should have been "${outcome}", not "${d.outcome}"`,
      options: JSON.stringify(spec.outcomes), evidence: JSON.stringify({ features: JSON.parse(d.features), decision: Number(decisionId), was: d.outcome, skill: d.skillKey }),
      confidence: 1, precedent: '', status: 'answered', answer: outcome, reason, answeredBy: who.id, answeredAt: today, deadline: today, workItemId: 0n,
    });
    recordCheck(tx, d.domain, d.subject, outcome, 'correction', who.id);
    return `correction recorded on decision #${decisionId}: ${d.outcome} -> ${outcome}`;
  });
  // Correcting an approval undoes it, through the kernel like everything else.
  if (res.ok && d.domain === 'bill_match' && outcome === 'reject') return rejectBill(tx, who, d.subject.replace('bill:', ''), reason).summary;
  return res.summary;
}
