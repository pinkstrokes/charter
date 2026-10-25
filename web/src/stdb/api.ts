// Where the UI's own data comes from: the dev server's middleware
// (plugins/charter-dev.ts), or, in a static build, JSON files written next to the
// page: the public page watching the finished runs (VITE_PUBLIC=1,
// scripts/export_public.ts) or the sandbox anyone may act in (VITE_PLAY=1,
// scripts/export_play.ts, on databases of its own that tools/play/reset.sh rebuilds).
export const isPlay = import.meta.env.VITE_PLAY === '1';
export const isPublic = import.meta.env.VITE_PUBLIC === '1' || isPlay;
// The public replays: nobody acts there, so no World screen and no email form.
export const watchOnly = isPublic && !isPlay;

export function charterApi(what: 'env' | 'personas' | 'proof' | 'world' | 'steps', db = '', dir = ''): string {
  if (isPublic) return `${import.meta.env.BASE_URL}__charter/${what}${what === 'proof' ? `-${db}` : ''}.json`;
  if (what === 'steps') return '/__charter/demo/steps';
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
