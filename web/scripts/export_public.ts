// Writes the public page's data next to its build: which databases to watch, an
// Outsider identity (the only person a visitor can be: no role, so it can watch
// and send email, nothing more), and each company's proof files, read from the
// folders the runs wrote, with the same code the dev server uses.
//   STDB_URL=https://maincloud.spacetimedb.com CHARTER_RUNS=~/Developer/charter-cloud \
//     npx tsx scripts/export_public.ts dist
// CHARTER_DBS=charter-a,charter-b,charter-c points it at other databases (a local check).
import fs from 'node:fs';
import path from 'node:path';
import { createCharterCore } from '../plugins/charter-core';

const out = path.resolve(process.argv[2] ?? 'dist');
const runs = path.resolve(process.env.CHARTER_RUNS ?? '..');
const host = (process.env.STDB_URL ?? 'https://maincloud.spacetimedb.com').replace(/\/$/, '');
const dbs = (process.env.CHARTER_DBS ?? 'charter-pinkstrokes-a,charter-pinkstrokes-b,charter-pinkstrokes-c').split(',');
const companies = [
  { db: dbs[0], label: 'A · franchisor', dir: 'data/companyA' },
  { db: dbs[1], label: 'B · wholesaler', dir: 'data/companyB' },
  { db: dbs[2], label: 'C · sister ledger', dir: 'data/companyC' },
];

const dest = path.join(out, '__charter');
fs.mkdirSync(dest, { recursive: true });
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(dest, name), JSON.stringify(value));

write('env.json', { defaultDb: companies[0].db, wsBase: host.replace(/^http/, 'ws'), httpBase: host, companies: companies.map(({ db, label }) => ({ db, label })) });
const minted = (await (await fetch(`${host}/v1/identity`, { method: 'POST' })).json()) as { identity: string; token: string };
write('personas.json', { source: 'public page', managed: false, personas: [{ key: 'outsider', name: 'Outsider', role: 'outsider', identity: minted.identity, token: minted.token }] });
const core = createCharterCore({ repoRoot: runs, webRoot: path.resolve('.') });
for (const c of companies) write(`proof-${c.db}.json`, { ...core.proofFiles(path.join(runs, c.dir), c.db), available: [] });
// GitHub Pages runs Jekyll unless told not to, and Jekyll drops folders that start with "_".
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`wrote ${dest}: env, an Outsider, proof files for ${companies.map(c => c.db).join(', ')}`);
