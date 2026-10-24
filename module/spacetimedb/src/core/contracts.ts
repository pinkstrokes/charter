// Shared data contracts between the world simulator, the database module, the
// evolution tools and the web client. Pure types and constants only: this file
// must not import from 'spacetimedb' so Node tools can use it directly.

export type Cents = number; // integer minor units (cents or pence)

export type CompanyKind = 'franchisor' | 'wholesaler';

export interface ContractTerms {
  version: string; // e.g. 'FA-2019'
  royaltyBp: number; // basis points of gross sales (600 = 6.00%)
  graceDays: number; // days after due date before a late fee may be assessed
  lateFeeCents: Cents; // flat fee per past-due invoice
  interestBpPerMonth: number; // simple monthly interest on past-due balance
  nsfFeeCents: Cents; // fee when a debit is returned
  auditThresholdBp: number; // underreporting above this shifts audit cost to the franchisee
  paymentTermsDays: number; // royalty due this many days after the sales week closes
  applicationOrder: InvoiceKind[]; // how a payment is applied when it does not match exactly
  smallBalanceCents?: Cents; // a payment may leave this much open (bank charges, exchange rates); a person writes it off rather than chasing it
}

export type InvoiceKind = 'interest' | 'fee' | 'royalty' | 'supply' | 'trade' | 'audit';

export type ObservationKind =
  | 'email'
  | 'processor_settlement'
  | 'supply_invoice'
  | 'bank_txn'
  | 'callback'
  | 'trade_invoice'
  | 'credit_note';

// Sources the kernel treats as authoritative for the facts they carry.
export const TRUSTED_SOURCES = ['bank', 'processor', 'erp', 'callback_desk'] as const;
export type Source = (typeof TRUSTED_SOURCES)[number] | 'email';

export interface EmailPayload {
  messageId: string;
  from: string; // address as it appears in the header
  fromName: string;
  to: string;
  subject: string;
  body: string;
  attachments: { name: string; text: string }[];
}

export interface ProcessorSettlementPayload {
  storeCode: string;
  businessDate: string; // YYYY-MM-DD
  cardGrossCents: Cents;
  feesCents: Cents;
  netCents: Cents;
}

export interface SupplyInvoicePayload {
  invoiceNo: string;
  storeCode: string;
  entityCode: string;
  date: string;
  dueDate: string;
  lines: { sku: string; qty: number; unitCents: Cents }[];
  totalCents: Cents;
  impliedDrinks: number; // cups + pearls ordered imply roughly this many drinks
}

export type BankTxnType =
  | 'ach_debit_settled'
  | 'ach_debit_returned'
  | 'wire_in'
  | 'ach_credit_in'
  | 'check_deposit'
  | 'refund_out'
  | 'bank_fee';

export interface BankTxnPayload {
  txnId: string;
  date: string;
  type: BankTxnType;
  amountCents: Cents; // always positive; direction implied by type
  counterpartyName: string;
  counterpartyAccount: string; // masked, e.g. '****4417'
  reference: string; // free text the payer typed, often incomplete
  returnCode?: string; // R01, R02, R10 ...
  originalTxnId?: string; // for returns
  debitId?: string; // the debit instruction this settles or returns
}

export interface CallbackPayload {
  entityCode: string;
  phoneUsed: string;
  phoneSource: 'master_data_asof' | 'email';
  outcome: 'confirmed' | 'denied' | 'no_answer';
  note: string;
}

export interface TradeInvoicePayload {
  invoiceNo: string;
  customerCode: string;
  date: string;
  dueDate: string;
  netCents: Cents;
  lines: number;
}

export interface CreditNotePayload {
  creditNo: string;
  customerCode: string;
  date: string;
  amountCents: Cents;
  linkedInvoiceNo: string | null;
  reason: string;
}

// What the world simulator knows to be true. Only the evaluator reads this;
// it is never loaded into the database the agents work in.
export interface AnswerKeyEntry {
  caseId: string;
  family: ScenarioFamily;
  split: Split;
  subject: string; // store, entity, invoice or message the truth is about
  truth: Record<string, string | number | boolean>;
  expected: string; // the decision a correct finance team makes
}

export type Split = 'train' | 'val' | 'test' | 'live';

export type ScenarioFamily =
  | 'clean'
  | 'underreported_cash'
  | 'bundled_payment'
  | 'short_payment'
  | 'ach_return'
  | 'payment_in_transit'
  | 'late_fee_dispute'
  | 'routing_change_legit'
  | 'routing_change_fraud'
  | 'prompt_injection'
  | 'revised_report'
  | 'payer_alias'
  | 'credit_note_netting';
