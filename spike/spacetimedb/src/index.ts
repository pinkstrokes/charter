// Spike: verify the SpacetimeDB capabilities Charter's architecture depends on.
// 1. procedures can call an LLM over HTTPS        (ask_llm)
// 2. a slow procedure does not block reducers     (ask_llm + ping, measured by the client)
// 3. procedures can run on a schedule             (llm_timer -> llm_tick)
// 4. identities enforce segregation of duties and views filter per identity
// 5. inbound HTTP handlers accept webhooks        (/route/webhook)
import { schema, table, t, SenderError, Router, SyncResponse } from 'spacetimedb/server';
import { ScheduleAt, TimeDuration } from 'spacetimedb';

const admin = table(
  { name: 'admin' },
  { slot: t.u32().primaryKey(), identity: t.identity() }
);

const roleBinding = table(
  { name: 'role_binding' },
  { identity: t.identity().primaryKey(), role: t.string() }
);

const secret = table(
  { name: 'secret' },
  { key: t.string().primaryKey(), value: t.string() }
);

const payment = table(
  { name: 'payment' },
  {
    id: t.u64().primaryKey().autoInc(),
    requestedBy: t.identity(),
    approvedBy: t.option(t.identity()),
    payee: t.string(),
    amountCents: t.u64(),
    status: t.string(),
  }
);

const eventLog = table(
  { name: 'event_log', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    actor: t.string(),
    kind: t.string(),
    detail: t.string(),
  }
);

const llmTimer = table(
  { name: 'llm_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    prompt: t.string(),
  }
);

const inbound = table(
  { name: 'inbound', public: true },
  { id: t.u64().primaryKey().autoInc(), at: t.timestamp(), body: t.string() }
);

const spacetimedb = schema({ admin, roleBinding, secret, payment, eventLog, llmTimer, inbound });
export default spacetimedb;

const LLM_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

export const init = spacetimedb.init(ctx => {
  ctx.db.admin.insert({ slot: 0, identity: ctx.sender });
  ctx.db.eventLog.insert({ id: 0n, at: ctx.timestamp, actor: 'system', kind: 'init', detail: 'admin bound to publisher' });
});

function requireAdmin(ctx: { db: any; sender: any }) {
  const row = ctx.db.admin.slot.find(0);
  if (!row || !row.identity.equals(ctx.sender)) throw new SenderError('only the admin may do this');
}

function roleOf(ctx: { db: any; sender: any }): string {
  return ctx.db.roleBinding.identity.find(ctx.sender)?.role ?? 'none';
}

export const bind_role = spacetimedb.reducer(
  { who: t.identity(), role: t.string() },
  (ctx, { who, role }) => {
    requireAdmin(ctx);
    const existing = ctx.db.roleBinding.identity.find(who);
    if (existing) ctx.db.roleBinding.identity.update({ identity: who, role });
    else ctx.db.roleBinding.insert({ identity: who, role });
    ctx.db.eventLog.insert({ id: 0n, at: ctx.timestamp, actor: 'admin', kind: 'bind_role', detail: `${who.toHexString().slice(0, 12)} -> ${role}` });
  }
);

export const set_secret = spacetimedb.reducer(
  { key: t.string(), value: t.string() },
  (ctx, { key, value }) => {
    requireAdmin(ctx);
    if (ctx.db.secret.key.find(key)) ctx.db.secret.key.update({ key, value });
    else ctx.db.secret.insert({ key, value });
  }
);

export const request_payment = spacetimedb.reducer(
  { payee: t.string(), amountCents: t.u64() },
  (ctx, { payee, amountCents }) => {
    const role = roleOf(ctx);
    if (role !== 'cash_app' && role !== 'controller') throw new SenderError(`role ${role} may not request payments`);
    const row = ctx.db.payment.insert({ id: 0n, requestedBy: ctx.sender, approvedBy: undefined, payee, amountCents, status: 'pending' });
    ctx.db.eventLog.insert({ id: 0n, at: ctx.timestamp, actor: role, kind: 'request_payment', detail: `#${row.id} ${payee} ${amountCents}` });
  }
);

export const approve_payment = spacetimedb.reducer(
  { paymentId: t.u64() },
  (ctx, { paymentId }) => {
    const role = roleOf(ctx);
    const p = ctx.db.payment.id.find(paymentId);
    if (!p) throw new SenderError('no such payment');
    if (role !== 'controller') throw new SenderError(`role ${role} may not approve payments`);
    if (p.requestedBy.equals(ctx.sender)) throw new SenderError('segregation of duties: the requester cannot approve');
    ctx.db.payment.id.update({ ...p, approvedBy: ctx.sender, status: 'approved' });
    ctx.db.eventLog.insert({ id: 0n, at: ctx.timestamp, actor: role, kind: 'approve_payment', detail: `#${paymentId}` });
  }
);

export const ping = spacetimedb.reducer(
  { note: t.string() },
  (ctx, { note }) => {
    ctx.db.eventLog.insert({ id: 0n, at: ctx.timestamp, actor: roleOf(ctx), kind: 'ping', detail: note });
  }
);

export const my_payments = spacetimedb.view(
  { name: 'my_payments', public: true },
  t.array(payment.rowType),
  ctx => [...ctx.db.payment.iter()].filter(
    p => p.requestedBy.equals(ctx.sender) || (p.approvedBy !== undefined && p.approvedBy.equals(ctx.sender))
  )
);

function callLlm(ctx: any, prompt: string, maxTokens: number): { status: number; content: string } {
  const key = ctx.withTx((tx: any) => tx.db.secret.key.find('MODELSTUDIO_API_KEY')?.value ?? '');
  if (!key) return { status: 0, content: 'missing key' };
  const response = ctx.http.fetch(LLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'qwen3.8-flash',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      enable_thinking: false,
    }),
    timeout: TimeDuration.fromMillis(60_000),
  });
  const text = response.text();
  if (response.status !== 200) return { status: response.status, content: text.slice(0, 300) };
  const parsed = JSON.parse(text);
  return { status: 200, content: String(parsed.choices?.[0]?.message?.content ?? '') };
}

export const ask_llm = spacetimedb.procedure(
  { prompt: t.string(), maxTokens: t.u32() },
  t.string(),
  (ctx, { prompt, maxTokens }) => {
    ctx.withTx(tx => {
      tx.db.eventLog.insert({ id: 0n, at: tx.timestamp, actor: 'procedure', kind: 'llm_start', detail: prompt.slice(0, 60) });
    });
    const result = callLlm(ctx, prompt, maxTokens);
    ctx.withTx(tx => {
      tx.db.eventLog.insert({ id: 0n, at: tx.timestamp, actor: 'procedure', kind: 'llm_end', detail: `${result.status} ${result.content.slice(0, 120)}` });
    });
    return result.content;
  }
);

export const llm_tick = spacetimedb.procedure(
  { onSchedule: llmTimer },
  { timer: llmTimer.rowType },
  t.unit(),
  (ctx, { timer }) => {
    const result = callLlm(ctx, timer.prompt, 16);
    ctx.withTx(tx => {
      tx.db.eventLog.insert({ id: 0n, at: tx.timestamp, actor: 'scheduler', kind: 'llm_tick', detail: `${result.status} ${result.content.slice(0, 80)}` });
    });
    return {};
  }
);

export const schedule_llm = spacetimedb.reducer(
  { prompt: t.string(), delaySeconds: t.u32() },
  (ctx, { prompt, delaySeconds }) => {
    requireAdmin(ctx);
    const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(delaySeconds) * 1_000_000n;
    ctx.db.llmTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at), prompt });
  }
);

export const health = spacetimedb.httpHandler((_ctx, _req) =>
  new SyncResponse('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
);

export const webhook = spacetimedb.httpHandler((ctx, req) => {
  const body = req.text();
  ctx.withTx(tx => {
    tx.db.inbound.insert({ id: 0n, at: tx.timestamp, body: body.slice(0, 500) });
  });
  return new SyncResponse('received', { status: 200, headers: { 'content-type': 'text/plain' } });
});

export const routes = spacetimedb.httpRouter(new Router().get('/health', health).post('/webhook', webhook));
