// A client-side mirror of the subscribed tables. The SDK keeps the canonical
// cache; this store snapshots it into immutable arrays at most once per frame so
// React re-renders only the screens whose tables changed.
import { useSyncExternalStore } from 'react';
import type * as T from '../module_bindings/types';
import { setDefaultCurrency } from '../lib/format';

export interface Rows {
  config: T.Config[];
  principal: T.Principal[];
  entity: T.Entity[];
  store: T.Store[];
  contractVersion: T.ContractVersion[];
  invoice: T.Invoice[];
  receipt: T.Receipt[];
  application: T.Application[];
  glBalance: T.GlBalance[];
  controlTotal: T.ControlTotal[];
  debitInstruction: T.DebitInstruction[];
  routingRequest: T.RoutingRequest[];
  workItem: T.WorkItem[];
  ask: T.Ask[];
  activity: T.Activity[];
  chainHead: T.ChainHead[];
  skill: T.Skill[];
  policy: T.Policy[];
  decision: T.Decision[];
  refund: T.Refund[];
  securityEvent: T.SecurityEvent[];
  seatState: T.SeatState[];
  observation: T.Observation[];
  fact: T.Fact[];
  ruleStat: T.RuleStat[];
  bill: T.Bill[];
  payment: T.Payment[];
  finding: T.Finding[];
  auditOpinion: T.AuditOpinion[];
  periodClose: T.PeriodClose[];
}
export type TableName = keyof Rows;

export const TABLES: TableName[] = [
  'config',
  'principal',
  'entity',
  'store',
  'contractVersion',
  'invoice',
  'receipt',
  'application',
  'glBalance',
  'controlTotal',
  'debitInstruction',
  'routingRequest',
  'workItem',
  'ask',
  'activity',
  'chainHead',
  'skill',
  'policy',
  'decision',
  'refund',
  'securityEvent',
  'seatState',
  'observation',
  'fact',
  'ruleStat',
  'bill',
  'payment',
  'finding',
  'auditOpinion',
  'periodClose',
];

export type ConnState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

export interface StoreStatus {
  state: ConnState;
  error: string;
  ready: boolean; // initial subscription applied
  loadedAt: number;
}

type TableSource = { iter(): Iterable<unknown> };

export class Store {
  rows: Rows = Object.fromEntries(TABLES.map(t => [t, []])) as unknown as Rows;
  status: StoreStatus = { state: 'idle', error: '', ready: false, loadedAt: 0 };
  private listeners = new Set<() => void>();
  private dirty = new Set<TableName>();
  private scheduled = false;
  private source: Record<string, TableSource> | null = null;
  // Activity ids that arrived live (after the first snapshot), for a brief highlight.
  readonly liveActivity = new Map<bigint, number>();

  attach(db: Record<string, TableSource>): void {
    this.source = db;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  setStatus(patch: Partial<StoreStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  touch(table: TableName): void {
    this.dirty.add(table);
    if (this.scheduled) return;
    this.scheduled = true;
    // Next frame when the page is painting; a timer as well, because frames
    // stop in background tabs and the store must still settle.
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      this.scheduled = false;
      this.flush();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    setTimeout(run, 40);
  }

  touchAll(): void {
    for (const t of TABLES) this.dirty.add(t);
    this.flush();
  }

  private flush(): void {
    if (!this.source || this.dirty.size === 0) return;
    const next = { ...this.rows } as Record<string, unknown[]>;
    for (const t of this.dirty) {
      const src = this.source[t];
      next[t] = src ? Array.from(src.iter()) : [];
    }
    // Amounts follow the company's currency; when it changes, every table gets a new
    // snapshot so every screen re-renders its figures with the new symbol.
    if (this.dirty.has('config') && setDefaultCurrency((next.config[0] as T.Config | undefined)?.currency)) {
      for (const t of TABLES) if (!this.dirty.has(t)) next[t] = [...next[t]];
    }
    this.dirty.clear();
    this.rows = next as unknown as Rows;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const store = new Store();

export function useRows<K extends TableName>(name: K): Rows[K] {
  return useSyncExternalStore(store.subscribe, () => store.rows[name]);
}

export function useStatus(): StoreStatus {
  return useSyncExternalStore(store.subscribe, () => store.status);
}
