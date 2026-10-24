// Plumbing for the evolution engine: the database over HTTP, the evolver's
// identity, and a cached LLM client. Nothing here decides anything.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

export const BASE = process.env.STDB_URL ?? 'http://127.0.0.1:3000';
const LLM_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

export type Row = Record<string, any>;

export class Db {
  constructor(public name: string, public token: string) {}

  async sql(query: string): Promise<Row[]> {
    const r = await fetch(`${BASE}/v1/database/${this.name}/sql`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, body: query });
    const text = await r.text();
    if (!r.ok) throw new Error(`sql "${query}" -> ${r.status} ${text.slice(0, 300)}`);
    const res = JSON.parse(text);
    if (!res.length) return [];
    const names: string[] = res[0].schema.elements.map((e: any) => e.name.some);
    return res[0].rows.map((row: unknown[]) => Object.fromEntries(row.map((v, i) => [names[i], v])));
  }

  async call(fn: string, ...args: unknown[]): Promise<string> {
    const r = await fetch(`${BASE}/v1/database/${this.name}/call/${fn}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${fn} -> ${r.status} ${text.slice(0, 300)}`);
    return text;
  }
}

function adminToken(): string {
  const out = execFileSync('spacetime', ['login', 'show', '--token'], { encoding: 'utf8' });
  const tok = out.split(/\s+/).find(w => w.split('.').length === 3 && w.length > 40);
  if (!tok) throw new Error('could not read the spacetime CLI token');
  return tok;
}

// The evolver is an ordinary principal with one right: to propose.
export async function evolverToken(db: string): Promise<string> {
  return roleToken(db, 'evolver', 'evolver');
}

// A tool acting as a named principal: use the world's identity file, else bind one locally.
export async function roleToken(db: string, role: string, name: string): Promise<string> {
  const ids = process.env.IDENTITIES ?? 'data/companyA/identities.json';
  if (db === 'charter-a' && existsSync(ids)) {
    const all = JSON.parse(readFileSync(ids, 'utf8')) as Record<string, { token: string; role: string }>;
    const e = all[name] ?? Object.values(all).find(x => x.role === role);
    if (e) return e.token;
  }
  const cache = `data/.${role}-${db}.json`;
  if (existsSync(cache)) {
    const { identity, token } = JSON.parse(readFileSync(cache, 'utf8'));
    const hex = String(identity).replace(/^0x/, '').toLowerCase();
    const rows = await new Db(db, token).sql(`SELECT identity, role FROM principal WHERE role = '${role}'`);
    if (rows.some(r => JSON.stringify(r.identity).toLowerCase().includes(hex))) return token;
  }
  const { identity, token } = (await (await fetch(`${BASE}/v1/identity`, { method: 'POST' })).json()) as { identity: string; token: string };
  await new Db(db, adminToken()).call('bind_role', { __identity__: identity.startsWith('0x') ? identity : `0x${identity}` }, role, name);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ identity, token }));
  return token;
}

function apiKey(): string {
  const env = readFileSync(`${homedir()}/.config/charter/modelstudio.env`, 'utf8');
  const m = env.match(/MODELSTUDIO_API_KEY=["']?([^"'\s]+)/);
  if (!m) throw new Error('MODELSTUDIO_API_KEY not found');
  return m[1];
}

const CACHE_FILE = 'data/evolve_llm_cache.json';
let cache: Record<string, string> | null = null;

// Proposals are cached by prompt so a replay of the same history proposes the same thing.
export async function llmJson(model: string, system: string, user: string, temperature: number, maxTokens = 1800): Promise<{ json: any; raw: string; cached: boolean }> {
  cache ??= existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
  const key = createHash('sha256').update(`${model}|${temperature}|${system}|${user}`).digest('hex');
  let raw = cache![key];
  const cached = raw !== undefined;
  if (!cached) {
    const r = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        max_tokens: thinks(model) ? Math.max(maxTokens, 4000) : maxTokens,
        enable_thinking: thinks(model),
        response_format: { type: 'json_object' },
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`LLM ${model} -> ${r.status} ${text.slice(0, 300)}`);
    raw = String(JSON.parse(text).choices?.[0]?.message?.content ?? '');
    cache![key] = raw;
    mkdirSync('data', { recursive: true });
    // Runs share the cache: merge with what is on disk, and replace the file in one step.
    cache = { ...(existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {}), ...cache };
    writeFileSync(`${CACHE_FILE}.${process.pid}`, JSON.stringify(cache, null, 1));
    renameSync(`${CACHE_FILE}.${process.pid}`, CACHE_FILE);
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  let json: any = null;
  try {
    json = start >= 0 ? JSON.parse(raw.slice(start, end + 1)) : null;
  } catch {
    json = null;
  }
  return { json, raw, cached };
}

// Some models on the endpoint only run with thinking switched on.
function thinks(model: string): boolean {
  return /^glm-5\.3/.test(model);
}

export function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
