// The activity columns are the kernel's canonical JSON. canonical() renders an
// undefined field as the bare word `undefined` (see module core/hash.ts), so the
// stored text is hashed exactly but is not strict JSON. Parse it leniently for
// display; the chain verifier always works on the raw text.

const cache = new Map<string, unknown>();

export function parseLoose<T = unknown>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  const hit = cache.get(text);
  if (hit !== undefined) return hit as T;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = JSON.parse(text.replace(/:undefined(?=[,}\]])/g, ':null'));
    } catch {
      return fallback;
    }
  }
  if (cache.size > 20_000) cache.clear();
  cache.set(text, value);
  return value as T;
}

export function parseObj(text: string | null | undefined): Record<string, unknown> {
  const v = parseLoose<unknown>(text, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function parseArr<T = unknown>(text: string | null | undefined): T[] {
  const v = parseLoose<unknown>(text, []);
  return Array.isArray(v) ? (v as T[]) : [];
}

// Drop null/undefined members so "not provided" does not read like "false".
export function present(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
