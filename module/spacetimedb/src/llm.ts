// LLM access from procedures. The model is a quarantined reader: it receives
// text and returns JSON fields; it has no tools and cannot touch the database.
// Every call is cached by prompt hash so replays are deterministic and cheap.
import { TimeDuration } from 'spacetimedb';
import type { InferSchema, ProcedureCtx } from 'spacetimedb/server';
import type spacetimedb from './schema';
import { sha256Hex } from './core/hash';
import { simDate } from './kernel';

const ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

export type ProcCtx = ProcedureCtx<InferSchema<typeof spacetimedb>>;

export function llmJson(ctx: ProcCtx, seat: string, purpose: string, system: string, user: string, maxTokens = 600): Record<string, unknown> | null {
  const { key, model } = ctx.withTx(tx => ({
    key: tx.db.secret.key.find('MODELSTUDIO_API_KEY')?.value ?? '',
    model: tx.db.config.id.find(0)?.llmModel || 'qwen3.8-flash',
  }));
  const promptHash = sha256Hex(`${model}|${system}|${user}`);
  const cached = ctx.withTx(tx => {
    for (const c of tx.db.llmCall.promptHash.filter(promptHash)) if (c.status === 200) return c.response;
    return null;
  });
  if (cached !== null) {
    ctx.withTx(tx => tx.db.llmCall.insert({ id: 0n, at: simDate(tx), seat, purpose, model, promptHash, response: cached, status: 200, cached: true }));
    return safeParse(cached);
  }
  if (!key) return null;
  let status = 0;
  let content = '';
  try {
    const response = ctx.http.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0,
        enable_thinking: false,
        response_format: { type: 'json_object' },
      }),
      timeout: TimeDuration.fromMillis(45_000),
    });
    status = response.status;
    const text = response.text();
    content = status === 200 ? String(JSON.parse(text).choices?.[0]?.message?.content ?? '') : text.slice(0, 500);
  } catch (e) {
    content = String(e);
  }
  ctx.withTx(tx => tx.db.llmCall.insert({ id: 0n, at: simDate(tx), seat, purpose, model, promptHash, response: content, status, cached: false }));
  return status === 200 ? safeParse(content) : null;
}

function safeParse(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
