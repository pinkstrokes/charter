// Policy templates and their evaluator. Every rule the organization can hold —
// hand-written constitution or a policy promoted by evolution — is one of these
// templates, so the same text is executed here and encoded for the Z3 prover.

export const ACTIONS = [
  'post_invoice',
  'apply_receipt',
  'reverse_application',
  'assess_fee',
  'waive_fee',
  'send_notice',
  'request_audit',
  'record_adjustment',
  'request_routing_change',
  'endorse_routing_change',
  'initiate_debit',
  'request_refund',
  'issue_refund',
  'write_off',
  'approve',
  'answer_ask',
  'propose_policy',
  'propose_skill',
  'activate_policy',
  'activate_skill',
  'hire_seat',
  'file_finding',
  'close_period',
  'set_entity_status',
  'approve_bill',
  'prepare_payment',
  'release_payment',
] as const;
export type Action = (typeof ACTIONS)[number];

export const ROLES = ['cash_app', 'collections', 'refunds', 'ap_clerk', 'payments', 'controller', 'consultant', 'auditor', 'world', 'evolver', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  kind: 'seat' | 'human' | 'system';
  id: string; // seat name or identity hex
  role: Role;
}

export interface PolicyRequest {
  principal: Principal;
  action: Action;
  amountCents?: number;
  requestedBy?: string; // principal id that initiated the thing being acted on
  approvals?: number; // distinct approvals already recorded
  trustedFields?: Record<string, boolean>; // provenance of fields the action depends on
  facts?: Record<string, boolean>; // kernel-computed facts (fact library)
}

export type PolicyTemplate =
  | { t: 'role_can'; role: Role; actions: Action[] }
  | { t: 'human_only'; action: Action }
  | { t: 'sod'; action: Action }
  | { t: 'two_person_above'; action: Action; amountCents: number }
  | { t: 'require_fact'; action: Action; fact: string }
  | { t: 'forbid_when'; action: Action; fact: string }
  | { t: 'trusted_field'; action: Action; field: string };

export interface PolicyRule {
  id: string;
  version: number;
  tpl: PolicyTemplate;
  constitutional: boolean;
  text: string; // plain-language statement shown to people
}

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[]; // why it was denied (empty when allowed)
  permittedBy: string[]; // role_can rules that granted the action
  checked: string[]; // every rule id that applied to this action
}

// Facts the kernel knows how to compute; promoted policies may only reference these.
export const FACT_LIBRARY = {
  routing_verified: 'the counterparty bank account was confirmed by a call to the number on file before the change',
  routing_changed_unverified: 'a bank-account change is pending and has not been confirmed out of band',
  payment_in_transit: 'money from this counterparty arrived or is announced by a trusted source and is not yet applied',
  open_dispute: 'the counterparty has an open dispute on this balance',
  recent_return: 'a debit from this counterparty was returned in the last 14 days',
  within_grace: 'the invoice is still inside the contractual grace period',
  bankruptcy_flag: 'the counterparty or its guarantor is in bankruptcy',
  audit_open: 'a sales audit requested for one of this counterparty\'s stores has not been closed',
} as const;
export type FactName = keyof typeof FACT_LIBRARY;

function appliesTo(tpl: PolicyTemplate, action: Action): boolean {
  if (tpl.t === 'role_can') return tpl.actions.includes(action);
  return tpl.action === action;
}

export function evaluate(rules: PolicyRule[], req: PolicyRequest): PolicyDecision {
  const reasons: string[] = [];
  const permittedBy: string[] = [];
  const checked: string[] = [];
  for (const rule of rules) {
    const tpl = rule.tpl;
    if (!appliesTo(tpl, req.action)) continue;
    checked.push(rule.id);
    switch (tpl.t) {
      case 'role_can':
        if (tpl.role === req.principal.role) permittedBy.push(rule.id);
        break;
      case 'human_only':
        if (req.principal.kind !== 'human') reasons.push(`${rule.id}: only a person may ${req.action}`);
        break;
      case 'sod':
        if (req.requestedBy !== undefined && req.requestedBy === req.principal.id)
          reasons.push(`${rule.id}: whoever requested this cannot also ${req.action} it`);
        break;
      case 'two_person_above':
        if ((req.amountCents ?? 0) > tpl.amountCents && (req.approvals ?? 0) < 2)
          reasons.push(`${rule.id}: above ${tpl.amountCents} cents needs two approvals, has ${req.approvals ?? 0}`);
        break;
      case 'require_fact':
        if (req.facts?.[tpl.fact] !== true) reasons.push(`${rule.id}: requires ${tpl.fact}`);
        break;
      case 'forbid_when':
        if (req.facts?.[tpl.fact] === true) reasons.push(`${rule.id}: forbidden while ${tpl.fact}`);
        break;
      case 'trusted_field':
        if (req.trustedFields?.[tpl.field] !== true) reasons.push(`${rule.id}: ${tpl.field} must come from a trusted source`);
        break;
    }
  }
  if (permittedBy.length === 0) reasons.unshift(`no rule lets role ${req.principal.role} ${req.action}`);
  return { allowed: reasons.length === 0, reasons, permittedBy, checked };
}

// A promoted policy may only tighten: it must be a restriction template that
// references the fact library, never a new permission.
export function isTightening(tpl: PolicyTemplate): boolean {
  if (tpl.t === 'role_can') return false;
  if (tpl.t === 'require_fact' || tpl.t === 'forbid_when') return tpl.fact in FACT_LIBRARY;
  return true;
}

export const CONSTITUTION: PolicyRule[] = [
  { id: 'C1', version: 1, constitutional: true, tpl: { t: 'sod', action: 'approve' }, text: 'Whoever requests something cannot approve it.' },
  { id: 'C2', version: 1, constitutional: true, tpl: { t: 'sod', action: 'issue_refund' }, text: 'Whoever requests a refund cannot release it.' },
  { id: 'C3', version: 1, constitutional: true, tpl: { t: 'trusted_field', action: 'initiate_debit', field: 'bank_account' }, text: 'Money only moves through bank accounts that came from a trusted source.' },
  { id: 'C4', version: 1, constitutional: true, tpl: { t: 'trusted_field', action: 'issue_refund', field: 'bank_account' }, text: 'Refunds only go to bank accounts that came from a trusted source.' },
  { id: 'C5', version: 1, constitutional: true, tpl: { t: 'human_only', action: 'endorse_routing_change' }, text: 'Only a person can confirm a change of bank details.' },
  { id: 'C6', version: 1, constitutional: true, tpl: { t: 'human_only', action: 'activate_policy' }, text: 'Only a person can turn a proposed rule into a binding policy.' },
  { id: 'C7', version: 1, constitutional: true, tpl: { t: 'human_only', action: 'write_off' }, text: 'Only a person can write off a balance.' },
  { id: 'C8', version: 1, constitutional: true, tpl: { t: 'two_person_above', action: 'issue_refund', amountCents: 500_000 }, text: 'Refunds over $5,000 need two approvals.' },
  { id: 'C9', version: 1, constitutional: true, tpl: { t: 'forbid_when', action: 'send_notice', fact: 'bankruptcy_flag' }, text: 'No collection notices while the counterparty is in bankruptcy.' },
  { id: 'C10', version: 1, constitutional: true, tpl: { t: 'human_only', action: 'activate_skill' }, text: 'Only a person can put a new skill version in front of real work.' },
  { id: 'C11', version: 1, constitutional: true, tpl: { t: 'human_only', action: 'close_period' }, text: 'Only a person can close the books for a period.' },
  { id: 'C12', version: 1, constitutional: true, tpl: { t: 'trusted_field', action: 'release_payment', field: 'bank_account' }, text: 'Vendors are paid only to bank accounts that came from a trusted source.' },
  { id: 'C13', version: 1, constitutional: true, tpl: { t: 'sod', action: 'release_payment' }, text: 'Whoever prepares a payment cannot release it.' },
  { id: 'C14', version: 1, constitutional: true, tpl: { t: 'two_person_above', action: 'release_payment', amountCents: 2_500_000 }, text: 'Vendor payments over $25,000 need two approvals.' },
  { id: 'C15', version: 1, constitutional: true, tpl: { t: 'forbid_when', action: 'initiate_debit', fact: 'bankruptcy_flag' }, text: 'No debit is taken from a counterparty in bankruptcy (the automatic stay).' },
];

export const ROLE_MATRIX: PolicyRule[] = [
  { id: 'R-cash', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'cash_app', actions: ['post_invoice', 'apply_receipt', 'reverse_application', 'initiate_debit', 'request_audit', 'request_routing_change', 'record_adjustment'] }, text: 'The cash-application seat posts invoices, applies and reverses receipts, initiates scheduled debits and raises audit or bank-change requests.' },
  { id: 'R-coll', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'collections', actions: ['send_notice', 'assess_fee', 'request_audit', 'request_routing_change'] }, text: 'The collections seat sends notices and assesses contractual fees.' },
  { id: 'R-refund', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'refunds', actions: ['request_refund', 'request_routing_change'] }, text: 'The refunds seat prepares refunds of overpayments; someone else releases them.' },
  { id: 'R-ctrl', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'controller', actions: ['approve', 'answer_ask', 'waive_fee', 'write_off', 'endorse_routing_change', 'activate_policy', 'activate_skill', 'record_adjustment', 'issue_refund', 'hire_seat', 'close_period', 'approve_bill', 'release_payment', 'reverse_application', 'set_entity_status'] }, text: 'The controller approves, waives, writes off and ratifies policies.' },
  { id: 'R-cons', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'consultant', actions: ['answer_ask'] }, text: 'Field consultants answer questions about their stores.' },
  { id: 'R-ap', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'ap_clerk', actions: ['approve_bill', 'request_routing_change'] }, text: 'The payables clerk matches bills to orders and receipts and approves the ones that match.' },
  { id: 'R-pay', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'payments', actions: ['prepare_payment'] }, text: 'The payments seat prepares payment runs; someone else releases them.' },
  { id: 'R-audit', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'auditor', actions: ['file_finding'] }, text: 'The internal auditor reads everything and may only report what it finds.' },
  { id: 'R-evo', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'evolver', actions: ['propose_policy', 'propose_skill'] }, text: 'The evolution engine may propose, never activate.' },
  { id: 'R-erp', version: 1, constitutional: false, tpl: { t: 'role_can', role: 'world', actions: ['post_invoice'] }, text: 'The ERP books supply invoices, trade invoices and credit notes.' },
];
