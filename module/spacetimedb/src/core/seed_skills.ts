// Generation-0 team skills: what a careful engineer would write on day one,
// before the organization has any experience. Evolution starts from these.
import { type SkillProgram, F, N, B, E, cmp, and, or, not, arith } from './dsl';

export const SEED_SKILLS: Record<string, SkillProgram> = {
  bill_match: {
    domain: 'bill_match',
    rules: [
      { when: not(F('po_found')), then: { decide: 'hold_exception', note: 'no purchase order for this bill' } },
      { when: not(F('receipt_found')), then: { decide: 'hold_exception', note: 'nothing has been received against the order' } },
      { when: cmp('gt', F('amount_vs_received'), N(1.02)), then: { decide: 'hold_exception', note: 'billed for more than was received' } },
    ],
    otherwise: { decide: 'approve' },
  },
  underreport: {
    domain: 'underreport',
    rules: [
      // Card sales are settled by the processor, so a franchisee cannot report less card revenue than settled.
      {
        when: cmp('lt', F('reported_card'), arith('mul', F('card_settled'), N(0.98))),
        then: { decide: 'flag_audit', note: 'reported card sales below what the processor settled' },
      },
    ],
    otherwise: { decide: 'accept' },
  },
  pre_chase: {
    domain: 'pre_chase',
    rules: [
      { when: cmp('le', F('days_past_due'), F('grace_days')), then: { decide: 'hold', note: 'still inside the grace period' } },
      { when: F('open_dispute'), then: { decide: 'ask_consultant', askRole: 'consultant', note: 'balance is disputed' } },
    ],
    otherwise: { decide: 'chase' },
  },
  routing_change: {
    domain: 'routing_change',
    rules: [
      { when: cmp('eq', F('callback_status'), E('denied')), then: { decide: 'reject', note: 'the counterparty denied making this request' } },
      { when: not(F('source_trusted')), then: { decide: 'hold_and_verify', askRole: 'controller', note: 'request came by email; verify by phone before any change' } },
    ],
    otherwise: { decide: 'ask_controller', askRole: 'controller' },
  },
  allocation: {
    domain: 'allocation',
    rules: [
      { when: and(cmp('eq', F('solution_count'), N(1)), F('exact_match')), then: { decide: 'apply_unique' } },
      { when: cmp('eq', F('solution_count'), N(1)), then: { decide: 'apply_unique', note: 'one subset explains the amount within tolerance' } },
      { when: cmp('eq', F('solution_count'), N(0)), then: { decide: 'apply_by_terms', note: 'no subset matches; apply by contract order' } },
    ],
    otherwise: { decide: 'leave_unapplied_ask', askRole: 'controller', note: 'several invoice sets explain this amount' },
  },
};

// Keep the builders referenced so tree-shaking tools do not flag them as unused
// when a seed stops using one of them.
void B;
void or;
