// The kernel: the only path by which anything changes. Every command is checked
// against the active policies (constitution + role matrix + promoted policies),
// its machine-checkable claims are verified, ledger invariants are enforced,
// and the attempt — allowed or denied — is appended to the hash chain.
import type { InferSchema, ReducerCtx } from 'spacetimedb/server';
import type spacetimedb from './schema';
import { evaluate, type Action, type PolicyRule, type PolicyTemplate, type Principal } from './core/policy';
import { canonical, chainHash } from './core/hash';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
// Procedures hand kernel functions a transaction context with the same db shape.
export type Tx = Pick<Ctx, 'db' | 'timestamp'>;

export class Rejection extends Error {}

export const ACCOUNTS: Record<string, string> = {
  '1000': 'Cash',
  '1100': 'Accounts receivable — royalties / trade',
  '1110': 'Accounts receivable — supplies',
  '1120': 'Accounts receivable — fees and interest',
  '1190': 'Allowance for doubtful accounts',
  '1300': 'Inventory',
  '2000': 'Accounts payable',
  '2100': 'Unapplied cash',
  '2200': 'Customer credits',
  '4000': 'Royalty / sales revenue',
  '4050': 'Sales returns and allowances',
  '4100': 'Supply sales',
  '4200': 'Late fee and interest income',
  '6000': 'Bad debt expense',
  '6100': 'Bank charges and payment differences',
};

export const AR_ACCOUNT_BY_KIND: Record<string, string> = {
  royalty: '1100',
  trade: '1100',
  audit: '1100',
  supply: '1110',
  fee: '1120',
  interest: '1120',
};

// A number a seat asserts. The kernel re-derives the right-hand side, adding the
// open balance of any invoices named, from the ledger itself.
export interface Claim {
  label: string;
  lhs: number;
  rhs: number[];
  invoices?: string[];
  bills?: string[];
  tolerance: number; // |lhs - (sum(rhs) + open(invoices))| <= tolerance
}

export interface ExecInput {
  principal: Principal;
  action: Action;
  params: object;
  used?: string[];
  plan?: string[];
  claims?: Claim[];
  amountCents?: number;
  requestedBy?: string;
  approvals?: number;
  trustedFields?: Record<string, boolean>;
  facts?: Record<string, boolean>;
}

// What the policy check saw, kept on the record so a proposed policy can be
// replayed against every past request of the same action.
export interface RequestContext {
  amountCents?: number;
  requestedBy?: string;
  approvals?: number;
  trustedFields?: Record<string, boolean>;
  facts?: Record<string, boolean>;
  principalKind?: string;
}

export interface ExecResult {
  ok: boolean;
  activityId: bigint;
  reasons: string[];
  summary: string;
}

export function simDate(tx: Tx): string {
  return tx.db.config.id.find(0)?.simDate ?? '1970-01-01';
}

export function activePolicies(tx: Tx): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const p of tx.db.policy.iter()) {
    if (p.status !== 'active') continue;
    rules.push({ id: p.policyId, version: p.version, tpl: JSON.parse(p.template) as PolicyTemplate, constitutional: p.constitutional, text: p.text });
  }
  return rules;
}

export function appendActivity(
  tx: Tx,
  rec: { principal: string; role: string; kind: string; command: string; params: unknown; used?: string[]; plan?: string[]; outcome: string; reasons?: string[]; claims?: Claim[]; context?: RequestContext }
): bigint {
  const head = tx.db.chainHead.id.find(0) ?? { id: 0, lastActivityId: 0n, hash: 'genesis', anchoredHash: '', anchoredAt: '' };
  const body = {
    at: simDate(tx),
    principal: rec.principal,
    role: rec.role,
    kind: rec.kind,
    command: rec.command,
    params: rec.params,
    used: rec.used ?? [],
    plan: rec.plan ?? [],
    outcome: rec.outcome,
    reasons: rec.reasons ?? [],
    claims: rec.claims ?? [],
    context: rec.context ?? {},
  };
  const hash = chainHash(head.hash, body);
  const row = tx.db.activity.insert({
    id: 0n,
    at: body.at,
    wall: tx.timestamp,
    principal: rec.principal,
    role: rec.role,
    kind: rec.kind,
    command: rec.command,
    // Stored canonically so any verifier can rebuild the hashed record from the row.
    params: canonical(rec.params),
    used: canonical(body.used),
    plan: canonical(body.plan),
    outcome: rec.outcome,
    reasons: canonical(body.reasons),
    claims: canonical(body.claims),
    context: canonical(body.context),
    prevHash: head.hash,
    hash,
  });
  const next = { ...head, lastActivityId: row.id, hash };
  if (tx.db.chainHead.id.find(0)) tx.db.chainHead.id.update(next);
  else tx.db.chainHead.insert(next);
  return row.id;
}

function checkClaims(tx: Tx, claims: Claim[] | undefined): string[] {
  const failures: string[] = [];
  for (const c of claims ?? []) {
    let total = c.rhs.reduce((s, x) => s + x, 0);
    for (const id of c.invoices ?? []) total += Number(tx.db.invoice.id.find(id)?.openCents ?? 0n);
    for (const id of c.bills ?? []) total += Number(tx.db.bill.id.find(id)?.openCents ?? 0n);
    if (Math.abs(c.lhs - total) > c.tolerance) failures.push(`claim "${c.label}" failed: ${c.lhs} vs ${total}`);
  }
  return failures;
}

// Run a command through policy, claims, the handler and invariants. Denials and
// rejections are recorded and returned; invariant violations throw so the whole
// transaction rolls back.
export function exec(tx: Tx, input: ExecInput, handler: (activityId: bigint) => string): ExecResult {
  const decision = evaluate(activePolicies(tx), {
    principal: input.principal,
    action: input.action,
    amountCents: input.amountCents,
    requestedBy: input.requestedBy,
    approvals: input.approvals,
    trustedFields: input.trustedFields,
    facts: input.facts,
  });
  const claimFailures = checkClaims(tx, input.claims);
  const reasons = [...decision.reasons, ...claimFailures];
  const context: RequestContext = { amountCents: input.amountCents, requestedBy: input.requestedBy, approvals: input.approvals, trustedFields: input.trustedFields, facts: input.facts, principalKind: input.principal.kind };
  const plan = [...(input.plan ?? []), ...decision.permittedBy, ...decision.checked.filter(id => !decision.permittedBy.includes(id))];
  if (reasons.length > 0) {
    const id = appendActivity(tx, {
      principal: input.principal.id,
      role: input.principal.role,
      kind: 'denied',
      command: input.action,
      params: input.params,
      used: input.used,
      plan,
      outcome: 'denied',
      reasons,
      claims: input.claims,
      context,
    });
    return { ok: false, activityId: id, reasons, summary: reasons[0] };
  }
  const headBefore = tx.db.chainHead.id.find(0);
  const record = {
    principal: input.principal.id,
    role: input.principal.role,
    kind: 'command',
    command: input.action,
    params: input.params,
    used: input.used,
    plan,
    outcome: 'committed',
    claims: input.claims,
    context,
  };
  const activityId = appendActivity(tx, record);
  let summary: string;
  try {
    summary = handler(activityId);
  } catch (e) {
    if (e instanceof Rejection) {
      // Handlers throw Rejection before mutating anything. Drop the hashed row and
      // chain a 'rejected' one instead, so the chain never contains an edited row.
      tx.db.activity.id.delete(activityId);
      if (headBefore) tx.db.chainHead.id.update(headBefore);
      const id = appendActivity(tx, { ...record, kind: 'rejected', outcome: 'rejected', reasons: [e.message] });
      return { ok: false, activityId: id, reasons: [e.message], summary: e.message };
    }
    throw e;
  }
  const violations = checkInvariants(tx);
  if (violations.length > 0) throw new Error(`invariant violated, transaction rolled back: ${violations.join('; ')}`);
  return { ok: true, activityId, reasons: [], summary };
}

// ---------- ledger ----------

export interface Line {
  account: string;
  debit?: number;
  credit?: number;
  entity?: string;
  memo: string;
}

export function post(tx: Tx, jeId: string, lines: Line[], activityId: bigint): void {
  const debits = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const credits = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (debits !== credits) throw new Error(`journal ${jeId} unbalanced: ${debits} vs ${credits}`);
  const period = simDate(tx).slice(0, 7);
  // A closed month is never written to; later knowledge is booked in the open month.
  if (tx.db.periodClose.period.find(period)) throw new Error(`journal ${jeId}: period ${period} is closed`);
  for (const l of lines) {
    if (!(l.account in ACCOUNTS)) throw new Error(`unknown account ${l.account}`);
    const d = BigInt(l.debit ?? 0);
    const c = BigInt(l.credit ?? 0);
    tx.db.journal.insert({ id: 0n, jeId, account: l.account, debitCents: d, creditCents: c, entityCode: l.entity ?? '', memo: l.memo, period, activityId });
    const bal = tx.db.glBalance.account.find(l.account);
    if (bal) tx.db.glBalance.account.update({ ...bal, debitCents: bal.debitCents + d, creditCents: bal.creditCents + c });
    else tx.db.glBalance.insert({ account: l.account, name: ACCOUNTS[l.account], debitCents: d, creditCents: c });
  }
}

export function bumpControl(tx: Tx, key: string, delta: number | bigint): void {
  const d = typeof delta === 'bigint' ? delta : BigInt(delta);
  const row = tx.db.controlTotal.key.find(key);
  if (row) tx.db.controlTotal.key.update({ key, cents: row.cents + d });
  else tx.db.controlTotal.insert({ key, cents: d });
}

function gl(tx: Tx, account: string): bigint {
  const b = tx.db.glBalance.account.find(account);
  return b ? b.debitCents - b.creditCents : 0n;
}

function control(tx: Tx, key: string): bigint {
  return tx.db.controlTotal.key.find(key)?.cents ?? 0n;
}

export function checkInvariants(tx: Tx): string[] {
  const out: string[] = [];
  let debits = 0n;
  let credits = 0n;
  for (const b of tx.db.glBalance.iter()) {
    debits += b.debitCents;
    credits += b.creditCents;
  }
  if (debits !== credits) out.push(`trial balance off by ${debits - credits}`);
  const arMain = control(tx, 'ar_royalty') + control(tx, 'ar_trade') + control(tx, 'ar_audit');
  if (gl(tx, '1100') !== arMain) out.push(`AR control 1100 ${gl(tx, '1100')} != open royalty/trade invoices ${arMain}`);
  if (gl(tx, '1110') !== control(tx, 'ar_supply')) out.push(`AR control 1110 != open supply invoices`);
  if (gl(tx, '1120') !== control(tx, 'ar_fee') + control(tx, 'ar_interest')) out.push(`AR control 1120 != open fee invoices`);
  if (-gl(tx, '2100') !== control(tx, 'unapplied')) out.push(`unapplied cash ${-gl(tx, '2100')} != receipts not yet applied ${control(tx, 'unapplied')}`);
  if (gl(tx, '1000') !== control(tx, 'bank')) out.push(`cash ${gl(tx, '1000')} != bank statement ${control(tx, 'bank')}`);
  if (-gl(tx, '2000') !== control(tx, 'ap_open')) out.push(`AP control 2000 ${-gl(tx, '2000')} != approved unpaid bills ${control(tx, 'ap_open')}`);
  return out;
}

// ---------- fact library ----------

export function factsFor(tx: Tx, entityCode: string): Record<string, boolean> {
  const today = simDate(tx);
  const e = tx.db.entity.code.find(entityCode);
  const pendingRouting = [...tx.db.routingRequest.entityCode.filter(entityCode)].some(r => r.status === 'held');
  const unapplied = [...tx.db.receipt.entityCode.filter(entityCode)].some(r => r.unappliedCents > 0n);
  const disputed = [...tx.db.invoice.entityCode.filter(entityCode)].some(i => i.status === 'disputed');
  const returned = [...tx.db.debitInstruction.entityCode.filter(entityCode)].some(
    d => d.status === 'returned' && daysApart(d.scheduledFor, today) <= 14
  );
  const audits = new Map<string, string>();
  for (const f of [...tx.db.fact.subject.filter(`entity:${entityCode}`)].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (f.attr !== 'audit') continue;
    const v = JSON.parse(f.value) as { store: string; week: string; status: string };
    audits.set(`${v.store}:${v.week}`, v.status);
  }
  return {
    routing_verified: !!e && e.bankAccountTrusted && !pendingRouting,
    routing_changed_unverified: pendingRouting,
    payment_in_transit: unapplied,
    open_dispute: disputed,
    recent_return: returned,
    bankruptcy_flag: e?.status === 'bankrupt',
    audit_open: [...audits.values()].includes('open'),
  };
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000;
}
