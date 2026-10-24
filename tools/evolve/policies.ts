// Policy promotion by exhaustive search. Every tightening rule the kernel can
// express (forbid an action while a fact holds, or require a fact) is replayed
// against every past request of that action, using the facts the policy check
// saw at the time. A rule is proposed when it would have stopped something that
// went wrong and costs little in delayed good work. A person ratifies it.
import { evaluate as evaluatePolicy, FACT_LIBRARY, isTightening, type Action, type PolicyRule, type PolicyTemplate } from '../../module/spacetimedb/src/core/policy';
import { parseJson, type Db, type Row } from './lib';

// What going wrong costs, and what a held-back good action costs (it waits a week).
const COST = { returnedDebit: 3500 + 10_000, delayedDebitPerDollarWeek: 0.0015, refundToWrongParty: 1 };
const MONEY_OUT: Action[] = ['initiate_debit', 'issue_refund', 'release_payment'];

interface Request {
  activityId: number;
  action: Action;
  at: string;
  amountCents: number;
  facts: Record<string, boolean>;
  principalKind: string;
  requestedBy?: string;
  approvals?: number;
  trustedFields?: Record<string, boolean>;
  bad: string | null; // why this one went wrong, if it did
}

async function requests(db: Db): Promise<Request[]> {
  const [acts, debits] = await Promise.all([
    db.sql("SELECT id, at, command, params, outcome, context FROM activity WHERE kind = 'command'"),
    db.sql('SELECT id, status, activity_id FROM debit_instruction'),
  ]);
  const returned = new Set(debits.filter(d => d.status === 'returned').map(d => Number(d.activity_id)));
  return acts
    .filter((a: Row) => (MONEY_OUT as string[]).includes(a.command) && a.outcome === 'committed')
    .map((a: Row) => {
      const ctx = parseJson<{ facts?: Record<string, boolean>; amountCents?: number; principalKind?: string; requestedBy?: string; approvals?: number; trustedFields?: Record<string, boolean> }>(a.context, {});
      return {
        activityId: Number(a.id),
        action: a.command as Action,
        at: a.at,
        amountCents: ctx.amountCents ?? 0,
        facts: ctx.facts ?? {},
        principalKind: ctx.principalKind ?? 'seat',
        requestedBy: ctx.requestedBy,
        approvals: ctx.approvals,
        trustedFields: ctx.trustedFields,
        bad: a.command === 'initiate_debit' && returned.has(Number(a.id)) ? 'the debit was returned by the bank' : null,
      };
    });
}

export interface PolicyCandidate {
  tpl: PolicyTemplate;
  text: string;
  blockedBad: { activityId: number; at: string; why: string }[];
  blockedGood: { activityId: number; at: string; amountCents: number }[];
  benefitCents: number;
  costCents: number;
  extendsFrom?: string;
}

function would(tpl: PolicyTemplate, r: Request): boolean {
  const rule: PolicyRule = { id: 'X', version: 1, tpl, constitutional: false, text: '' };
  const grant: PolicyRule = { id: 'G', version: 1, tpl: { t: 'role_can', role: 'cash_app', actions: [r.action] }, constitutional: false, text: '' };
  const d = evaluatePolicy([grant, rule], { principal: { kind: r.principalKind as 'seat', id: 'replay', role: 'cash_app' }, action: r.action, amountCents: r.amountCents, facts: r.facts, trustedFields: r.trustedFields, approvals: r.approvals });
  return !d.allowed;
}

function text(tpl: PolicyTemplate): string {
  const verb = tpl.t === 'role_can' ? '' : tpl.action === 'initiate_debit' ? 'No debit is initiated' : tpl.action === 'issue_refund' ? 'No refund is released' : tpl.action === 'release_payment' ? 'No vendor payment is released' : `No ${String((tpl as { action: string }).action).replace(/_/g, ' ')}`;
  if (tpl.t === 'forbid_when') return `${verb} while ${FACT_LIBRARY[tpl.fact as keyof typeof FACT_LIBRARY]}.`;
  if (tpl.t === 'require_fact') return `${verb} unless ${FACT_LIBRARY[tpl.fact as keyof typeof FACT_LIBRARY]}.`;
  return '';
}

export function search(reqs: Request[], active: PolicyTemplate[]): PolicyCandidate[] {
  const candidates: PolicyCandidate[] = [];
  const has = (tpl: PolicyTemplate) => active.some(a => JSON.stringify(a) === JSON.stringify(tpl));
  for (const action of MONEY_OUT) {
    const mine = reqs.filter(r => r.action === action);
    for (const fact of Object.keys(FACT_LIBRARY)) {
      for (const t of ['forbid_when', 'require_fact'] as const) {
        const tpl = { t, action, fact } as PolicyTemplate;
        if (!isTightening(tpl) || has(tpl)) continue;
        const blocked = mine.filter(r => would(tpl, r));
        const blockedBad = blocked.filter(r => r.bad).map(r => ({ activityId: r.activityId, at: r.at, why: r.bad! }));
        const blockedGood = blocked.filter(r => !r.bad).map(r => ({ activityId: r.activityId, at: r.at, amountCents: r.amountCents }));
        if (!blockedBad.length) continue;
        const benefitCents = blockedBad.length * COST.returnedDebit;
        const costCents = Math.round(blockedGood.reduce((s, g) => s + g.amountCents * COST.delayedDebitPerDollarWeek, 0));
        if (benefitCents > costCents) candidates.push({ tpl, text: text(tpl), blockedBad, blockedGood, benefitCents, costCents });
      }
    }
  }
  // Best net saving first; a rule is kept only if it stops a loss that no kept
  // rule already stops, so a broader rule that catches the same returned debit
  // while holding back good ones is never offered.
  candidates.sort((a, b) => b.benefitCents - b.costCents - (a.benefitCents - a.costCents) || (a.tpl.t === 'forbid_when' ? -1 : 1));
  const kept: PolicyCandidate[] = [];
  const stopped = new Set<number>();
  for (const c of candidates) {
    if (c.blockedBad.every(b => stopped.has(b.activityId))) continue;
    kept.push(c);
    for (const b of c.blockedBad) stopped.add(b.activityId);
  }
  // The same risk on the other ways money leaves: extend a kept rule if it
  // would never have held back a good request of that kind.
  for (const c of [...kept]) {
    if (c.tpl.t !== 'forbid_when') continue;
    for (const action of MONEY_OUT.filter(a => a !== (c.tpl as { action: Action }).action)) {
      const sibling = { t: 'forbid_when', action, fact: c.tpl.fact } as PolicyTemplate;
      if (has(sibling) || kept.some(o => JSON.stringify(o.tpl) === JSON.stringify(sibling))) continue;
      if (!reqs.some(r => r.action === action && would(sibling, r))) kept.push({ tpl: sibling, text: text(sibling), blockedBad: [], blockedGood: [], benefitCents: 0, costCents: 0, extendsFrom: JSON.stringify(c.tpl) });
    }
  }
  return kept;
}

export async function searchPolicies(db: Db, dryRun: boolean, dir: string): Promise<string[]> {
  const [reqs, policies] = await Promise.all([requests(db), db.sql('SELECT key, policy_id, template, status FROM policy')]);
  const active = policies.filter(p => p.status === 'active' || p.status === 'proposed' || p.status === 'rejected').map(p => JSON.parse(p.template) as PolicyTemplate);
  const found = search(reqs, active);
  if (!found.length) return [`policies: searched ${MONEY_OUT.length * Object.keys(FACT_LIBRARY).length * 2} tightening rules over ${reqs.length} past money movements; none would have prevented a loss`];
  const lines: string[] = [];
  for (const c of found) {
    const proof = {
      gate: 'pass',
      searched: MONEY_OUT.length * Object.keys(FACT_LIBRARY).length * 2,
      replayedRequests: reqs.length,
      wouldHaveStopped: c.blockedBad,
      wouldHaveDelayed: c.blockedGood,
      benefitCents: c.benefitCents,
      costCents: c.costCents,
      extendsFrom: c.extendsFrom ?? null,
      tightensOnly: true,
      evaluatedAt: new Date().toISOString(),
    };
    if (!dryRun) await db.call('propose_policy', JSON.stringify(c.tpl), c.text, c.extendsFrom ? 'extension of a proposed rule' : 'policy search over past money movements', JSON.stringify(proof));
    lines.push(`policies: proposed "${c.text}" (stops ${c.blockedBad.length} bad, delays ${c.blockedGood.length} good)${dryRun ? ' [dry run]' : ''}`);
  }
  void dir;
  return lines;
}
