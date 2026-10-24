// Reading policies: the module's templates and fact library (core/policy.ts)
// and the role questions the Floor asks of the live policy table.
import { ACTIONS, FACT_LIBRARY, type Action, type PolicyTemplate } from '@module/core/policy';
import type { Activity, Policy } from '../module_bindings/types';
import { ACTION_LABEL, ACTION_VERB, money, ROLE_LABEL } from './format';
import { parseArr, parseLoose } from './json';

export { ACTIONS, FACT_LIBRARY };
export type { Action, PolicyTemplate };

export function template(p: Policy): PolicyTemplate | null {
  return parseLoose<PolicyTemplate | null>(p.template, null);
}

export function factText(name: string): string {
  return (FACT_LIBRARY as Record<string, string>)[name] ?? name.replace(/_/g, ' ');
}

// One line in the kernel's terms, for people who want to see the rule as it is enforced.
export function templateText(tpl: PolicyTemplate | null): string {
  if (!tpl) return '';
  const act = (a: string) => (ACTION_LABEL[a] ?? a).toLowerCase();
  switch (tpl.t) {
    case 'role_can':
      return `${ROLE_LABEL[tpl.role] ?? tpl.role} may ${tpl.actions.map(a => ACTION_VERB[a] ?? a).join(', ')}`;
    case 'human_only':
      return `only a person may ${act(tpl.action)}`;
    case 'sod':
      return `whoever requested it cannot ${act(tpl.action)}`;
    case 'two_person_above':
      return `${act(tpl.action)} above ${money(tpl.amountCents, { whole: true })} needs two approvals`;
    case 'require_fact':
      return `${act(tpl.action)} requires: ${tpl.fact.replace(/_/g, ' ')}`;
    case 'forbid_when':
      return `no ${act(tpl.action)} while ${tpl.fact.replace(/_/g, ' ')}`;
    case 'trusted_field':
      return `${act(tpl.action)}: the ${tpl.field.replace(/_/g, ' ')} must come from a trusted source`;
  }
  return '';
}

export function templateAction(tpl: PolicyTemplate | null): string | null {
  if (!tpl) return null;
  return tpl.t === 'role_can' ? null : tpl.action;
}

export function activePolicies(policies: Policy[]): Policy[] {
  return policies.filter(p => p.status === 'active');
}

export function policyKind(p: Policy): 'constitution' | 'role' | 'promoted' {
  if (p.constitutional) return 'constitution';
  if (p.policyId.startsWith('P-')) return 'promoted';
  return 'role';
}

export interface RoleView {
  may: string[]; // actions granted by active role_can rules
  grantedBy: Policy[];
  boundBy: Policy[]; // restrictions on actions this role may take
  never: Policy[]; // human_only rules: seats can never do these
}

export function roleView(policies: Policy[], role: string, isSeat: boolean): RoleView {
  const active = activePolicies(policies);
  const may = new Set<string>();
  const grantedBy: Policy[] = [];
  for (const p of active) {
    const tpl = template(p);
    if (tpl?.t === 'role_can' && tpl.role === role) {
      tpl.actions.forEach(a => may.add(a));
      grantedBy.push(p);
    }
  }
  const boundBy: Policy[] = [];
  const never: Policy[] = [];
  for (const p of active) {
    const tpl = template(p);
    if (!tpl || tpl.t === 'role_can') continue;
    if (tpl.t === 'human_only') {
      if (isSeat) never.push(p);
      else if (may.has(tpl.action)) boundBy.push(p);
      continue;
    }
    if (may.has(tpl.action)) boundBy.push(p);
  }
  const order = (a: Policy, b: Policy) => idOrder(a.policyId) - idOrder(b.policyId);
  return { may: ACTIONS.filter(a => may.has(a)), grantedBy, boundBy: boundBy.sort(order), never: never.sort(order) };
}

export function idOrder(id: string): number {
  const m = /^([A-Z]+)-?(\d+)?/.exec(id);
  const prefix = m?.[1] ?? 'Z';
  const n = Number(m?.[2] ?? 0);
  const base = prefix === 'C' ? 0 : prefix === 'P' ? 1000 : 2000;
  return base + n;
}

// The policy row currently in force for an id such as "C8" or "P-1".
export function policyById(policies: Policy[], id: string): Policy | undefined {
  let best: Policy | undefined;
  for (const p of policies) {
    if (p.policyId !== id) continue;
    if (!best || (p.status === 'active' && best.status !== 'active') || (p.status === best.status && p.version > best.version)) best = p;
  }
  return best;
}

// The refused attempts a policy is cited in, oldest first.
export function stoppedByPolicy(activity: Activity[], policyId: string): Activity[] {
  return activity
    .filter(a => (a.outcome === 'denied' || a.outcome === 'rejected') && parseArr<string>(a.reasons).some(r => r.startsWith(`${policyId}:`)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// Policies that guard the same fact: one learned on one desk often has siblings on another.
export function siblings(policies: Policy[], p: Policy): Policy[] {
  const t = template(p);
  if (!t || (t.t !== 'forbid_when' && t.t !== 'require_fact')) return [];
  return policies.filter(q => {
    if (q.key === p.key || q.status === 'rejected') return false;
    const u = template(q);
    return !!u && (u.t === 'forbid_when' || u.t === 'require_fact') && u.fact === t.fact;
  });
}
