// The proof page's numbers, computed from the database and the answer key:
// how each skill generation scores on the locked test split, how often the team
// was wrong when it did not ask, money recovered, attacks stopped, ledger
// invariants, and an independent re-verification of the activity hash chain.
//   npx tsx tools/evolve/report.ts --db charter-a
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseTreatments, run, settlesAlone, type FeatureMap, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { chainHash } from '../../module/spacetimedb/src/core/hash';
import { upper95 } from '../../module/spacetimedb/src/core/stats';
import { Db, evolverToken, parseJson, type Row } from './lib';
import { agrees, graded, type Domain } from './skills';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');
const DB = args.get('db') ?? 'charter-iqwfr';
const DIR = args.get('data') ?? (DB === 'charter-a' ? 'data/companyA' : DB === 'charter-b' ? 'data/companyB' : 'data/dev');


function domainOf(subject: string): Domain | null {
  if (subject.startsWith('store:')) return 'underreport';
  if (subject.startsWith('receipt:')) return 'allocation';
  if (subject.startsWith('entity:')) return 'pre_chase';
  if (subject.startsWith('routing:')) return 'routing_change';
  if (subject.startsWith('bill:')) return 'bill_match';
  return null;
}

async function main(): Promise<void> {
  const db = new Db(DB, await evolverToken(DB));
  const keyPath = `${DIR}/answer_key.json`;
  const keyRaw = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) : [];
  const key = (Array.isArray(keyRaw) ? keyRaw : keyRaw.entries ?? []) as { caseId: string; family: string; split: string; subject: string; expected: string; truth?: { invoices?: string[] } }[];
  const [decisions, skills, activity, gl, controls, invoices, security, refunds, applications, policies, asks, bills, receipts] = await Promise.all([
    db.sql('SELECT id, at, domain, subject, features, skill_key, outcome, shadow, treatments FROM decision'),
    db.sql('SELECT key, domain, version, status, program, created_at FROM skill'),
    db.sql('SELECT id, at, principal, role, kind, command, params, used, plan, outcome, reasons, claims, context, prev_hash, hash FROM activity'),
    db.sql('SELECT account, debit_cents, credit_cents FROM gl_balance'),
    db.sql('SELECT key, cents FROM control_total'),
    db.sql('SELECT id, kind, amount_cents, open_cents, status FROM invoice'),
    db.sql('SELECT kind, subject FROM security_event'),
    db.sql('SELECT entity_code, amount_cents, bank_account, status FROM refund'),
    db.sql('SELECT receipt_id, invoice_id, activity_id, reversed FROM application'),
    db.sql('SELECT key, policy_id, status, text, template, source_skill, approved_by, approved_at, proof FROM policy'),
    db.sql('SELECT id, created_at, kind, status, evidence FROM ask'),
    db.sql('SELECT id, amount_cents, status FROM bill'),
    db.sql('SELECT id FROM receipt'),
  ]);
  const latest = new Map<string, Row>();
  for (const d of decisions.sort((a, b) => a.id - b.id)) if (!d.shadow) latest.set(d.subject, d);

  // Where cash actually landed, for receipts the answer key knows the truth of.
  const appliedTo = new Map<string, Set<string>>();
  for (const a of applications) if (!a.reversed) (appliedTo.get(a.receipt_id) ?? appliedTo.set(a.receipt_id, new Set()).get(a.receipt_id)!).add(a.invoice_id);
  const landedRight = (e: { subject: string; truth?: { invoices?: string[] } }) =>
    [...(appliedTo.get(e.subject.slice(8)) ?? new Set<string>())].sort().join(',') === [...(e.truth?.invoices ?? [])].sort().join(',');

  // 1. How the team actually decided, by split and family.
  const outcomes: Record<string, Record<string, { n: number; right: number; missing: number }>> = {};
  const auto: Record<string, { n: number; wrong: number }> = {};
  for (const e of key) {
    const domain = domainOf(e.subject);
    if (!domain) continue;
    const cell = ((outcomes[e.split] ??= {})[e.family] ??= { n: 0, right: 0, missing: 0 });
    cell.n++;
    const d = latest.get(e.subject);
    if (!d) {
      cell.missing++;
      continue;
    }
    // Cash application is right when the money landed on the right invoices.
    const right = domain === 'allocation' && (e as { truth?: { invoices?: string[] } }).truth?.invoices ? landedRight(e as never) : agrees(domain, d.outcome, e.expected);
    if (right) cell.right++;
    if (settlesAlone(domain, d.outcome, parseTreatments(d.treatments)) && (e.split === 'test' || e.split === 'live')) {
      const a = (auto[domain] ??= { n: 0, wrong: 0 });
      a.n++;
      if (!right) a.wrong++;
    }
  }
  // Cash application judged by where the money landed, not by the outcome label.
  const landed: Record<string, Record<string, { n: number; right: number }>> = {};
  // Only money that has arrived: payments the world schedules after the last day are not judged.
  const arrived = new Set(receipts.map(r => `receipt:${r.id}`));
  for (const e of key as { split: string; family: string; subject: string; truth?: { invoices?: string[] } }[]) {
    if (!e.subject.startsWith('receipt:') || !e.truth?.invoices || !arrived.has(e.subject)) continue;
    const got = [...(appliedTo.get(e.subject.slice(8)) ?? new Set<string>())].sort().join(',');
    const cell = ((landed[e.split] ??= {})[e.family] ??= { n: 0, right: 0 });
    cell.n++;
    if (got === [...e.truth.invoices].sort().join(',')) cell.right++;
  }
  const knowingWhenToAsk = Object.fromEntries(Object.entries(auto).map(([d, a]) => [d, { handledAlone: a.n, wrong: a.wrong, upper95: upper95(a.wrong, a.n) }]));

  // 2. Every generation of every skill, scored on the locked test split with the features the seats saw.
  const generations = skills
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.version - b.version)
    .map(s => {
      const program = JSON.parse(s.program) as SkillProgram;
      // Right as graded; alone when the version settles the case without a person, wrong when alone and not right.
      const byFamily: Record<string, { n: number; right: number; alone: number; wrong: number }> = {};
      const domain = s.domain as Domain;
      for (const e of key) {
        if (e.split !== 'test' || domainOf(e.subject) !== domain) continue;
        const d = latest.get(e.subject);
        if (!d) continue;
        const c = (byFamily[e.family] ??= { n: 0, right: 0, alone: 0, wrong: 0 });
        c.n++;
        const out = run(program, parseJson<FeatureMap>(d.features, {})).outcome.decide;
        const t = parseTreatments(d.treatments);
        const right = graded(domain, out, e.expected, e.truth?.invoices, t);
        if (right) c.right++;
        if (settlesAlone(domain, out, t)) {
          c.alone++;
          if (!right) c.wrong++;
        }
      }
      const live = activity.find(a => a.command === 'activate_skill' && a.outcome === 'committed' && parseJson<{ key?: string; to?: string }>(a.params, {}).key === s.key && parseJson<{ to?: string }>(a.params, {}).to === 'active');
      return { key: s.key, status: s.status, createdAt: s.created_at, activatedAt: live?.at ?? null, test: byFamily };
    });

  // 3. Ledger invariants against independently maintained totals.
  const bal = (acct: string) => {
    const r = gl.find(g => g.account === acct);
    return r ? r.debit_cents - r.credit_cents : 0;
  };
  const ctl = (k: string) => controls.find(c => c.key === k)?.cents ?? 0;
  const invariants = {
    trialBalance: gl.reduce((s, g) => s + g.debit_cents - g.credit_cents, 0) === 0,
    arRoyaltyTrade: bal('1100') === ctl('ar_royalty') + ctl('ar_trade') + ctl('ar_audit'),
    arSupply: bal('1110') === ctl('ar_supply'),
    arFees: bal('1120') === ctl('ar_fee') + ctl('ar_interest'),
    unapplied: -bal('2100') === ctl('unapplied'),
    cashEqualsBank: bal('1000') === ctl('bank'),
  };

  // 4. Re-verify the hash chain from the stored rows, outside the database.
  const acts = activity.sort((a, b) => a.id - b.id);
  let prev = 'genesis';
  let verified = 0;
  let firstBreak: number | null = null;
  for (const a of acts) {
    const body = {
      at: a.at, principal: a.principal, role: a.role, kind: a.kind, command: a.command,
      params: JSON.parse(a.params), used: JSON.parse(a.used), plan: JSON.parse(a.plan), outcome: a.outcome,
      reasons: JSON.parse(a.reasons), claims: JSON.parse(a.claims), context: JSON.parse(a.context || '{}'),
    };
    if (a.prev_hash === prev && chainHash(prev, body) === a.hash) verified++;
    else if (firstBreak === null) firstBreak = a.id;
    prev = a.hash;
  }

  // Learned policies: where they came from and every attempt they have stopped since.
  const learned = policies
    .filter(p => String(p.policy_id).startsWith('P-'))
    .map(p => {
      const blocked = acts.filter(a => a.outcome === 'denied' && (JSON.parse(a.reasons) as string[]).some(r => r.startsWith(`${p.policy_id}:`)));
      const proof = parseJson<{ wouldHaveStopped?: unknown[]; extendsFrom?: string | null }>(p.proof, {});
      return {
        key: p.key, status: p.status, text: p.text, template: JSON.parse(p.template), source: p.source_skill, approvedBy: p.approved_by, approvedAt: p.approved_at,
        learnedFrom: proof.wouldHaveStopped ?? [], extendsFrom: proof.extendsFrom ?? null,
        blocked: blocked.map(a => ({ activity: a.id, at: a.at, by: a.principal, action: a.command })),
      };
    });
  // How the team changes month by month: what it settles alone, how often it needs a person,
  // and how often its own decisions were right where the answer key knows.
  // Each decision is graded in the month it was made, by what it did itself: for
  // cash application, the invoices its own apply_receipt commands put money on,
  // even if a person later reversed them.
  const keyBySubject = new Map(key.map(e => [e.subject, e]));
  const decisionOf = new Map<number, number>();
  for (const a of acts) {
    if (a.command !== 'apply_receipt' || a.outcome !== 'committed') continue;
    const ref = (JSON.parse(a.used) as string[]).find(u => u.startsWith('decision:'));
    if (ref) decisionOf.set(Number(a.id), Number(ref.slice(9)));
  }
  const placedBy = new Map<number, Set<string>>();
  for (const a of applications) {
    const dec = decisionOf.get(Number(a.activity_id));
    if (dec !== undefined) (placedBy.get(dec) ?? placedBy.set(dec, new Set()).get(dec)!).add(a.invoice_id);
  }
  type Cell = { decisions: number; alone: number; aloneGraded: number; aloneRight: number; questions: number };
  const blank = (): Cell => ({ decisions: 0, alone: 0, aloneGraded: 0, aloneRight: 0, questions: 0 });
  const trend: Record<string, Record<string, Cell>> = {};
  const ASK_DOMAIN: Record<string, string> = { audit: 'underreport', allocation: 'allocation', identify_payer: 'allocation', unapplied_cash: 'allocation', misapplied: 'allocation', collections: 'pre_chase', callback: 'routing_change', bill_exception: 'bill_match', payment_release: 'payments', refund_release: 'refunds' };
  for (const d of decisions) {
    if (d.shadow) continue;
    const m = String(d.at).slice(0, 7);
    const t = ((trend[m] ??= {})[d.domain] ??= blank());
    t.decisions++;
    const domain = d.domain as Domain;
    if (!settlesAlone(domain, d.outcome, parseTreatments(d.treatments))) continue;
    t.alone++;
    const e = keyBySubject.get(d.subject);
    if (!e) continue;
    t.aloneGraded++;
    const truth = (e as { truth?: { invoices?: string[] } }).truth?.invoices;
    const right = domain === 'allocation' && truth ? [...(placedBy.get(Number(d.id)) ?? [])].sort().join(',') === [...truth].sort().join(',') : agrees(domain, d.outcome, e.expected);
    if (right) t.aloneRight++;
  }
  for (const a of asks) {
    const dom = a.kind === 'label_check' ? parseJson<{ domain?: string }>(a.evidence, {}).domain : ASK_DOMAIN[a.kind];
    if (!dom) continue;
    const m = String(a.created_at).slice(0, 7);
    ((trend[m] ??= {})[dom] ??= blank()).questions++;
  }
  const duplicateBills = new Set(key.filter(e => e.family === 'bill_duplicate').map(e => e.subject.slice(5)));
  const report = {
    db: DB,
    generatedAt: new Date().toISOString(),
    answerKeyEntries: key.length,
    outcomes,
    cashLanded: landed,
    learnedPolicies: learned,
    knowingWhenToAsk,
    generations,
    trend: Object.entries(trend)
      .sort()
      .map(([month, byDomain]) => ({
        month,
        domains: Object.fromEntries(Object.entries(byDomain).map(([dom, t]) => [dom, { ...t, aloneShare: t.decisions ? t.alone / t.decisions : 0, aloneAccuracy: t.aloneGraded ? t.aloneRight / t.aloneGraded : null }])),
      })),
    money: {
      duplicateBillsStoppedCents: bills.filter(b => duplicateBills.has(b.id) && b.status !== 'paid').reduce((s, b) => s + b.amount_cents, 0),
      duplicateBillsPaidCents: bills.filter(b => duplicateBills.has(b.id) && b.status === 'paid').reduce((s, b) => s + b.amount_cents, 0),
      auditInvoicesCents: invoices.filter(i => i.kind === 'audit').reduce((s, i) => s + i.amount_cents, 0),
      auditInvoices: invoices.filter(i => i.kind === 'audit').length,
      refundsReleased: refunds.filter(r => r.status === 'released').length,
    },
    security: security.reduce((m: Record<string, number>, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {}),
    attempts: { total: acts.length, denied: acts.filter(a => a.outcome === 'denied').length, rejected: acts.filter(a => a.outcome === 'rejected').length },
    invariants,
    chain: { rows: acts.length, verified, firstBreak, head: prev },
  };
  mkdirSync(`${DIR}/eval`, { recursive: true });
  writeFileSync(`${DIR}/eval/report.json`, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ outcomes: report.outcomes, cashLanded: landed, knowingWhenToAsk, generations: generations.map(g => ({ key: g.key, test: g.test })), invariants, chain: report.chain }, null, 1));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
