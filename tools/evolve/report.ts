// The proof page's numbers, computed from the database and the answer key:
// how each skill generation scores on the locked test split, how often the team
// was wrong when it did not ask, money recovered, attacks stopped, ledger
// invariants, and an independent re-verification of the activity hash chain.
//   npx tsx tools/evolve/report.ts --db charter-a
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { run, type FeatureMap, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { chainHash } from '../../module/spacetimedb/src/core/hash';
import { Db, evolverToken, parseJson, type Row } from './lib';
import { agrees, type Domain } from './skills';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');
const DB = args.get('db') ?? 'charter-iqwfr';
const DIR = args.get('data') ?? (DB === 'charter-a' ? 'data/companyA' : DB === 'charter-b' ? 'data/companyB' : 'data/dev');

const ESCALATE: Record<Domain, string[]> = {
  underreport: ['flag_audit', 'ask_consultant'],
  pre_chase: ['ask_consultant', 'escalate_controller'],
  allocation: ['leave_unapplied_ask'],
  routing_change: ['hold_and_verify', 'ask_controller', 'reject'],
};

function domainOf(subject: string): Domain | null {
  if (subject.startsWith('store:')) return 'underreport';
  if (subject.startsWith('receipt:')) return 'allocation';
  if (subject.startsWith('entity:')) return 'pre_chase';
  if (subject.startsWith('routing:')) return 'routing_change';
  return null;
}

// Exact one-sided 95% upper bound on an error rate (Clopper-Pearson), by bisection.
function upper95(errors: number, n: number): number {
  if (n === 0) return 1;
  const tail = (p: number) => {
    let s = 0;
    let term = Math.pow(1 - p, n);
    for (let k = 0; k <= errors; k++) {
      s += term;
      term *= ((n - k) / (k + 1)) * (p / (1 - p));
    }
    return s;
  };
  let lo = errors / n;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (tail(mid) > 0.05) lo = mid;
    else hi = mid;
  }
  return hi;
}

async function main(): Promise<void> {
  const db = new Db(DB, await evolverToken(DB));
  const keyPath = `${DIR}/answer_key.json`;
  const keyRaw = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) : [];
  const key = (Array.isArray(keyRaw) ? keyRaw : keyRaw.entries ?? []) as { caseId: string; family: string; split: string; subject: string; expected: string }[];
  const [decisions, skills, activity, gl, controls, invoices, security, refunds] = await Promise.all([
    db.sql('SELECT id, domain, subject, features, skill_key, outcome, shadow FROM decision'),
    db.sql('SELECT key, domain, version, status, program, created_at FROM skill'),
    db.sql('SELECT id, at, principal, role, kind, command, params, used, plan, outcome, reasons, claims, context, prev_hash, hash FROM activity'),
    db.sql('SELECT account, debit_cents, credit_cents FROM gl_balance'),
    db.sql('SELECT key, cents FROM control_total'),
    db.sql('SELECT id, kind, amount_cents, open_cents, status FROM invoice'),
    db.sql('SELECT kind, subject FROM security_event'),
    db.sql('SELECT entity_code, amount_cents, bank_account, status FROM refund'),
  ]);
  const latest = new Map<string, Row>();
  for (const d of decisions.sort((a, b) => a.id - b.id)) if (!d.shadow) latest.set(d.subject, d);

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
    const right = agrees(domain, d.outcome, e.expected);
    if (right) cell.right++;
    if (!ESCALATE[domain].includes(d.outcome) && (e.split === 'test' || e.split === 'live')) {
      const a = (auto[domain] ??= { n: 0, wrong: 0 });
      a.n++;
      if (!right) a.wrong++;
    }
  }
  const knowingWhenToAsk = Object.fromEntries(Object.entries(auto).map(([d, a]) => [d, { handledAlone: a.n, wrong: a.wrong, upper95: upper95(a.wrong, a.n) }]));

  // 2. Every generation of every skill, scored on the locked test split with the features the seats saw.
  const generations = skills
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.version - b.version)
    .map(s => {
      const program = JSON.parse(s.program) as SkillProgram;
      const byFamily: Record<string, { n: number; right: number }> = {};
      for (const e of key) {
        if (e.split !== 'test' || domainOf(e.subject) !== s.domain) continue;
        const d = latest.get(e.subject);
        if (!d) continue;
        const c = (byFamily[e.family] ??= { n: 0, right: 0 });
        c.n++;
        if (agrees(s.domain as Domain, run(program, parseJson<FeatureMap>(d.features, {})).outcome.decide, e.expected)) c.right++;
      }
      return { key: s.key, status: s.status, createdAt: s.created_at, test: byFamily };
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

  const report = {
    db: DB,
    generatedAt: new Date().toISOString(),
    answerKeyEntries: key.length,
    outcomes,
    knowingWhenToAsk,
    generations,
    money: {
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
  console.log(JSON.stringify({ outcomes: report.outcomes, knowingWhenToAsk, generations: generations.map(g => ({ key: g.key, test: g.test })), invariants, chain: report.chain }, null, 1));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
