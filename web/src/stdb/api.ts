// Where the UI's own data comes from: the dev server's middleware
// (plugins/charter-dev.ts), or, in the public build, JSON files written next to
// the page by scripts/export_public.ts.
export const isPublic = import.meta.env.VITE_PUBLIC === '1';

export function charterApi(what: 'env' | 'personas' | 'proof', db = '', dir = ''): string {
  if (isPublic) return `${import.meta.env.BASE_URL}__charter/${what}${what === 'proof' ? `-${db}` : ''}.json`;
  const q = new URLSearchParams();
  if (db && what !== 'env') q.set('db', db);
  if (dir) q.set('dir', dir);
  const qs = q.toString();
  return `/__charter/${what}${qs ? `?${qs}` : ''}`;
}

// The companies a public page offers, from its env file.
export interface Company {
  db: string;
  label: string;
}
