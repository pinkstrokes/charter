// Charter module entry. Reducers are the only doors into the organization:
// people answer and ratify, the world feeds facts, anyone may send an email,
// and the seats run as procedures because they read mail with an LLM.
import { ScheduleAt } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { ask, seatTimer } from './schema';
import { TRUSTED_SOURCES, type EmailPayload } from './core/contracts';
import { sha256Hex } from './core/hash';
import type { SkillProgram } from './core/dsl';
import type { PolicyTemplate, Principal, Role } from './core/policy';
import { appendActivity, checkInvariants, Rejection, simDate, type Ctx, type Tx } from './kernel';
import type { ProcCtx } from './llm';
import { answerAsk, closeAudit, correctDecision, endorseRouting, raiseConcern, releaseRefund, waiveFee } from './answers';
import { decidePolicy, proposePolicy, proposeSkill, seedGovernance, setSkillStatus } from './governance';
import { cashAppCycle, collectionsCycle, refundsCycle, triage } from './seats';
import { ingest } from './world';

export default spacetimedb;

const SEATS = ['cash_app', 'collections', 'refunds'];

export const init = spacetimedb.init(ctx => {
  ctx.db.principal.insert({ identity: ctx.sender, role: 'admin', name: 'publisher' });
  freshCompany(ctx);
});

function freshCompany(tx: Tx): void {
  tx.db.config.insert({ id: 0, companyName: '', companyKind: 'franchisor', currency: 'USD', simDate: '2026-01-05', autopilot: false, llmModel: 'qwen3.8-flash' });
  tx.db.chainHead.insert({ id: 0, lastActivityId: 0n, hash: 'genesis', anchoredHash: '', anchoredAt: '' });
  seedGovernance(tx);
  for (const seat of ['cash_app', 'collections']) tx.db.seatState.insert({ seat, lastRunAt: '', status: 'active', runs: 0, lastSummary: '' });
}

// ---------- who is calling ----------

function caller(ctx: Ctx): Principal {
  const p = ctx.db.principal.identity.find(ctx.sender);
  if (!p) throw new SenderError('this identity has no role; ask the admin to bind one');
  const system = p.role === 'world' || p.role === 'evolver' || p.role === 'admin';
  return { kind: system ? 'system' : 'human', id: `${p.role}:${p.name}`, role: p.role as Role };
}

function requireRole(ctx: Ctx, ...roles: string[]): Principal {
  const who = caller(ctx);
  if (!roles.includes(who.role)) throw new SenderError(`${who.role} may not do this`);
  return who;
}

// Kernel rejections become client errors; policy denials do not throw, so the
// attempt stays on the record.
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Rejection) throw new SenderError(e.message);
    throw e;
  }
}

// ---------- administration ----------

export const bind_role = spacetimedb.reducer({ who: t.identity(), role: t.string(), name: t.string() }, (ctx, { who, role, name }) => {
  requireRole(ctx, 'admin');
  if (!['controller', 'consultant', 'world', 'evolver', 'admin'].includes(role)) throw new SenderError(`seats are code, not identities; cannot bind ${role}`);
  // A name belongs to one identity at a time; rebinding moves it.
  for (const p of [...ctx.db.principal.iter()]) if (p.name === name && p.role === role && !p.identity.equals(who)) ctx.db.principal.identity.delete(p.identity);
  const existing = ctx.db.principal.identity.find(who);
  if (existing) ctx.db.principal.identity.update({ identity: who, role, name });
  else ctx.db.principal.insert({ identity: who, role, name });
  appendActivity(ctx, { principal: 'admin', role: 'admin', kind: 'admin', command: 'bind_role', params: { who: who.toHexString().slice(0, 16), role, name }, outcome: 'committed' });
});

export const set_secret = spacetimedb.reducer({ key: t.string(), value: t.string() }, (ctx, { key, value }) => {
  requireRole(ctx, 'admin');
  if (ctx.db.secret.key.find(key)) ctx.db.secret.key.update({ key, value });
  else ctx.db.secret.insert({ key, value });
});

export const set_config = spacetimedb.reducer({ llmModel: t.string(), autopilot: t.bool() }, (ctx, { llmModel, autopilot }) => {
  requireRole(ctx, 'admin');
  const cfg = ctx.db.config.id.find(0)!;
  ctx.db.config.id.update({ ...cfg, llmModel: llmModel || cfg.llmModel, autopilot });
  if (autopilot && !cfg.autopilot) ctx.db.seatTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + 2_000_000n), seat: 'all' });
});

// Wipes the company but keeps identities, secrets and the LLM cache.
export const reset_company = spacetimedb.reducer(ctx => {
  requireRole(ctx, 'admin');
  for (const r of [...ctx.db.config.iter()]) ctx.db.config.id.delete(r.id);
  for (const r of [...ctx.db.entity.iter()]) ctx.db.entity.code.delete(r.code);
  for (const r of [...ctx.db.store.iter()]) ctx.db.store.code.delete(r.code);
  for (const r of [...ctx.db.contractVersion.iter()]) ctx.db.contractVersion.version.delete(r.version);
  for (const r of [...ctx.db.observation.iter()]) ctx.db.observation.id.delete(r.id);
  for (const r of [...ctx.db.fact.iter()]) ctx.db.fact.id.delete(r.id);
  for (const r of [...ctx.db.invoice.iter()]) ctx.db.invoice.id.delete(r.id);
  for (const r of [...ctx.db.receipt.iter()]) ctx.db.receipt.id.delete(r.id);
  for (const r of [...ctx.db.application.iter()]) ctx.db.application.id.delete(r.id);
  for (const r of [...ctx.db.journal.iter()]) ctx.db.journal.id.delete(r.id);
  for (const r of [...ctx.db.glBalance.iter()]) ctx.db.glBalance.account.delete(r.account);
  for (const r of [...ctx.db.controlTotal.iter()]) ctx.db.controlTotal.key.delete(r.key);
  for (const r of [...ctx.db.debitInstruction.iter()]) ctx.db.debitInstruction.id.delete(r.id);
  for (const r of [...ctx.db.routingRequest.iter()]) ctx.db.routingRequest.id.delete(r.id);
  for (const r of [...ctx.db.workItem.iter()]) ctx.db.workItem.id.delete(r.id);
  for (const r of [...ctx.db.ask.iter()]) ctx.db.ask.id.delete(r.id);
  for (const r of [...ctx.db.activity.iter()]) ctx.db.activity.id.delete(r.id);
  for (const r of [...ctx.db.chainHead.iter()]) ctx.db.chainHead.id.delete(r.id);
  for (const r of [...ctx.db.skill.iter()]) ctx.db.skill.key.delete(r.key);
  for (const r of [...ctx.db.policy.iter()]) ctx.db.policy.key.delete(r.key);
  for (const r of [...ctx.db.decision.iter()]) ctx.db.decision.id.delete(r.id);
  for (const r of [...ctx.db.refund.iter()]) ctx.db.refund.id.delete(r.id);
  for (const r of [...ctx.db.securityEvent.iter()]) ctx.db.securityEvent.id.delete(r.id);
  for (const r of [...ctx.db.seatState.iter()]) ctx.db.seatState.seat.delete(r.seat);
  for (const r of [...ctx.db.seatTimer.iter()]) ctx.db.seatTimer.scheduledId.delete(r.scheduledId);
  freshCompany(ctx);
});

interface CompanyFile {
  company: { name: string; kind: string; currency: string; startDate: string };
  contracts: { version: string; terms: unknown }[];
  entities: { code: string; name: string; kind: string; contactEmail: string; phoneOnFile: string; bankAccount: string; status?: string; country?: string }[];
  stores: { code: string; entityCode: string; name: string; city: string; contractVersion: string; consultant: string }[];
}

export const load_company = spacetimedb.reducer({ json: t.string() }, (ctx, { json }) => {
  requireRole(ctx, 'admin', 'world');
  const c = JSON.parse(json) as CompanyFile;
  const cfg = ctx.db.config.id.find(0)!;
  ctx.db.config.id.update({ ...cfg, companyName: c.company.name, companyKind: c.company.kind, currency: c.company.currency, simDate: c.company.startDate });
  for (const v of c.contracts) ctx.db.contractVersion.insert({ version: v.version, termsJson: JSON.stringify(v.terms) });
  for (const e of c.entities) ctx.db.entity.insert({ code: e.code, name: e.name, kind: e.kind, contactEmail: e.contactEmail, phoneOnFile: e.phoneOnFile, bankAccount: e.bankAccount, bankAccountTrusted: true, status: e.status ?? 'active', country: e.country ?? '' });
  for (const s of c.stores) ctx.db.store.insert({ ...s });
  appendActivity(ctx, { principal: 'admin', role: 'admin', kind: 'admin', command: 'load_company', params: { name: c.company.name, entities: c.entities.length, stores: c.stores.length, contracts: c.contracts.map(v => v.version) }, outcome: 'committed' });
});

export const anchor_chain = spacetimedb.reducer(ctx => {
  requireRole(ctx, 'admin');
  const head = ctx.db.chainHead.id.find(0)!;
  ctx.db.chainHead.id.update({ ...head, anchoredHash: head.hash, anchoredAt: simDate(ctx) });
});

// ---------- the outside world ----------

export const set_sim_date = spacetimedb.reducer({ date: t.string() }, (ctx, { date }) => {
  requireRole(ctx, 'admin', 'world');
  const cfg = ctx.db.config.id.find(0)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cfg.simDate) throw new SenderError(`business date can only move forward from ${cfg.simDate}`);
  ctx.db.config.id.update({ ...cfg, simDate: date });
  for (const a of [...ctx.db.ask.status.filter('open')]) if (a.deadline < date) ctx.db.ask.id.update({ ...a, status: 'expired' });
});

export const ingest_obs = spacetimedb.reducer(
  { kind: t.string(), source: t.string(), validAt: t.string(), refKey: t.string(), subject: t.string(), payload: t.string() },
  (ctx, { kind, source, validAt, refKey, subject, payload }) => {
    requireRole(ctx, 'world');
    if (!(TRUSTED_SOURCES as readonly string[]).includes(source) && source !== 'email') throw new SenderError(`unknown source ${source}`);
    if (kind === 'email' && source !== 'email') throw new SenderError('email always arrives as untrusted');
    guard(() => ingest(ctx, kind, source, validAt, refKey, subject, payload));
  }
);

// Anyone can email the company, including a judge pretending to be a franchisee.
export const send_email = spacetimedb.reducer(
  { from: t.string(), fromName: t.string(), subject: t.string(), body: t.string(), attachmentName: t.string(), attachmentText: t.string() },
  (ctx, { from, fromName, subject, body, attachmentName, attachmentText }) => {
    const p: EmailPayload = { messageId: '', from, fromName, to: 'ar@company', subject, body, attachments: attachmentName ? [{ name: attachmentName, text: attachmentText }] : [] };
    p.messageId = `<${sha256Hex(`${ctx.sender.toHexString()}|${ctx.timestamp.microsSinceUnixEpoch}|${subject}`).slice(0, 20)}@inbound>`;
    guard(() => ingest(ctx, 'email', 'email', simDate(ctx), `email:${p.messageId}`, `sender:${from}`, JSON.stringify(p)));
  }
);

// ---------- people ----------

export const answer_ask = spacetimedb.reducer({ askId: t.u64(), answer: t.string(), reason: t.string() }, (ctx, { askId, answer, reason }) => {
  const who = requireRole(ctx, 'controller', 'consultant');
  guard(() => answerAsk(ctx, who, askId, answer, reason));
});

export const release_refund = spacetimedb.reducer({ refundId: t.u64() }, (ctx, { refundId }) => {
  const who = requireRole(ctx, 'controller');
  guard(() => releaseRefund(ctx, who, refundId));
});

export const endorse_routing = spacetimedb.reducer({ requestId: t.u64() }, (ctx, { requestId }) => {
  const who = requireRole(ctx, 'controller');
  guard(() => endorseRouting(ctx, who, requestId));
});

export const waive_fee = spacetimedb.reducer({ invoiceId: t.string(), reason: t.string() }, (ctx, { invoiceId, reason }) => {
  const who = requireRole(ctx, 'controller');
  guard(() => waiveFee(ctx, who, invoiceId, [`reason:${reason}`]));
});

export const raise_concern = spacetimedb.reducer({ store: t.string(), week: t.string(), note: t.string() }, (ctx, { store, week, note }) => {
  const who = requireRole(ctx, 'consultant', 'controller');
  guard(() => raiseConcern(ctx, who, store, week, note));
});

export const correct_decision = spacetimedb.reducer({ decisionId: t.u64(), outcome: t.string(), reason: t.string() }, (ctx, { decisionId, outcome, reason }) => {
  const who = requireRole(ctx, 'controller', 'consultant');
  guard(() => correctDecision(ctx, who, decisionId, outcome, reason));
});

export const close_audit = spacetimedb.reducer({ store: t.string(), week: t.string(), auditedGrossCents: t.i64(), note: t.string() }, (ctx, { store, week, auditedGrossCents, note }) => {
  const who = requireRole(ctx, 'consultant', 'controller');
  guard(() => closeAudit(ctx, who, store, week, Number(auditedGrossCents), note));
});

// A new seat starts with everything the team already knows: the same skills and policies.
export const hire_seat = spacetimedb.reducer({ seat: t.string() }, (ctx, { seat }) => {
  const who = requireRole(ctx, 'controller');
  if (!SEATS.includes(seat)) throw new SenderError(`no such seat ${seat}`);
  guard(() => {
    const res = appendActivity(ctx, { principal: who.id, role: who.role, kind: 'command', command: 'hire_seat', params: { seat, inherits: { skills: [...ctx.db.skill.iter()].filter(s => s.status === 'active').map(s => s.key), policies: [...ctx.db.policy.iter()].filter(p => p.status === 'active').map(p => p.key) } }, outcome: 'committed' });
    const existing = ctx.db.seatState.seat.find(seat);
    if (existing) ctx.db.seatState.seat.update({ ...existing, status: 'active' });
    else ctx.db.seatState.insert({ seat, lastRunAt: '', status: 'active', runs: 0, lastSummary: `hired by ${who.id} (activity ${res})` });
  });
});

// ---------- the team's knowledge ----------

export const propose_skill = spacetimedb.reducer(
  { domain: t.string(), program: t.string(), parent: t.string(), provenance: t.string(), proof: t.string() },
  (ctx, { domain, program, parent, provenance, proof }) => {
    const who = requireRole(ctx, 'evolver');
    guard(() => proposeSkill(ctx, who, domain, JSON.parse(program) as SkillProgram, parent, provenance, proof));
  }
);

export const set_skill_status = spacetimedb.reducer({ key: t.string(), status: t.string(), fraction: t.f64() }, (ctx, { key, status, fraction }) => {
  const who = requireRole(ctx, 'controller');
  guard(() => setSkillStatus(ctx, who, key, status, fraction));
});

export const propose_policy = spacetimedb.reducer(
  { template: t.string(), text: t.string(), sourceSkill: t.string(), proof: t.string() },
  (ctx, { template, text, sourceSkill, proof }) => {
    const who = requireRole(ctx, 'evolver');
    guard(() => proposePolicy(ctx, who, JSON.parse(template) as PolicyTemplate, text, sourceSkill, proof));
  }
);

export const decide_policy = spacetimedb.reducer({ key: t.string(), approve: t.bool() }, (ctx, { key, approve }) => {
  const who = requireRole(ctx, 'controller');
  guard(() => decidePolicy(ctx, who, key, approve));
});

// ---------- the seats ----------

function runSeats(ctx: ProcCtx): string {
  const parts = [`triage ${triage(ctx)}`, `cash_app ${cashAppCycle(ctx)}`, `collections ${collectionsCycle(ctx)}`, `refunds ${refundsCycle(ctx)}`];
  const summary = parts.join(' | ');
  ctx.withTx(tx => {
    const today = simDate(tx);
    for (const s of [...tx.db.seatState.iter()]) if (s.status === 'active') tx.db.seatState.seat.update({ ...s, lastRunAt: today, runs: s.runs + 1, lastSummary: summary });
    const broken = checkInvariants(tx);
    if (broken.length) throw new Error(`invariants broken after seat run: ${broken.join('; ')}`);
  });
  return summary;
}

export const run_seats = spacetimedb.procedure({}, t.string(), ctx => {
  const role = ctx.withTx(tx => tx.db.principal.identity.find(ctx.sender)?.role ?? '');
  if (!['admin', 'world', 'controller'].includes(role)) throw new SenderError('only the admin, the world feeder or the controller can run the seats');
  return runSeats(ctx);
});

export const seat_tick = spacetimedb.procedure({ onSchedule: seatTimer }, { timer: seatTimer.rowType }, t.unit(), (ctx, { timer }) => {
  runSeats(ctx);
  ctx.withTx(tx => {
    if (tx.db.config.id.find(0)?.autopilot) tx.db.seatTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(tx.timestamp.microsSinceUnixEpoch + 5_000_000n), seat: timer.seat });
  });
  return {};
});

// ---------- views ----------

export const my_asks = spacetimedb.view({ name: 'my_asks', public: true }, t.array(ask.rowType), ctx => {
  const role = ctx.db.principal.identity.find(ctx.sender)?.role ?? '';
  return [...ctx.db.ask.status.filter('open')].filter(a => role === 'controller' || a.toRole === role);
});
