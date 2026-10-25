// Writes the sandbox page's data next to its build (VITE_PLAY=1): the two play databases, the people
// a visitor can be (Dana and Sam, controllers, and an Outsider), the World screen's feeder, the step
// bar, and each company's proof files from the sandbox's own replays. tools/play/reset.sh makes all
// of it under $CHARTER_PLAY_DIR; these identities are bound in the play databases and nowhere else.
//   CHARTER_PLAY_DIR=~/Developer/charter-play-stdb npx tsx scripts/export_play.ts dist
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCharterCore } from '../plugins/charter-core';

const out = path.resolve(process.argv[2] ?? 'dist');
const play = path.resolve(process.env.CHARTER_PLAY_DIR ?? path.join(os.homedir(), 'Developer/charter-play-stdb'));
const host = 'https://maincloud.spacetimedb.com';
const companies = [
  { db: 'charter-pinkstrokes-play-a', label: 'A · franchisor', dir: 'data/companyA' },
  { db: 'charter-pinkstrokes-play-b', label: 'B · wholesaler', dir: 'data/companyB' },
];

interface Person {
  identity: string;
  token: string;
  role: string;
}
const people = JSON.parse(fs.readFileSync(path.join(play, 'personas.json'), 'utf8')) as Record<string, Person>;
const persona = (name: string) => {
  const p = people[name];
  if (!p?.token) throw new Error(`${name} is missing from ${play}/personas.json: run tools/play/reset.sh prep`);
  return { key: name.toLowerCase(), name, role: p.role, identity: p.identity, token: p.token };
};
const steps = path.join(play, 'steps.json');

const dest = path.join(out, '__charter');
fs.mkdirSync(dest, { recursive: true });
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(dest, name), JSON.stringify(value));

write('env.json', { defaultDb: companies[0].db, wsBase: host.replace(/^http/, 'ws'), httpBase: host, companies: companies.map(({ db, label }) => ({ db, label })), demo: fs.existsSync(steps) });
write('personas.json', { source: 'sandbox', managed: false, personas: ['Dana', 'Sam', 'Outsider'].map(persona) });
write('world.json', { identity: persona('World page').identity, token: persona('World page').token });
if (fs.existsSync(steps)) fs.copyFileSync(steps, path.join(dest, 'steps.json'));
const core = createCharterCore({ repoRoot: path.join(play, 'work'), webRoot: path.resolve('.') });
for (const c of companies) write(`proof-${c.db}.json`, { ...core.proofFiles(path.join(play, 'work', c.dir), c.db), available: [] });
// GitHub Pages runs Jekyll unless told not to, and Jekyll drops folders that start with "_".
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`wrote ${dest}: env, Dana, Sam, an Outsider, the World screen's feeder, ${fs.existsSync(steps) ? 'steps, ' : ''}proof files for ${companies.map(c => c.db).join(', ')}`);
