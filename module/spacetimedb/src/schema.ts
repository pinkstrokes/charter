// Database schema. Money is stored as i64 minor units (bigint in TypeScript).
import { schema, table, t } from 'spacetimedb/server';

export const config = table(
  { name: 'config', public: true },
  {
    id: t.u32().primaryKey(),
    companyName: t.string(),
    companyKind: t.string(), // 'franchisor' | 'wholesaler'
    currency: t.string(),
    simDate: t.string(), // YYYY-MM-DD, the organization's business date
    autopilot: t.bool(), // seats run on the scheduler when true
    llmModel: t.string(),
  }
);

export const principal = table(
  { name: 'principal', public: true },
  { identity: t.identity().primaryKey(), role: t.string(), name: t.string() }
);

export const secret = table({ name: 'secret' }, { key: t.string().primaryKey(), value: t.string() });

export const entity = table(
  { name: 'entity', public: true },
  {
    code: t.string().primaryKey(),
    name: t.string(),
    kind: t.string(), // 'franchisee' | 'customer'
    contactEmail: t.string(),
    phoneOnFile: t.string(),
    bankAccount: t.string(), // masked
    bankAccountTrusted: t.bool(),
    status: t.string(),
    country: t.string(),
  }
);

export const store = table(
  { name: 'store', public: true },
  {
    code: t.string().primaryKey(),
    entityCode: t.string().index('btree'),
    name: t.string(),
    city: t.string(),
    contractVersion: t.string(),
    consultant: t.string(),
  }
);

export const contractVersion = table(
  { name: 'contract_version', public: true },
  { version: t.string().primaryKey(), termsJson: t.string() }
);

export const observation = table(
  { name: 'observation', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    source: t.string(),
    trusted: t.bool(),
    knownAt: t.string(),
    validAt: t.string(),
    refKey: t.string().unique(),
    subject: t.string().index('btree'),
    payload: t.string(),
    sha: t.string(),
    status: t.string().index('btree'), // 'new' | 'routed' | 'done'
  }
);

export const fact = table(
  { name: 'fact', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    subject: t.string().index('btree'),
    attr: t.string(),
    value: t.string(), // JSON
    validFrom: t.string(),
    knownAt: t.string(),
    sourceObs: t.u64(),
    trusted: t.bool(),
    activityId: t.u64(),
  }
);

export const invoice = table(
  { name: 'invoice', public: true },
  {
    id: t.string().primaryKey(),
    kind: t.string(),
    entityCode: t.string().index('btree'),
    storeCode: t.string(),
    period: t.string(),
    issuedAt: t.string(),
    dueAt: t.string(),
    amountCents: t.i64(),
    openCents: t.i64(),
    status: t.string(), // 'open' | 'paid' | 'written_off' | 'disputed'
    source: t.string(),
  }
);

export const receipt = table(
  { name: 'receipt', public: true },
  {
    id: t.string().primaryKey(),
    entityCode: t.string().index('btree'),
    payerName: t.string(),
    amountCents: t.i64(),
    unappliedCents: t.i64(),
    receivedAt: t.string(),
    method: t.string(),
    reference: t.string(),
    status: t.string(), // 'unapplied' | 'partially_applied' | 'applied' | 'returned'
  }
);

export const application = table(
  { name: 'application', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    receiptId: t.string().index('btree'),
    invoiceId: t.string().index('btree'),
    amountCents: t.i64(),
    activityId: t.u64(),
    reversed: t.bool(),
  }
);

export const journal = table(
  { name: 'journal', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    jeId: t.string().index('btree'),
    account: t.string(),
    debitCents: t.i64(),
    creditCents: t.i64(),
    entityCode: t.string(),
    memo: t.string(),
    period: t.string(),
    activityId: t.u64(),
  }
);

export const glBalance = table(
  { name: 'gl_balance', public: true },
  { account: t.string().primaryKey(), name: t.string(), debitCents: t.i64(), creditCents: t.i64() }
);

// Totals maintained by code paths independent of the journal; invariants
// compare them with gl_balance so a bug in either side shows up.
export const controlTotal = table(
  { name: 'control_total', public: true },
  { key: t.string().primaryKey(), cents: t.i64() }
);

export const debitInstruction = table(
  { name: 'debit_instruction', public: true },
  {
    id: t.string().primaryKey(),
    entityCode: t.string().index('btree'),
    amountCents: t.i64(),
    invoiceIds: t.string(), // JSON array
    scheduledFor: t.string(),
    bankAccount: t.string(),
    status: t.string(), // 'scheduled' | 'blocked' | 'settled' | 'returned'
    activityId: t.u64(),
  }
);

export const routingRequest = table(
  { name: 'routing_request', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    entityCode: t.string().index('btree'),
    requestedAccount: t.string(),
    sourceObs: t.u64(),
    status: t.string(), // 'held' | 'verified' | 'rejected' | 'applied'
    createdAt: t.string(),
    callbackStatus: t.string(),
    decidedBy: t.string(),
  }
);

export const workItem = table(
  { name: 'work_item', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    subject: t.string().index('btree'),
    seat: t.string().index('btree'),
    state: t.string().index('btree'), // 'open' | 'waiting' | 'done'
    createdAt: t.string(),
    updatedAt: t.string(),
    payload: t.string(),
    checkpoint: t.string(),
  }
);

export const ask = table(
  { name: 'ask', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    createdAt: t.string(),
    kind: t.string(),
    subject: t.string(),
    toRole: t.string().index('btree'),
    question: t.string(),
    options: t.string(), // JSON array of strings
    evidence: t.string(), // JSON
    confidence: t.f64(),
    precedent: t.string(),
    status: t.string().index('btree'), // 'open' | 'answered' | 'expired'
    answer: t.string(),
    reason: t.string(), // the answerer's one-line explanation; the evolver learns from it
    answeredBy: t.string(),
    answeredAt: t.string(),
    deadline: t.string(),
    workItemId: t.u64(),
  }
);

export const activity = table(
  { name: 'activity', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.string(),
    wall: t.timestamp(),
    principal: t.string(),
    role: t.string(),
    kind: t.string(), // 'command' | 'denied' | 'skill' | 'policy' | 'ingest' | 'ask' | 'answer' | 'llm'
    command: t.string(),
    params: t.string(),
    used: t.string(),
    plan: t.string(),
    outcome: t.string(),
    reasons: t.string(),
    claims: t.string(),
    context: t.string(), // JSON RequestContext: what the policy check saw
    prevHash: t.string(),
    hash: t.string(),
  }
);

export const chainHead = table(
  { name: 'chain_head', public: true },
  { id: t.u32().primaryKey(), lastActivityId: t.u64(), hash: t.string(), anchoredHash: t.string(), anchoredAt: t.string() }
);

export const skill = table(
  { name: 'skill', public: true },
  {
    key: t.string().primaryKey(), // domain@version
    domain: t.string().index('btree'),
    version: t.u32(),
    status: t.string(), // 'active' | 'proposed' | 'shadow' | 'retired' | 'rejected'
    program: t.string(), // JSON SkillProgram
    scope: t.string(), // JSON
    parent: t.string(),
    provenance: t.string(),
    proof: t.string(),
    record: t.string(),
    createdAt: t.string(),
  }
);

export const policy = table(
  { name: 'policy', public: true },
  {
    key: t.string().primaryKey(), // id@version
    policyId: t.string().index('btree'),
    version: t.u32(),
    template: t.string(), // JSON PolicyTemplate
    text: t.string(),
    status: t.string(), // 'active' | 'proposed' | 'rejected' | 'retired'
    constitutional: t.bool(),
    sourceSkill: t.string(),
    approvedBy: t.string(),
    approvedAt: t.string(),
    proof: t.string(),
  }
);

// Every skill decision with the features it saw, so a candidate skill can be
// replayed against history in seconds instead of rebuilding past state.
export const decision = table(
  { name: 'decision', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.string(),
    seat: t.string(),
    domain: t.string().index('btree'),
    subject: t.string().index('btree'),
    features: t.string(), // JSON FeatureMap
    skillKey: t.string(),
    outcome: t.string(),
    ruleIndex: t.i32(),
    note: t.string(),
    shadow: t.bool(), // decided by a shadow version; never acted on
  }
);

export const refund = table(
  { name: 'refund', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    entityCode: t.string().index('btree'),
    amountCents: t.i64(),
    bankAccount: t.string(),
    status: t.string(), // 'prepared' | 'released' | 'cancelled'
    requestedBy: t.string(),
    approvals: t.string(), // JSON array of approver ids
    createdAt: t.string(),
    sourceObs: t.u64(),
    activityId: t.u64(),
  }
);

export const llmCall = table(
  { name: 'llm_call', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.string(),
    seat: t.string(),
    purpose: t.string(),
    model: t.string(),
    promptHash: t.string().index('btree'),
    response: t.string(),
    status: t.u32(),
    cached: t.bool(),
  }
);

export const securityEvent = table(
  { name: 'security_event', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.string(),
    kind: t.string(),
    subject: t.string(),
    detail: t.string(),
    stoppedBy: t.string(),
    observationId: t.u64(),
  }
);

export const seatState = table(
  { name: 'seat_state', public: true },
  { seat: t.string().primaryKey(), lastRunAt: t.string(), status: t.string(), runs: t.u32(), lastSummary: t.string() }
);

export const seatTimer = table(
  { name: 'seat_timer' },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), seat: t.string() }
);

const spacetimedb = schema({
  config,
  principal,
  secret,
  entity,
  store,
  contractVersion,
  observation,
  fact,
  invoice,
  receipt,
  application,
  journal,
  glBalance,
  controlTotal,
  debitInstruction,
  routingRequest,
  workItem,
  ask,
  activity,
  chainHead,
  skill,
  policy,
  decision,
  refund,
  llmCall,
  securityEvent,
  seatState,
  seatTimer,
});
export default spacetimedb;
