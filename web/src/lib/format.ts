// Formatting: money from integer cents (bigint-safe), business dates, and the
// plain-language names people see for actions, seats and principals.

const SYMBOL: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' };

// The connected company's currency (config.currency). The store sets it when the
// config row arrives, before any screen renders an amount; until then, dollars.
let defaultCurrency = 'USD';
export function setDefaultCurrency(code: string | null | undefined): boolean {
  const next = code && /^[A-Z]{3}$/.test(code) ? code : 'USD';
  if (next === defaultCurrency) return false;
  defaultCurrency = next;
  return true;
}
export function currencySymbol(code = defaultCurrency): string {
  return SYMBOL[code] ?? `${code} `;
}

export function toBig(v: bigint | number | string | null | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.round(v)) : 0n;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return 0n;
}

// Accounting style: negatives in parentheses, never in red (red means "stopped").
export function money(cents: bigint | number | string | null | undefined, opts: { currency?: string; parens?: boolean; sign?: boolean; whole?: boolean } = {}): string {
  const c = toBig(cents);
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const dollars = abs / 100n;
  const rest = abs % 100n;
  const symbol = currencySymbol(opts.currency ?? defaultCurrency);
  const body = `${symbol}${groupDigits(dollars.toString())}${opts.whole ? '' : `.${rest.toString().padStart(2, '0')}`}`;
  if (neg) return opts.parens === false ? `−${body}` : `(${body})`;
  return opts.sign && c > 0n ? `+${body}` : body;
}

function groupDigits(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function pct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function num(n: number | bigint): string {
  return groupDigits(String(n));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Business dates are YYYY-MM-DD strings with no time zone; never pass them through Date.
export function day(iso: string | undefined | null, withYear = false): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '—';
  const y = iso.slice(0, 4);
  const m = MONTHS[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7);
  const d = String(Number(iso.slice(8, 10)));
  return withYear ? `${m} ${d}, ${y}` : `${m} ${d}`;
}

export function weekday(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const t = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(t).getUTCDay()];
}

export function daysBetween(a: string, b: string): number {
  const t = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

export const SEATS = ['cash_app', 'collections', 'refunds', 'ap_clerk', 'payments'] as const;
// Which desk each seat sits on; payables arrived as a pack on the same kernel.
export const SEAT_DESK: Record<string, 'receivables' | 'payables'> = { cash_app: 'receivables', collections: 'receivables', refunds: 'receivables', ap_clerk: 'payables', payments: 'payables' };
export type SeatName = (typeof SEATS)[number];

export const SEAT_LABEL: Record<string, string> = {
  cash_app: 'Cash application',
  collections: 'Collections',
  refunds: 'Refunds',
  ap_clerk: 'Payables clerk',
  payments: 'Payments',
  mailroom: 'Mailroom',
};

export const ROLE_LABEL: Record<string, string> = {
  cash_app: 'Cash-application seat',
  collections: 'Collections seat',
  refunds: 'Refunds seat',
  ap_clerk: 'Payables-clerk seat',
  payments: 'Payments seat',
  controller: 'Controller',
  consultant: 'Field consultant',
  world: 'Outside system',
  evolver: 'Evolution engine',
  admin: 'Administrator',
  system: 'Kernel',
  outsider: 'Not on the team',
  auditor: 'Internal auditor',
};

export const ACTION_LABEL: Record<string, string> = {
  post_invoice: 'Post invoice',
  apply_receipt: 'Apply receipt',
  reverse_application: 'Reverse application',
  verdict_declined: 'Verdict declined',
  set_aside: 'Set aside',
  assess_fee: 'Assess fee',
  waive_fee: 'Waive fee',
  send_notice: 'Send notice',
  request_audit: 'Request audit',
  record_adjustment: 'Record adjustment',
  request_routing_change: 'Request bank change',
  endorse_routing_change: 'Endorse bank change',
  initiate_debit: 'Initiate debit',
  request_refund: 'Prepare refund',
  issue_refund: 'Release refund',
  write_off: 'Write off',
  approve: 'Approve',
  answer_ask: 'Answer question',
  propose_policy: 'Propose policy',
  propose_skill: 'Propose skill',
  activate_policy: 'Ratify policy',
  activate_skill: 'Move skill',
  hire_seat: 'Hire seat',
  file_finding: 'Internal audit',
  close_period: 'Close period',
  approve_bill: 'Approve bill',
  prepare_payment: 'Prepare payment',
  release_payment: 'Release payment',
  // non-action records
  charter_founded: 'Charter founded',
  bind_role: 'Bind role',
  load_company: 'Load company',
  email_received: 'Email received',
  hold_collection: 'Hold collection',
  decline_refund: 'Decline refund',
};

export const ACTION_VERB: Record<string, string> = {
  post_invoice: 'post invoices',
  apply_receipt: 'apply receipts',
  reverse_application: 'reverse applications',
  assess_fee: 'assess fees',
  waive_fee: 'waive fees',
  send_notice: 'send notices',
  request_audit: 'request audits',
  record_adjustment: 'record adjustments',
  request_routing_change: 'request bank changes',
  endorse_routing_change: 'endorse bank changes',
  initiate_debit: 'initiate debits',
  request_refund: 'prepare refunds',
  issue_refund: 'release refunds',
  write_off: 'write off balances',
  approve: 'approve',
  answer_ask: 'answer questions',
  propose_policy: 'propose policies',
  propose_skill: 'propose skills',
  activate_policy: 'ratify policies',
  activate_skill: 'move skills into service',
  hire_seat: 'hire seats',
  file_finding: 'report findings',
  close_period: 'close periods',
  approve_bill: 'approve bills',
  prepare_payment: 'prepare payments',
  release_payment: 'release payments',
};

// A person's answer as words to set inside “quotes”: snake_case spaced, inner quotes turned single.
export function answerWords(answer: string): string {
  return answer.replace(/_/g, ' ').replace(/"([^"]*)"/g, '‘$1’');
}

// Ask kinds may carry a domain after a colon (spot_check:underreport, correction:pre_chase).
export function askLabel(kind: string): string {
  const [base, domain] = kind.split(':');
  const label = ASK_LABEL[base] ?? sentence(base);
  return domain && base !== 'correction' && base !== 'spot_check' ? `${label}: ${domain.replace(/_/g, ' ')}` : label;
}

export const ASK_LABEL: Record<string, string> = {
  audit: 'Sales audit',
  callback: 'Callback',
  allocation: 'Apply a receipt',
  identify_payer: 'Identify a payer',
  unapplied_cash: 'Unapplied cash',
  misapplied: 'Cash applied to the wrong invoice?',
  label_check: 'Was that verdict a slip?',
  set_aside: 'Work set aside',
  collections: 'Collections',
  dispute: 'Dispute',
  refund_release: 'Release a refund',
  royalty_decrease: 'Royalty decrease',
  unknown_report: 'Unknown report',
  spot_check: 'Spot check',
  reading_conflict: 'Two readers disagree',
  finding: 'Audit finding',
  correction: 'Correction',
  bill_exception: 'Bill exception',
  payment_release: 'Release a payment',
};

export function commandLabel(kind: string, command: string): string {
  if (kind === 'ask') return `Asked: ${askLabel(command).toLowerCase()}`;
  if (kind === 'reliability') return ACTION_LABEL[command] ?? 'Inspection level';
  if (kind === 'evolution') return 'Evolution attempt';
  return ACTION_LABEL[command] ?? sentence(command);
}

export function sentence(snake: string): string {
  const s = snake.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface Actor {
  label: string;
  kind: 'person' | 'seat' | 'system' | 'evolver';
  role: string;
}

const SYSTEM_NAMES: Record<string, string> = {
  kernel: 'Kernel',
  inbox: 'Inbox',
  erp: 'ERP',
  'bank-feed': 'Bank feed',
  'auto-settlement': 'Auto-settlement',
  admin: 'Admin',
  founders: 'Founders',
  callback: 'Callback desk',
};

export function actor(principal: string, role = ''): Actor {
  if (principal.startsWith('seat:')) {
    const seat = principal.slice(5);
    return { label: SEAT_LABEL[seat] ?? sentence(seat), kind: 'seat', role: seat };
  }
  if (principal === 'bank feed') return { label: 'Bank feed', kind: 'system', role: 'world' };
  const [r, ...rest] = principal.split(':');
  const name = rest.join(':');
  if ((r === 'controller' || r === 'consultant') && name) return { label: name, kind: 'person', role: r };
  if (r === 'evolver') return { label: 'Evolution engine', kind: 'evolver', role: 'evolver' };
  if (r === 'auditor') return { label: 'Internal auditor', kind: 'system', role: 'auditor' };
  if (r === 'world' && name) return { label: sentence(name), kind: 'system', role: 'world' };
  if (r === 'admin' && name) return { label: 'Admin', kind: 'system', role: 'admin' };
  return { label: SYSTEM_NAMES[principal] ?? sentence(principal), kind: 'system', role: role || 'system' };
}

export function shortHash(h: string, n = 10): string {
  if (!h) return '';
  if (h === 'genesis') return 'genesis';
  return `${h.slice(0, n)}…`;
}

export function plural(n: number | bigint, one: string, many = `${one}s`): string {
  return `${num(n)} ${Number(n) === 1 ? one : many}`;
}

// Display-only tidying of sentences the module writes: thousands separators in
// dollar amounts, readable business dates, and a capital after a full stop.
export function prettyText(text: string): string {
  return text
    .replace(/\bstore:S0*(\d+):(\d{4}-\d{2}-\d{2})\b/g, (_m, n: string, iso: string) => `store ${n}, week of ${day(iso)}`)
    .replace(/\bentity:([A-Z][A-Z0-9-]*\d):(\d{4}-\d{2}-\d{2})\b/g, (_m, e: string, iso: string) => `${e} on ${day(iso)}`)
    .replace(/\bentity:([A-Z][A-Z0-9-]*\d)\b(?!:)/g, '$1')
    // rule references from the module: underreport@2#0 is its first rule, #-1 its otherwise branch
    .replace(/\b([a-z_]+@\d+)#(-?\d+)\b/g, (_m, k: string, i: string) => (i === '-1' ? `${k}, its otherwise branch` : `${k} rule ${Number(i) + 1}`))
    .replace(/([$£€])(\d{4,})(\.\d{2})?/g, (_m, sym: string, d: string, c = '') => `${sym}${groupDigits(d)}${c}`)
    // dates inside invoice numbers (R-S01-2026-01-05) stay as they are
    .replace(/(?<![\w-])(\d{4}-\d{2}-\d{2})\b/g, (_m, iso: string) => day(iso))
    .replace(/([.!?]) ([a-z])/g, (_m, p: string, ch: string) => `${p} ${ch.toUpperCase()}`);
}
