// The sandbox's last step (tools/play/reset.sh), on the two play databases after their replays:
// the people a visitor can be, the Security page's examples read ahead, and the step bar.
//   npx tsx tools/play/prepare.ts --play ~/Developer/charter-play-stdb charter-pinkstrokes-play-a charter-pinkstrokes-play-b
//
// People: Dana and Sam (controllers), an Outsider (no role) and the World page's feeder (role world),
// minted once into <play>/personas.json (mode 600, outside the repository) and bound again on every
// reset. Binding moves the names Dana and Sam from the run's own identities, which stay private.
// Examples: every email the Security page offers (web/src/lib/presets.ts, the very code the page runs,
// once for each payment waiting for release, since the first example names the biggest one), read
// here by both mailroom models with the key on this machine and carried into the database's model
// cache under the hash the mailroom will look up (module seats.ts triage). The key never goes in.
// Steps: the demo table's beats (tools/demo/steps.py), resolved against these databases. Run once after
// each replay (reset.sh prep); people and readings are kept or skipped when already there.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setDefaultCurrency } from '../../web/src/lib/format';
import { presets, vendorPreset, type Draft } from '../../web/src/lib/presets';
import type { Entity, Payment, Store } from '../../web/src/module_bindings/types';

// Run from the checkout's root: the examples are built by the page's own code in web/src.
const REPO = process.cwd();
const BASE = (process.env.STDB_URL ?? 'https://maincloud.spacetimedb.com').replace(/\/$/, '');
const ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const args = process.argv.slice(2);
const at = args.indexOf('--play');
const PLAY = at >= 0 ? args[at + 1] : '';
const [DB_A, DB_B] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--play');
if (!PLAY || !DB_A || !DB_B) throw new Error('usage: prepare.ts --play DIR DB_A DB_B');
// Never anything but the sandbox's own databases (the published replays are charter-pinkstrokes-a/b/c).
for (const db of [DB_A, DB_B]) if (!/^charter-pinkstrokes-play-[a-z]$/.test(db)) throw new Error(`${db} is not a sandbox database`);

type Row = Record<string, any>;

function adminToken(): string {
  const out = execFileSync('spacetime', ['login', 'show', '--token'], { encoding: 'utf8' });
  const tok = out.split(/\s+/).find(w => w.split('.').length === 3 && w.length > 40);
  if (!tok) throw new Error('could not read the spacetime CLI token');
  return tok;
}
const ADMIN = adminToken();

async function sql(db: string, query: string): Promise<Row[]> {
  const r = await fetch(`${BASE}/v1/database/${db}/sql`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` }, body: query });
  const text = await r.text();
  if (!r.ok) throw new Error(`${db}: sql "${query}" -> ${r.status} ${text.slice(0, 300)}`);
  const res = JSON.parse(text);
  if (!res.length) return [];
  const names: string[] = res[0].schema.elements.map((e: any) => e.name.some);
  return res[0].rows.map((row: unknown[]) => Object.fromEntries(row.map((v, i) => [names[i], v])));
}

async function call(db: string, fn: string, ...params: unknown[]): Promise<void> {
  const r = await fetch(`${BASE}/v1/database/${db}/call/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  if (!r.ok) throw new Error(`${db}: ${fn} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
}

// ---------- people ----------

interface Person {
  identity: string;
  token: string;
  role: string;
}
const PEOPLE: { name: string; role: string }[] = [
  { name: 'Dana', role: 'controller' },
  { name: 'Sam', role: 'controller' },
  { name: 'Outsider', role: 'outsider' },
  { name: 'World page', role: 'world' },
];

async function people(): Promise<Record<string, Person>> {
  const file = path.join(PLAY, 'personas.json');
  const known: Record<string, Person> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const p of PEOPLE) {
    if (known[p.name]?.token) continue;
    const r = await fetch(`${BASE}/v1/identity`, { method: 'POST' });
    const d = (await r.json()) as { identity: string; token: string };
    known[p.name] = { identity: d.identity.toLowerCase().replace(/^0x/, ''), token: d.token, role: p.role };
  }
  writeFileSync(file, JSON.stringify(known, null, 1) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  for (const db of [DB_A, DB_B])
    for (const p of PEOPLE)
      if (p.role !== 'outsider') await call(db, 'bind_role', { __identity__: `0x${known[p.name].identity}` }, p.role, p.name);
  return known;
}

// ---------- the Security page's examples, read ahead ----------

const entityOf = (r: Row): Entity => ({ code: r.code, name: r.name, kind: r.kind, contactEmail: r.contact_email }) as unknown as Entity;
const storeOf = (r: Row): Store => ({ code: r.code, entityCode: r.entity_code }) as unknown as Store;
const paymentOf = (r: Row): Payment => ({ id: r.id, vendorCode: r.vendor_code, amountCents: BigInt(r.amount_cents), status: r.status }) as unknown as Payment;

// What the mailroom hands both readers (module seats.ts triage), for an email sent from the Security page
// (module send_email: an attachment only when it has a name).
function mailroomText(d: Draft): string {
  const attachments = d.attachmentName ? [{ name: d.attachmentName, text: d.attachmentText }] : [];
  return `From: ${d.fromName} <${d.from}>\nSubject: ${d.subject}\n\n${d.body}\n${attachments.map(a => `--- attachment ${a.name}\n${a.text}`).join('\n')}`;
}

function extractSystem(): string {
  const src = readFileSync(path.join(REPO, 'module/spacetimedb/src/seats.ts'), 'utf8');
  const m = /const EXTRACT_SYSTEM = `([\s\S]*?)`;/.exec(src);
  if (!m || m[1].includes('${')) throw new Error('could not read EXTRACT_SYSTEM from seats.ts');
  return m[1];
}

function modelKey(): string {
  const env = readFileSync(path.join(homedir(), '.config/charter/modelstudio.env'), 'utf8');
  const m = /^export MODELSTUDIO_API_KEY=(.+)$/m.exec(env);
  if (!m) throw new Error('MODELSTUDIO_API_KEY not found');
  return m[1].trim().replace(/^"|"$/g, '');
}

// The same request the module's llm.ts makes.
async function read(model: string, system: string, user: string, key: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 600, temperature: 0, enable_thinking: false, response_format: { type: 'json_object' } }),
      signal: AbortSignal.timeout(60_000),
    }).catch(e => e as Error);
    if (!(r instanceof Error) && r.ok) return String(((await r.json()) as any).choices?.[0]?.message?.content ?? '');
    if (attempt === 3) throw new Error(`${model} did not answer: ${r instanceof Error ? r.message : `${r.status} ${(await r.text()).slice(0, 200)}`}`);
  }
}

async function warm(db: string): Promise<string> {
  const [cfg] = await sql(db, 'SELECT sim_date, currency, llm_model, checker_model FROM config');
  setDefaultCurrency(cfg.currency);
  const entities = (await sql(db, 'SELECT code, name, kind, contact_email FROM entity')).map(entityOf);
  const stores = (await sql(db, 'SELECT code, entity_code FROM store')).map(storeOf);
  const payments = (await sql(db, 'SELECT id, vendor_code, amount_cents, status FROM payment')).map(paymentOf);
  const drafts: Draft[] = presets(entities, stores, payments).map(p => p.draft);
  // As payments are released (or held), the first example names the next biggest one still waiting.
  for (const due of payments.filter(p => p.status === 'prepared')) {
    const v = entities.find(e => e.code === due.vendorCode);
    if (v) drafts.push(vendorPreset(v, due).draft);
  }
  const texts = [...new Set(drafts.map(mailroomText))];
  const system = extractSystem();
  const key = modelKey();
  const carried: { at: string; purpose: string; model: string; promptHash: string; response: string }[] = [];
  let cached = 0;
  for (const text of texts) {
    for (const [purpose, model] of [['extract', cfg.llm_model], ['extract-check', cfg.checker_model]] as const) {
      if (!model) continue;
      const promptHash = createHash('sha256').update(`${model}|${system}|${text}`).digest('hex');
      if ((await sql(db, `SELECT id, status FROM llm_call WHERE prompt_hash = '${promptHash}'`)).some(c => c.status === 200)) {
        cached++;
        continue;
      }
      carried.push({ at: cfg.sim_date, purpose, model, promptHash, response: await read(model, system, text, key) });
    }
  }
  if (carried.length) await call(db, 'carry_llm_calls', JSON.stringify(carried));
  return `${texts.length} example emails: ${carried.length} readings carried, ${cached} already cached`;
}

// ---------- the step bar ----------

async function steps(): Promise<unknown> {
  const misapplied = await sql(DB_B, "SELECT id, kind FROM activity WHERE command = 'misapplied'");
  const moment = Math.min(...misapplied.filter(a => a.kind === 'ask').map(a => Number(a.id)));
  // The first notice the kernel refused because the customer's own money covered it (C16).
  const refusals = (await sql(DB_B, "SELECT id, value, valid_from FROM fact WHERE attr = 'notice_refused'")).sort((x, y) => (x.valid_from < y.valid_from ? -1 : x.valid_from > y.valid_from ? 1 : Number(x.id) - Number(y.id)));
  const rightAlone = Number(refusals.length ? JSON.parse(refusals[0].value).activity : NaN);
  const holds = (await sql(DB_A, "SELECT id, outcome, shadow, features FROM decision WHERE domain = 'pre_chase'")).filter(d => {
    const f = JSON.parse(d.features || '{}');
    return d.outcome === 'hold' && !d.shadow && f.days_past_due > 0 && f.days_past_due <= (f.grace_days ?? 0);
  });
  const hold = Math.max(...holds.map(d => Number(d.id)));
  const used = (await sql(DB_A, 'SELECT id, used FROM activity')).filter(a => (JSON.parse(a.used || '[]') as string[]).includes(`decision:${hold}`));
  const pushback = Math.max(...used.map(a => Number(a.id)));
  if (![rightAlone, moment, hold, pushback].every(Number.isFinite)) throw new Error(`the demo's beats are not in these runs (right alone ${rightAlone}, moment ${moment}, hold ${hold}, push back ${pushback})`);
  const rows: Record<string, number> = { right_alone: rightAlone, moment, pushback };
  // The beats are the demo table's, in its order and words (tools/demo/steps.py); only the rows are these
  // databases'. Row ids change with every rebuild, so the page finds the rows of the beats marked `find`
  // again in the live tables (web/src/components/DemoBar.tsx).
  const src = readFileSync(path.join(REPO, 'tools/demo/steps.py'), 'utf8');
  const block = /^steps = \[\n([\s\S]*?)\n\]/m.exec(src)?.[1] ?? '';
  const steps = [...block.matchAll(/\{"label": "([^"]+)", "db": "charter-([ab])", "hash": f?"([^"]+)"\}/g)].map(([, label, co, hash]) => {
    const name = /\{(\w+)\}/.exec(hash)?.[1];
    if (name && !(name in rows)) throw new Error(`tools/demo/steps.py has a beat this script cannot find: ${label} (${name})`);
    return { label, db: co === 'a' ? DB_A : DB_B, hash: name ? hash.replace(`{${name}}`, String(rows[name])) : hash, ...(name ? { find: name } : {}) };
  });
  if (steps.length < block.split('\n').filter(l => l.includes('"label"')).length || !steps.length) throw new Error('could not read the steps in tools/demo/steps.py');
  return { persona: 'dana', steps };
}

async function main(): Promise<void> {
  if (!existsSync(path.join(REPO, 'module/spacetimedb/src/seats.ts'))) throw new Error('run from the checkout root');
  const who = await people();
  console.log(`people: ${Object.entries(who).map(([n, p]) => `${n} 0x${p.identity.slice(0, 10)}…`).join(', ')}, bound in ${DB_A} and ${DB_B}`);
  for (const db of [DB_A, DB_B]) console.log(`${db}: ${await warm(db)}`);
  writeFileSync(path.join(PLAY, 'steps.json'), JSON.stringify(await steps(), null, 1) + '\n');
  console.log(`steps in ${path.join(PLAY, 'steps.json')}`);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
