// Persona tokens, proof files and the evolution log for the Charter UI, shared
// by the dev middleware (plugins/charter-dev.ts) and scripts/personas.ts.
//
// Endpoints the middleware serves with these:
//   GET  /__charter/env                 default database, server URLs
//   GET  /__charter/personas?db=NAME    tokens for Dana, Sam, Lee, Priya and an unbound Outsider
//   POST /__charter/personas/rebind?db=NAME   rebind self-managed personas (after a reseed)
//   GET  /__charter/proof?db=NAME       run_report.json and eval/*.json from data/companyA (charter-a),
//                                       data/companyB (charter-b), web/.data/NAME (a development database
//                                       whose report scripts/seed_story.py wrote there) or data/dev;
//                                       ?dir=companyB (any folder under data/) or ?dir=local overrides;
//                                       plus data/benchrec_eval/result.json, whatever the folder
//   POST /__charter/world?db=NAME       a made-up payment or bill, delivered by the database's world feeder
//
// Persona tokens come from an identities file written by the world builder
// (data/companyA/identities.json for charter-a, or $CHARTER_IDENTITIES), or, for
// development databases such as charter-ui, from web/.personas/<db>.json, which
// this middleware creates by minting identities and binding them with the CLI's
// admin token. Tokens never leave this machine: the middleware only runs inside
// `vite` / `vite preview` on localhost.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface IdentityEntry {
  identity: string;
  token: string;
  role: string;
}

export interface PersonaOut {
  key: string;
  name: string;
  role: string; // 'controller' | 'consultant' | 'outsider'
  identity: string;
  token: string;
}

const HUMAN_ROLES = new Set(['controller', 'consultant']);
const SELF_MANAGED: { name: string; role: string }[] = [
  { name: 'Dana', role: 'controller' },
  { name: 'Sam', role: 'controller' },
  { name: 'Lee', role: 'consultant' },
  { name: 'Priya', role: 'consultant' },
];
const ORDER = ['Dana', 'Sam', 'Lee', 'Priya'];
const NEVER_BIND = new Set(['charter-iqwfr']);

// A payment or a bill made up on the World screen (amounts in cents).
export interface WorldEvent {
  kind: 'payment' | 'bill';
  amountCents: number;
  type?: string;
  counterpartyName?: string;
  counterpartyAccount?: string;
  reference?: string;
  vendorCode?: string;
  billNo?: string;
  poNo?: string;
  dueDate?: string;
}

export interface CoreOptions {
  repoRoot: string;
  webRoot: string;
}

export function createCharterCore(opts: CoreOptions) {
  const httpBase = (process.env.STDB_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const defaultDb = process.env.CHARTER_DB || process.env.VITE_CHARTER_DB || 'charter-ui';
  const dataDir = path.resolve(opts.repoRoot, process.env.CHARTER_DATA_DIR || 'data/companyA');
  const personaDir = path.join(opts.webRoot, '.personas');
  let adminToken: string | null = null;

  function getAdminToken(): string {
    if (adminToken) return adminToken;
    const out = execFileSync('spacetime', ['login', 'show', '--token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const word = out.split(/\s+/).find(w => w.split('.').length === 3 && w.length > 40);
    if (!word) throw new Error('could not read the CLI token from `spacetime login show --token`');
    adminToken = word;
    return word;
  }

  async function stdb(method: string, p: string, body?: unknown, token?: string): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {};
    let data: string | undefined;
    if (body !== undefined) {
      if (typeof body === 'string') {
        data = body;
        headers['Content-Type'] = 'text/plain';
      } else {
        data = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(httpBase + p, { method, headers, body: data });
    return { status: res.status, text: await res.text() };
  }

  async function mintIdentity(): Promise<{ identity: string; token: string }> {
    const r = await stdb('POST', '/v1/identity');
    if (r.status !== 200) throw new Error(`could not mint an identity: ${r.status} ${r.text.slice(0, 200)}`);
    const d = JSON.parse(r.text) as { identity: string; token: string };
    return { identity: norm(d.identity), token: d.token };
  }

  async function principals(db: string): Promise<{ identity: string; role: string; name: string }[]> {
    const r = await stdb('POST', `/v1/database/${encodeURIComponent(db)}/sql`, 'SELECT * FROM principal', getAdminToken());
    if (r.status !== 200) throw new Error(`database ${db}: ${r.status} ${r.text.slice(0, 200)}`);
    const res = JSON.parse(r.text) as { schema: { elements: { name: { some: string } }[] }; rows: unknown[][] }[];
    if (!res.length) return [];
    const names = res[0].schema.elements.map(e => e.name.some);
    return res[0].rows.map(row => {
      const o = Object.fromEntries(names.map((n, i) => [n, row[i]])) as Record<string, unknown>;
      const id = Array.isArray(o.identity) ? String(o.identity[0]) : String(o.identity);
      return { identity: norm(id), role: String(o.role), name: String(o.name) };
    });
  }

  function readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }

  // Which identities file belongs to this database. World-built databases
  // (charter-a, charter-b, ...) always use the file their builder writes; this
  // middleware never binds identities in them.
  function externalFile(db: string): string | null {
    if (process.env.CHARTER_IDENTITIES) return path.resolve(opts.repoRoot, process.env.CHARTER_IDENTITIES);
    const m = /^charter-([a-z])$/.exec(db);
    if (m) return path.join(opts.repoRoot, 'data', `company${m[1].toUpperCase()}`, 'identities.json');
    return null;
  }

  async function outsider(): Promise<IdentityEntry> {
    const file = path.join(personaDir, 'outsider.json');
    const existing = readJson<IdentityEntry>(file);
    if (existing?.token) return existing;
    const minted = await mintIdentity();
    const entry = { ...minted, role: 'outsider' };
    writeJson(file, entry);
    return entry;
  }

  async function selfManaged(db: string, force: boolean): Promise<Record<string, IdentityEntry>> {
    const file = path.join(personaDir, `${db}.json`);
    const current = readJson<Record<string, IdentityEntry>>(file) ?? {};
    const bound = await principals(db);
    let changed = false;
    for (const want of SELF_MANAGED) {
      let entry = current[want.name];
      if (!entry?.token) {
        entry = { ...(await mintIdentity()), role: want.role };
        current[want.name] = entry;
        changed = true;
      }
      const ok = bound.some(p => p.identity === norm(entry.identity) && p.role === want.role && p.name === want.name);
      // Never take a name away from another identity on page load (a seeding script may be
      // using it right now); that needs an explicit rebind.
      const heldByOther = bound.some(p => p.role === want.role && p.name === want.name && p.identity !== norm(entry.identity));
      if (force || (!ok && !heldByOther)) {
        const r = await stdb('POST', `/v1/database/${encodeURIComponent(db)}/call/bind_role`, [{ __identity__: `0x${norm(entry.identity)}` }, want.role, want.name], getAdminToken());
        if (r.status !== 200) throw new Error(`bind_role ${want.name} on ${db}: ${r.status} ${r.text.slice(0, 200)}`);
        changed = true;
      }
    }
    if (changed || !fs.existsSync(file)) writeJson(file, current);
    return current;
  }

  // Personas for the switcher. When a world-built database has no identities
  // file yet, the page still gets the Outsider so it can watch read-only.
  async function personas(db: string, force = false): Promise<{ source: string; managed: boolean; personas: PersonaOut[]; warning?: string }> {
    const ext = externalFile(db);
    let entries: Record<string, IdentityEntry> = {};
    let source: string;
    let managed = false;
    let warning: string | undefined;
    if (ext) {
      source = path.relative(opts.repoRoot, ext);
      if (fs.existsSync(ext)) entries = readJson<Record<string, IdentityEntry>>(ext) ?? {};
      else warning = `${source} does not exist yet; the world builder writes it when ${db} is seeded. Watching as the Outsider only.`;
    } else if (NEVER_BIND.has(db)) {
      throw new Error(`${db} is off limits for this UI`);
    } else {
      entries = await selfManaged(db, force);
      source = path.relative(opts.repoRoot, path.join(personaDir, `${db}.json`));
      managed = true;
    }
    const people: PersonaOut[] = Object.entries(entries)
      .filter(([, e]) => e && HUMAN_ROLES.has(e.role) && e.token)
      .map(([name, e]) => ({ key: name.toLowerCase(), name: name.charAt(0).toUpperCase() + name.slice(1), role: e.role, identity: norm(e.identity), token: e.token }))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    const out = await outsider();
    people.push({ key: 'outsider', name: 'Outsider', role: 'outsider', identity: norm(out.identity), token: out.token });
    return { source, managed, personas: people, warning };
  }

  // Something arriving from outside, made up on the World screen: a payment in the
  // bank feed or a bill in the AP inbox. The database's own world feeder delivers it
  // through ingest_obs, exactly as the simulation delivers its events; nothing about
  // it tells a seat it was made up except the LIVE- prefix the bank gives it. With
  // autopilot off the seats run once so the page sees what they did.
  async function world(db: string, body: WorldEvent): Promise<{ id: string; date: string; existed: boolean; ran: string | null }> {
    const ext = externalFile(db);
    const ids = ext ? readJson<Record<string, IdentityEntry>>(ext) : null;
    const feeder = ids && Object.values(ids).find(e => e?.role === 'world' && e.token);
    if (!feeder) throw new Error(`${db} has no world feeder in its identities file; only world-built databases take made-up events`);
    const query = async (sql: string) => {
      const r = await stdb('POST', `/v1/database/${encodeURIComponent(db)}/sql`, sql, getAdminToken());
      if (r.status !== 200) throw new Error(`database ${db}: ${r.status} ${r.text.slice(0, 200)}`);
      const res = JSON.parse(r.text) as { schema: { elements: { name: { some: string } }[] }; rows: unknown[][] }[];
      const names = res[0]?.schema.elements.map(e => e.name.some) ?? [];
      return (res[0]?.rows ?? []).map(row => Object.fromEntries(names.map((n, i) => [n, row[i]])) as Record<string, unknown>);
    };
    const [cfg] = await query('SELECT sim_date, autopilot FROM config');
    const date = String(cfg?.sim_date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${db} has no business date yet`);
    const cents = Number(body.amountCents);
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 10_000_000_000) throw new Error('the amount must be positive');
    const text = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
    let kind: string, source: string, refKey: string, subject: string, id: string, payload: Record<string, unknown>;
    if (body.kind === 'payment') {
      const type = ['wire_in', 'ach_credit_in', 'check_deposit'].includes(String(body.type)) ? String(body.type) : 'wire_in';
      const account = text(body.counterpartyAccount, 8);
      if (!/^\*{4}\d{4}$/.test(account)) throw new Error('the paying account is written ****1234');
      const name = text(body.counterpartyName, 80);
      if (!name) throw new Error('who is paying?');
      id = `LIVE-${date.slice(2).replace(/-/g, '')}-${String(Math.floor(1000 + Math.random() * 9000))}`;
      kind = 'bank_txn';
      source = 'bank';
      refKey = `bank:${id}`;
      subject = `account:${account}`;
      payload = { txnId: id, date, type, amountCents: cents, counterpartyName: name, counterpartyAccount: account, reference: text(body.reference, 140) };
    } else if (body.kind === 'bill') {
      const vendorCode = text(body.vendorCode, 20);
      const billNo = text(body.billNo, 40);
      const dueDate = text(body.dueDate, 10);
      if (!vendorCode || !billNo) throw new Error('a bill needs a vendor and the vendor’s bill number');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error('the due date is written YYYY-MM-DD');
      id = `${vendorCode}:${billNo}`;
      kind = 'vendor_invoice';
      source = 'erp';
      refKey = `bill:${id}`;
      subject = `vendor:${vendorCode}`;
      payload = { billNo, vendorCode, poNo: text(body.poNo, 40), date, dueDate, amountCents: cents };
    } else {
      throw new Error('a made-up event is a payment or a bill');
    }
    const existed = (await query(`SELECT id FROM observation WHERE ref_key = '${refKey.replace(/'/g, "''")}'`)).length > 0;
    const call = async (fn: string, args: unknown[]) => {
      const r = await stdb('POST', `/v1/database/${encodeURIComponent(db)}/call/${fn}`, args, feeder.token);
      if (r.status !== 200) throw new Error(`${fn}: ${r.status} ${r.text.slice(0, 300)}`);
      return r.text;
    };
    await call('ingest_obs', [kind, source, date, refKey, subject, JSON.stringify(payload)]);
    const ran = cfg?.autopilot ? null : await call('run_seats', []);
    return { id, date, existed, ran };
  }

  // Where the world builder and evolution engine write for this database (same rule as tools/evolve).
  // A development database's own report (web/.data/<db>, gitignored), written by scripts/seed_story.py.
  const localDir = (db: string) => path.join(opts.webRoot, '.data', db);
  const hasProof = (dir: string) => fs.existsSync(path.join(dir, 'eval')) || fs.existsSync(path.join(dir, 'run_report.json'));

  function companyDir(db: string, override?: string | null): string {
    if (override === 'local' && /^[A-Za-z0-9_-]+$/.test(db)) return localDir(db);
    if (override && /^[A-Za-z0-9_-]+$/.test(override)) return path.join(opts.repoRoot, 'data', override);
    if (process.env.CHARTER_DATA_DIR) return dataDir;
    const m = /^charter-([a-z])$/.exec(db);
    if (m) return path.join(opts.repoRoot, 'data', `company${m[1].toUpperCase()}`);
    if (/^[A-Za-z0-9_-]+$/.test(db) && hasProof(localDir(db))) return localDir(db);
    return path.join(opts.repoRoot, 'data', 'dev');
  }

  // Choices for the folder picker: every folder under data/ with proof files, and this database's own.
  function availableDirs(db: string): { id: string; label: string }[] {
    const root = path.join(opts.repoRoot, 'data');
    const out = fs.existsSync(root)
      ? fs
          .readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory() && hasProof(path.join(root, d.name)))
          .map(d => ({ id: d.name, label: `data/${d.name}` }))
          .sort((a, b) => a.id.localeCompare(b.id))
      : [];
    if (/^[A-Za-z0-9_-]+$/.test(db) && hasProof(localDir(db))) out.push({ id: 'local', label: `web/.data/${db}` });
    return out;
  }

  // The bank-reconciliation benchmark (tools/benchrec) is not tied to a company: one file, served with every proof response.
  function benchrec(): { json?: unknown; error?: string; modified?: string } | null {
    const f = path.join(opts.repoRoot, 'data', 'benchrec_eval', 'result.json');
    if (!fs.existsSync(f)) return null;
    try {
      // The same desks month by month (tools/benchrec/monthly.ts), when it has been run.
      const m = path.join(path.dirname(f), 'monthly.json');
      const monthly = fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : undefined;
      return { json: { ...JSON.parse(fs.readFileSync(f, 'utf8')), monthly }, modified: fs.statSync(f).mtime.toISOString() };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  function proofFiles(
    dir: string,
    db = ''
  ): { dir: string; current: string; available: { id: string; label: string }[]; files: { name: string; json?: unknown; error?: string; modified?: string }[]; benchrec: { json?: unknown; error?: string; modified?: string } | null } {
    const files: { name: string; json?: unknown; error?: string; modified?: string }[] = [];
    const candidates: string[] = [];
    const report = path.join(dir, 'run_report.json');
    if (fs.existsSync(report)) candidates.push(report);
    const evalDir = path.join(dir, 'eval');
    if (fs.existsSync(evalDir)) for (const f of fs.readdirSync(evalDir).sort()) if (f.endsWith('.json')) candidates.push(path.join(evalDir, f));
    for (const f of candidates) {
      const name = path.relative(dir, f);
      try {
        const stat = fs.statSync(f);
        if (stat.size > 8_000_000) {
          files.push({ name, error: `${(stat.size / 1e6).toFixed(1)} MB is too large to show here`, modified: stat.mtime.toISOString() });
          continue;
        }
        files.push({ name, json: JSON.parse(fs.readFileSync(f, 'utf8')), modified: stat.mtime.toISOString() });
      } catch (e) {
        files.push({ name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const current = path.resolve(dir) === path.resolve(localDir(db)) ? 'local' : path.basename(dir);
    return { dir: path.relative(opts.repoRoot, dir), current, available: availableDirs(db), files, benchrec: benchrec() };
  }

  return { httpBase, defaultDb, personas, externalFile, companyDir, proofFiles, world };
}

export type CharterCore = ReturnType<typeof createCharterCore>;

function norm(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, '');
}

function rank(name: string): number {
  const i = ORDER.indexOf(name);
  return i < 0 ? 99 : i;
}
