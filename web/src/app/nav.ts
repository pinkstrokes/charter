// Hash routing: #/screen/sub?why=ID. Kept in the URL so a refresh during a demo
// lands on the same screen with the same Why panel open.
import { useSyncExternalStore } from 'react';

export const SCREENS = ['floor', 'inbox', 'knowledge', 'ledger', 'payables', 'security', 'proof'] as const;
export type Screen = (typeof SCREENS)[number];

export interface Nav {
  screen: Screen;
  sub: string;
  why: bigint | null;
}

function parse(): Nav {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const [screen, ...rest] = path.split('/');
  const q = new URLSearchParams(query);
  const why = q.get('why');
  return {
    screen: (SCREENS as readonly string[]).includes(screen) ? (screen as Screen) : 'floor',
    sub: rest.join('/'),
    why: why && /^\d+$/.test(why) ? BigInt(why) : null,
  };
}

let current = parse();
const listeners = new Set<() => void>();

window.addEventListener('hashchange', () => {
  current = parse();
  listeners.forEach(fn => fn());
});

function write(n: Nav, replace = false): void {
  const hash = `#/${n.screen}${n.sub ? `/${n.sub}` : ''}${n.why !== null ? `?why=${n.why.toString()}` : ''}`;
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  current = parse();
  listeners.forEach(fn => fn());
}

export function useNav(): Nav {
  return useSyncExternalStore(
    fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current
  );
}

export function go(screen: Screen, sub = ''): void {
  write({ screen, sub, why: current.why });
}

export function openWhy(id: bigint): void {
  write({ ...current, why: id }, current.why !== null);
}

export function closeWhy(): void {
  write({ ...current, why: null });
}

export function setSub(sub: string): void {
  write({ ...current, sub }, true);
}
