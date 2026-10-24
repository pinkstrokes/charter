// Words that identify a business in a name: lower case, punctuation and legal
// suffixes dropped, so "Golden Tapioca Co." and "GOLDEN TAPIOCA" compare equal.
const STOP = new Set(['co', 'inc', 'llc', 'ltd', 'the', 'and', 'company', 'corp', 'group', 'holdings', 'billing', 'accounts', 'ar', 'ap']);

export function nameTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 1 && !STOP.has(w)));
}
