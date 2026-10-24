// Persona tokens, proof files and the evolution log for the Charter UI, shared
// by the dev middleware (plugins/charter-dev.ts) and scripts/personas.ts.
//
// Endpoints the middleware serves with these:
//   GET  /__charter/env                 default database, server URLs
//   GET  /__charter/personas?db=NAME    tokens for Dana, Sam, Lee, Priya and an unbound Outsider
//   POST /__charter/personas/rebind?db=NAME   rebind self-managed personas (after a reseed)
//   GET  /__charter/proof?db=NAME       run_report.json and eval/*.json from data/companyA (charter-a),
//                                       data/companyB (charter-b) or data/dev (anything else); ?dir= overrides
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

  // Where the world builder and evolution engine write for this database (same rule as tools/evolve).
  function companyDir(db: string, override?: string | null): string {
    if (override && /^[A-Za-z0-9_-]+$/.test(override)) return path.join(opts.repoRoot, 'data', override);
    if (process.env.CHARTER_DATA_DIR) return dataDir;
    const m = /^charter-([a-z])$/.exec(db);
    if (m) return path.join(opts.repoRoot, 'data', `company${m[1].toUpperCase()}`);
    return path.join(opts.repoRoot, 'data', 'dev');
  }

  function availableDirs(): string[] {
    const root = path.join(opts.repoRoot, 'data');
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && (fs.existsSync(path.join(root, d.name, 'eval')) || fs.existsSync(path.join(root, d.name, 'run_report.json'))))
      .map(d => d.name)
      .sort();
  }

  function proofFiles(dir: string): { dir: string; available: string[]; files: { name: string; json?: unknown; error?: string; modified?: string }[] } {
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
    return { dir: path.relative(opts.repoRoot, dir), available: availableDirs(), files };
  }

  return { httpBase, defaultDb, personas, externalFile, companyDir, proofFiles };
}

export type CharterCore = ReturnType<typeof createCharterCore>;

function norm(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, '');
}

function rank(name: string): number {
  const i = ORDER.indexOf(name);
  return i < 0 ? 99 : i;
}
