// One line per activity row, in the words of the business, built from the
// row's own params. Nothing here is computed from other tables.
import type { Activity } from '../module_bindings/types';
import { actor, answerWords, money, prettyText, SEAT_LABEL } from './format';
import { parseArr, parseObj } from './json';

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const cents = (v: unknown) => (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' ? money(v as number) : '');

export function summarize(a: Activity): string {
  const p = parseObj(a.params);
  switch (a.command) {
    case 'post_invoice':
      if (p.creditNo) return `credit note ${str(p.creditNo)} ${cents(p.amountCents)}`;
      return `${str(p.kind)} invoice ${str(p.id)}, ${cents(p.amountCents)}`;
    case 'apply_receipt': {
      if (Array.isArray(p.allocations)) {
        const allocs = p.allocations as { id: string; cents: number }[];
        const total = allocs.reduce((s, x) => s + (x.cents ?? 0), 0);
        return `${str(p.receiptId)}: ${money(total)} to ${allocs.map(x => x.id).join(', ')}`;
      }
      if (p.debitId) return `debit ${str(p.debitId)} settled against ${(p.invoices as string[] | undefined)?.length ?? 0} invoices`;
      const payer = p.payer && typeof p.payer === 'object' ? (p.payer as { code?: string }).code : undefined;
      return `${str(p.txnId)} ${cents(p.amount)} ${str(p.type).replace(/_/g, ' ')}${payer ? ` from ${payer}` : p.payer ? ', payer not decided' : ''}`;
    }
    case 'reverse_application':
      if (p.receipt) return `${str(p.receipt)} back to unapplied cash: ${str(p.reason)}`;
      return `return ${str(p.returnTxn)} (${str(p.code)}) of ${str(p.original)}`;
    case 'initiate_debit':
      return `${cents(p.amount)} from ${str(p.entity)} at ${str(p.account)}`;
    case 'request_routing_change':
      return `${str(p.entityCode)} asked to pay from ${str(p.requested)}; ${str(p.decision).replace(/_/g, ' ')}`;
    case 'endorse_routing_change':
      return `${str(p.entity)} to ${str(p.account)}`;
    case 'answer_ask':
      if (p.correction !== undefined) return `decision #${str(p.correction)} should be ${str(p.should).replace(/_/g, ' ')}, not ${str(p.was).replace(/_/g, ' ')}`;
      if (p.concern) return `concern on ${str(p.concern).replace(/^store:/, '').replace(':', ', week of ')}`;
      if (p.audit) return `audit ${str(p.audit)} closed: ${p.owed && Number(p.owed) > 0 ? `${cents(p.owed)} under-billed` : 'report was right'}`;
      return `#${str(p.ask)} ${str(p.kind).replace(/_/g, ' ')}: “${answerWords(str(p.answer))}”`;
    case 'issue_refund':
      return `${cents(p.amount)} to ${str(p.entity)} at ${str(p.account)}`;
    case 'request_refund':
      return `${cents(p.amount)} for ${str(p.entity)} to ${str(p.account)}${p.askedFor && p.askedFor !== p.account ? ` (asked for ${str(p.askedFor)})` : ''}`;
    case 'send_notice':
      return `${str(p.entity)}: ${cents(p.open)} open, ${str(p.daysPastDue)} days past due`;
    case 'assess_fee':
      return `${str(p.id)} ${cents(p.amountCents)}`;
    case 'waive_fee':
      return `${str(p.invoice)} ${cents(p.cents)}`;
    case 'record_adjustment':
      return p.invoice ? `${str(p.invoice)} ${cents(p.cents)}` : `${str(p.id ?? p.txnId)} ${cents(p.amountCents)}`;
    case 'request_audit':
      return `${str(p.store)}, week of ${str(p.week)}`;
    case 'hire_seat': {
      const inh = (p.inherits ?? {}) as { skills?: string[]; policies?: string[] };
      return `${SEAT_LABEL[str(p.seat)] ?? str(p.seat)} seat, starting with ${inh.skills?.length ?? 0} skills and ${inh.policies?.length ?? 0} policies`;
    }
    case 'activate_skill':
      return `${str(p.key)}: ${str(p.from)} to ${str(p.to)}${p.to === 'canary' && typeof p.fraction === 'number' ? ` (${Math.round(p.fraction * 100)}%)` : ''}`;
    case 'activate_policy':
      return `${str(p.key)} ${p.approve ? 'ratified' : 'rejected'}`;
    case 'propose_skill':
      return `${str(p.key)}${p.parent ? ` from ${str(p.parent)}` : ''}`;
    case 'propose_policy':
      return `${str(p.policyId)}: ${str(p.text)}`;
    case 'email_received':
      return `from ${str(p.subject).replace(/^sender:/, '')}`;
    case 'hold_collection':
      return `${str(p.entity)}: ${parseArr<string>(a.reasons)[0] ?? a.outcome}`;
    case 'decline_refund':
      return `${str(p.entity)} asked for ${cents(p.requested)}; nothing overpaid`;
    case 'bind_role':
      return `${str(p.name)} as ${str(p.role)}`;
    case 'load_company':
      return `${str(p.name)}: ${str(p.stores)} stores, ${str(p.entities)} counterparties`;
    case 'approve_bill':
      return `${str(p.bill ?? p.id)} ${p.amount !== undefined ? cents(p.amount) : ''}`.trim();
    case 'prepare_payment':
      return `${cents(p.amount)} to ${str(p.vendor)} at ${str(p.account)} for ${(p.bills as string[] | undefined)?.length ?? 0} ${((p.bills as string[] | undefined)?.length ?? 0) === 1 ? 'bill' : 'bills'}`;
    case 'release_payment':
      return `${cents(p.amount)} to ${str(p.vendor)} at ${str(p.account)}`;
    case 'attempt':
      return `${str(p.domain).replace(/_/g, ' ')}: ${str(p.summary)}`;
    case 'inspection_level':
      return `${str(p.rule)}: ${str(p.from)} to ${str(p.to)}, ${str(p.errors)} wrong in ${str(p.checked)} checks`;
    case 'verdict_declined':
      return `${prettyText(str(p.subject))}: "${str(p.decided).replace(/_/g, ' ')}" stands against ${p.by ? actor(str(p.by)).label : 'a person'}'s "${str(p.verdict).replace(/_/g, ' ')}" — ${parseArr<string>(a.reasons)[0] ?? ''}`;
    case 'set_aside':
      return `${str(p.kind).replace(/_/g, ' ')} for ${prettyText(str(p.subject))} set aside for a person: ${parseArr<string>(a.reasons)[0] ?? 'it failed'}`;
    case 'close_period':
      return `${str(p.period)}`;
    case 'file_finding':
      return p.opinion ? `opinion on ${str(p.period)}: ${str(p.opinion)}` : `${str(p.severity)}: ${str(p.test).replace(/_/g, ' ')} on ${str(p.subject)}`;
    case 'charter_founded':
      return `constitution ${(p.constitution as string[] | undefined)?.join(', ') ?? ''}`;
  }
  if (a.kind === 'ask') return prettyText(str(p.question));
  const keys = Object.keys(p).slice(0, 3);
  return keys.map(k => `${k} ${typeof p[k] === 'object' ? '…' : str(p[k])}`).join(', ');
}

// The words a person typed, if this row carries any.
export function spokenWords(a: Activity): { text: string; by: string } | null {
  const p = parseObj(a.params);
  if (a.command === 'answer_ask') {
    const t = str(p.reason || p.note);
    return t ? { text: t, by: a.principal } : null;
  }
  return null;
}
