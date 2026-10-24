// Shared selectors over the live tables.
import { useMemo } from 'react';
import type { Activity, Ask, Config, Policy, Principal } from '../module_bindings/types';
import { useCharter, type PersonaConn } from '../stdb/client';
import { useRows } from '../stdb/store';
import { policyById } from '../lib/policies';

export function useConfig(): Config | undefined {
  const rows = useRows('config');
  return rows[0];
}

export function useActivityDesc(): Activity[] {
  const rows = useRows('activity');
  return useMemo(() => [...rows].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)), [rows]);
}

export function useActivityById(): Map<bigint, Activity> {
  const rows = useRows('activity');
  return useMemo(() => new Map(rows.map(r => [r.id, r])), [rows]);
}

export function usePolicyLookup(): (id: string) => Policy | undefined {
  const rows = useRows('policy');
  return useMemo(() => {
    const cache = new Map<string, Policy | undefined>();
    return (id: string) => {
      if (!cache.has(id)) cache.set(id, policyById(rows, id));
      return cache.get(id);
    };
  }, [rows]);
}

export interface Me {
  pc: PersonaConn | undefined;
  name: string;
  role: string; // the role the server has bound, or the file's role when not yet visible
  principalId: string;
  bound: Principal | undefined;
  isController: boolean;
  isConsultant: boolean;
  isOutsider: boolean;
}

export function useMe(): Me {
  const info = useCharter();
  const principals = useRows('principal');
  return useMemo(() => {
    const pc = info.personas.find(p => p.persona.key === info.active);
    const identity = (pc?.identity || pc?.persona.identity || '').toLowerCase().replace(/^0x/, '');
    const bound = principals.find(p => p.identity.toHexString().toLowerCase().replace(/^0x/, '') === identity);
    const role = bound?.role ?? (pc?.persona.role === 'outsider' ? 'outsider' : pc?.persona.role ?? '');
    const name = bound?.name ?? pc?.persona.name ?? '';
    return {
      pc,
      name: pc?.persona.name ?? '',
      role,
      principalId: `${role}:${name}`,
      bound,
      isController: role === 'controller',
      isConsultant: role === 'consultant',
      isOutsider: !bound,
    };
  }, [info, principals]);
}

export function openAsksFor(asks: Ask[], role: string): Ask[] {
  return asks
    .filter(a => a.status === 'open' && (role === 'controller' || a.toRole === role))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function useOpenAskCount(): number {
  const asks = useRows('ask');
  const me = useMe();
  return useMemo(() => (me.isOutsider ? 0 : openAsksFor(asks, me.role).length), [asks, me]);
}
