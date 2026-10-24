// Light, dark, or follow the system. The choice is a per-viewer convenience.
import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'charter.theme';
let theme: Theme = 'system';
const listeners = new Set<() => void>();

function apply(): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function initTheme(): void {
  try {
    const saved = localStorage.getItem(KEY) as Theme | null;
    if (saved === 'light' || saved === 'dark' || saved === 'system') theme = saved;
  } catch {
    /* storage unavailable */
  }
  apply();
}

export function effectiveDark(): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function toggleTheme(): void {
  theme = effectiveDark() ? 'light' : 'dark';
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
  apply();
  listeners.forEach(fn => fn());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => theme
  );
}
