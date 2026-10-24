// Bind the UI's personas (Dana, Sam, Lee, Priya, and an unbound Outsider) in a
// development database, or show where a world-built database's tokens come from.
// The dev server does the same on page load; this is for checking before a demo.
//
//   npm run personas -- --db charter-ui            bind any persona that is not bound
//   npm run personas -- --db charter-ui --rebind   bind all of them again (after a reseed)
//   npm run personas -- --db charter-a             read data/companyA/identities.json
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCharterCore } from '../plugins/charter-core';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webRoot, '..');
const args = process.argv.slice(2);
const at = args.indexOf('--db');
const db = at >= 0 ? args[at + 1] : process.env.CHARTER_DB || 'charter-ui';
const rebind = args.includes('--rebind');

const core = createCharterCore({ repoRoot, webRoot });
try {
  const res = await core.personas(db, rebind);
  console.log(`${db}: tokens from ${res.source}${res.managed ? ' (identities minted and bound for the UI)' : ''}`);
  for (const p of res.personas) console.log(`  ${p.name.padEnd(9)} ${p.role.padEnd(11)} 0x${p.identity.slice(0, 16)}…`);
} catch (e) {
  console.error(`${db}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
