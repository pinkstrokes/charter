// Connections. One observer (the Outsider's identity: everything here is a
// public table) subscribes to the organisation and feeds the store. Every other
// persona gets its own connection with its own token and no subscriptions; it
// exists only so that reducers are called as that person and the kernel judges
// that identity, not ours.
import { useSyncExternalStore } from 'react';
import { charterApi, isPlay, isPublic, type Company } from './api';
import { setGlobalLogLevel } from 'spacetimedb';
import { DbConnection } from '../module_bindings';

// The SDK logs every connection attempt at info level; keep the console for real problems.
setGlobalLogLevel('warn');
import { store, TABLES, type ConnState, type TableName } from './store';

export interface Persona {
  key: string;
  name: string;
  role: string; // controller | consultant | outsider
  identity: string;
  token: string;
}

export interface PersonaConn {
  persona: Persona;
  conn: DbConnection | null;
  state: ConnState;
  error: string;
  identity: string; // as reported by the server on connect
}

export interface ClientInfo {
  db: string;
  wsBase: string;
  httpBase: string;
  source: string; // where persona tokens came from
  managed: boolean; // persona bindings created by the dev middleware
  error: string;
  warning: string; // e.g. watching read-only because no identities file exists yet
  personas: PersonaConn[];
  active: string;
  companies: Company[]; // what a public page (or the live demo's server) lets a visitor switch between
  demo: boolean; // the live demo's server: show the step bar
}

const FACT_ATTRS = [
  'audit',
  'callback',
  'collections_hold',
  'payer_alias',
  'email_sales_report',
  'email_remittance',
  'email_routing_change',
  'email_dispute',
  'email_promise_to_pay',
  'email_refund_request',
  'email_other',
];

const QUERIES = [
  'SELECT * FROM config',
  'SELECT * FROM principal',
  'SELECT * FROM entity',
  'SELECT * FROM store',
  'SELECT * FROM contract_version',
  'SELECT * FROM invoice',
  'SELECT * FROM receipt',
  'SELECT * FROM application',
  'SELECT * FROM gl_balance',
  'SELECT * FROM control_total',
  'SELECT * FROM debit_instruction',
  'SELECT * FROM routing_request',
  'SELECT * FROM work_item',
  'SELECT * FROM ask',
  'SELECT * FROM activity',
  'SELECT * FROM chain_head',
  'SELECT * FROM skill',
  'SELECT * FROM policy',
  'SELECT * FROM decision',
  'SELECT * FROM refund',
  'SELECT * FROM security_event',
  'SELECT * FROM seat_state',
  'SELECT * FROM rule_stat',
  'SELECT * FROM bill',
  'SELECT * FROM payment',
  'SELECT * FROM finding',
  'SELECT * FROM audit_opinion',
  'SELECT * FROM period_close',
  "SELECT * FROM observation WHERE kind = 'email'",
  ...FACT_ATTRS.map(a => `SELECT * FROM fact WHERE attr = '${a}'`),
];

type Listener = () => void;

class Charter {
  info: ClientInfo = { db: '', wsBase: '', httpBase: '', source: '', managed: false, error: '', warning: '', personas: [], active: '', companies: [], demo: false };
  private listeners = new Set<Listener>();
  private observer: DbConnection | null = null;
  private extra = new Set<string>();
  private started = false;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<ClientInfo>): void {
    this.info = { ...this.info, ...patch };
    for (const fn of this.listeners) fn();
  }

  private patchPersona(key: string, patch: Partial<PersonaConn>): void {
    this.set({ personas: this.info.personas.map(p => (p.persona.key === key ? { ...p, ...patch } : p)) });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const params = new URLSearchParams(window.location.search);
    try {
      const env = (await (await fetch(charterApi('env'))).json()) as { defaultDb: string; wsBase: string; httpBase: string; companies?: Company[]; demo?: boolean };
      const db = params.get('db') || (import.meta.env.VITE_CHARTER_DB as string | undefined) || env.defaultDb;
      const wsBase = params.get('ws') || (import.meta.env.VITE_STDB_WS as string | undefined) || env.wsBase;
      // The step bar: the live demo's server, and the sandbox (which has the steps but no reset).
      this.set({ db, wsBase, httpBase: env.httpBase, companies: env.companies ?? [], demo: (isPlay || !isPublic) && !!env.demo });
      document.title = `Charter · ${db}`;
      await this.loadPersonas(db, false);
    } catch (e) {
      this.set({ error: message(e) });
      store.setStatus({ state: 'error', error: message(e) });
    }
  }

  // Bind the same identities again (after a reseed); reconnect only if the tokens changed.
  async rebind(): Promise<void> {
    if (isPublic) return; // a public page binds nobody
    const res = await fetch(`/__charter/personas/rebind?db=${encodeURIComponent(this.info.db)}`, { method: 'POST' });
    const body = (await res.json()) as { error?: string; personas: Persona[] };
    if (!res.ok || body.error) {
      this.set({ error: body.error || `rebind: HTTP ${res.status}` });
      return;
    }
    const same = body.personas.length === this.info.personas.length && body.personas.every(p => this.info.personas.some(q => q.persona.key === p.key && q.persona.token === p.token));
    if (!same) await this.loadPersonas(this.info.db, false);
  }

  private async loadPersonas(db: string, rebind: boolean): Promise<void> {
    const res = rebind ? await fetch(`/__charter/personas/rebind?db=${encodeURIComponent(db)}`, { method: 'POST' }) : await fetch(charterApi('personas', db));
    const body = (await res.json()) as { error?: string; warning?: string; source: string; managed: boolean; personas: Persona[] };
    if (!res.ok || body.error) throw new Error(body.error || `personas: HTTP ${res.status}`);
    for (const p of this.info.personas) p.conn?.disconnect();
    this.observer = null;
    const remembered = safeGet(`charter.persona.${db}`);
    const active = body.personas.find(p => p.key === remembered)?.key ?? body.personas[0]?.key ?? '';
    this.set({
      source: body.source,
      managed: body.managed,
      error: '',
      warning: body.warning ?? '',
      active,
      personas: body.personas.map(persona => ({ persona, conn: null, state: 'connecting', error: '', identity: '' })),
    });
    for (const p of body.personas) this.connect(p);
  }

  private connect(persona: Persona): void {
    const isObserver = persona.key === 'outsider';
    if (isObserver) store.setStatus({ state: 'connecting', error: '', ready: false });
    const conn = DbConnection.builder()
      .withUri(this.info.wsBase)
      .withDatabaseName(this.info.db)
      .withToken(persona.token)
      .withAutomaticReconnect()
      .onConnect((c, identity) => {
        this.patchPersona(persona.key, { state: 'live', error: '', identity: identity.toHexString() });
        if (isObserver) this.subscribeAll(c);
      })
      .onAutomaticReconnect((_c, identity) => {
        this.patchPersona(persona.key, { state: 'live', error: '', identity: identity.toHexString() });
        if (isObserver) store.setStatus({ state: 'live', error: '' });
      })
      .onConnectError((_ctx, error, attempt) => {
        const msg = describeConnError(error, this.info.db);
        this.patchPersona(persona.key, { state: attempt === undefined ? 'error' : 'reconnecting', error: msg });
        if (isObserver) store.setStatus({ state: attempt === undefined ? 'error' : 'reconnecting', error: msg });
      })
      .onDisconnect((_ctx, error, attempt) => {
        const msg = error ? describeConnError(error, this.info.db) : '';
        this.patchPersona(persona.key, { state: attempt === undefined ? 'error' : 'reconnecting', error: msg || 'disconnected' });
        if (isObserver) store.setStatus({ state: attempt === undefined ? 'error' : 'reconnecting', error: msg || 'disconnected' });
      })
      .build();
    this.patchPersona(persona.key, { conn });
    if (isObserver) {
      this.observer = conn;
      store.attach(conn.db as unknown as Record<string, { iter(): Iterable<unknown> }>);
      this.watchTables(conn);
    }
  }

  private watchTables(conn: DbConnection): void {
    const db = conn.db as unknown as Record<string, { onInsert?: (cb: (...a: unknown[]) => void) => void; onDelete?: (cb: (...a: unknown[]) => void) => void; onUpdate?: (cb: (...a: unknown[]) => void) => void }>;
    for (const t of TABLES) {
      const h = db[t];
      if (!h) continue;
      h.onInsert?.((_ctx: unknown, row: unknown) => {
        if (t === 'activity' && store.status.ready) store.liveActivity.set((row as { id: bigint }).id, Date.now());
        store.touch(t);
      });
      h.onDelete?.(() => store.touch(t));
      h.onUpdate?.(() => store.touch(t));
    }
  }

  private subscribeAll(conn: DbConnection): void {
    const started = performance.now();
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        store.touchAll();
        store.setStatus({ state: 'live', error: '', ready: true, loadedAt: Math.round(performance.now() - started) });
      })
      .onError(ctx => {
        const err = (ctx as unknown as { event?: unknown }).event;
        store.setStatus({ state: 'error', error: `subscription failed: ${message(err)}` });
      })
      .subscribe(QUERIES);
  }

  // Pull in one more row on demand (a fact or observation a Why panel cites).
  ensure(table: 'fact' | 'observation', id: bigint): void {
    const key = `${table}:${id}`;
    if (this.extra.has(key) || !this.observer) return;
    this.extra.add(key);
    this.observer.subscriptionBuilder().subscribe(`SELECT * FROM ${table} WHERE id = ${id.toString()}`);
  }

  // The sandbox's World screen delivers as the play databases' own world feeder, the way the dev
  // server's middleware delivers with the feeder of a run's identities file (plugins/charter-core.ts).
  private world: Promise<DbConnection> | null = null;

  worldConnection(): Promise<DbConnection> {
    if (!isPlay) return Promise.reject(new Error('only the sandbox delivers from the browser'));
    this.world ??= (async () => {
      const res = await fetch(charterApi('world'));
      const body = (await res.json()) as { token?: string };
      if (!res.ok || !body.token) throw new Error(`the World screen's feeder: HTTP ${res.status}`);
      return await new Promise<DbConnection>((resolve, reject) => {
        DbConnection.builder()
          .withUri(this.info.wsBase)
          .withDatabaseName(this.info.db)
          .withToken(body.token)
          .onConnect(c => resolve(c))
          .onConnectError((_ctx, error) => reject(new Error(describeConnError(error, this.info.db))))
          .onDisconnect(() => {
            this.world = null;
          })
          .build();
      });
    })().catch(e => {
      this.world = null;
      throw e;
    });
    return this.world;
  }

  setActive(key: string): void {
    if (!this.info.personas.some(p => p.persona.key === key)) return;
    safeSet(`charter.persona.${this.info.db}`, key);
    this.set({ active: key });
  }

  activePersona(): PersonaConn | undefined {
    return this.info.personas.find(p => p.persona.key === this.info.active);
  }

  persona(key: string): PersonaConn | undefined {
    return this.info.personas.find(p => p.persona.key === key);
  }

  switchDatabase(db: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set('db', db);
    window.location.href = url.toString();
  }
}

export const charter = new Charter();

export function useCharter(): ClientInfo {
  return useSyncExternalStore(charter.subscribe, () => charter.info);
}

export function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function describeConnError(e: unknown, db: string): string {
  const m = message(e);
  if (/404|not found/i.test(m)) return `database ${db} not found on the server`;
  if (/failed|refused|closed|1006/i.test(m)) return `cannot reach SpacetimeDB (${m})`;
  return m;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice just won't persist */
  }
}

export type { TableName };
