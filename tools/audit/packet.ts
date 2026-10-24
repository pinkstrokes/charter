// Audit packets: everything behind one transaction in a single file that an
// outside auditor can check without our database. The packet carries the
// activity rows that touched the subject (with the hash of the row before each,
// so the chain can be re-linked), the source documents and their hashes, the
// facts and the decision with the exact skill version and rule that fired, the
// policies that were checked, and the journal entries.
//   npx tsx tools/audit/packet.ts --db charter-a --subject bill:V01:INV-20431
//   npx tsx tools/audit/packet.ts --verify data/companyA/packets/bill_V01_INV-20431.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chainHash, sha256Hex } from '../../module/spacetimedb/src/core/hash';
import { Db, parseJson, roleToken, type Row } from '../evolve/lib';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');

function bodyOf(a: Row) {
  return { at: a.at, principal: a.principal, role: a.role, kind: a.kind, command: a.command, params: JSON.parse(a.params), used: JSON.parse(a.used), plan: JSON.parse(a.plan), outcome: a.outcome, reasons: JSON.parse(a.reasons), claims: JSON.parse(a.claims), context: JSON.parse(a.context || '{}') };
}

async function build(): Promise<void> {
  const DB = args.get('db') ?? 'charter-iqwfr';
  const subject = args.get('subject') ?? '';
  const [kind, ...rest] = subject.split(':');
  const id = rest.join(':');
  if (!kind || !id) throw new Error('--subject like invoice:R-S14-2026-03-02, bill:V01:INV-20431, payment:PAY-..., decision:42');
  const db = new Db(DB, await roleToken(DB, 'auditor', 'auditor'));
  const [activity, observations, facts, decisions, skills, policies, journal] = await Promise.all([
    db.sql('SELECT id, at, principal, role, kind, command, params, used, plan, outcome, reasons, claims, context, prev_hash, hash FROM activity'),
    db.sql('SELECT id, kind, source, trusted, known_at, valid_at, ref_key, payload, sha FROM observation'),
    db.sql('SELECT id, subject, attr, value, valid_from, known_at, source_obs, trusted FROM fact'),
    db.sql('SELECT id, at, seat, domain, subject, features, skill_key, outcome, rule_index, note, label, label_source FROM decision'),
    db.sql('SELECT key, domain, version, status, program, parent, provenance, proof FROM skill'),
    db.sql('SELECT key, policy_id, version, template, text, status, constitutional, approved_by, approved_at FROM policy'),
    db.sql('SELECT id, je_id, account, debit_cents, credit_cents, entity_code, memo, period, activity_id FROM journal'),
  ]);
  activity.sort((a, b) => a.id - b.id);
  const needle = kind === 'decision' ? `decision:${id}` : id;
  const touched = activity.filter(a => a.params.includes(needle) || a.used.includes(needle) || (kind !== 'decision' && a.used.includes(`${kind}:${id}`)));
  const prevHash = new Map(activity.map((a, i) => [a.id, i ? activity[i - 1].hash : 'genesis']));
  const usedObs = new Set<number>();
  const usedFacts = new Set<number>();
  for (const a of touched)
    for (const u of JSON.parse(a.used) as string[]) {
      const [k, v] = u.split(':');
      if (k === 'obs') usedObs.add(Number(v));
      if (k === 'fact') usedFacts.add(Number(v));
    }
  const decisionSubject = kind === 'decision' ? decisions.find(d => String(d.id) === id)?.subject : `${kind}:${id}`;
  const decs = decisions.filter(d => d.subject === decisionSubject || String(d.id) === id);
  for (const f of facts) if (usedFacts.has(Number(f.id))) usedObs.add(Number(f.source_obs));
  const checkedPolicyIds = new Set(touched.flatMap(a => JSON.parse(a.plan) as string[]).map(p => p.split('@')[0]));
  const packet = {
    format: 'charter-audit-packet/1',
    subject,
    builtAt: new Date().toISOString(),
    database: DB,
    activities: touched.map(a => ({ ...a, prevHashExpected: prevHash.get(a.id) })),
    documents: observations.filter(o => usedObs.has(Number(o.id))),
    facts: facts.filter(f => usedFacts.has(Number(f.id))),
    decisions: decs.map(d => {
      const skill = skills.find(s => s.key === String(d.skill_key).split('+')[0]);
      const program = skill ? JSON.parse(skill.program) : null;
      return { ...d, skill: skill ? { key: skill.key, status: skill.status, parent: skill.parent, provenance: skill.provenance, ruleFired: d.rule_index >= 0 && program ? program.rules[d.rule_index] : d.rule_index === -1 ? { otherwise: program?.otherwise } : 'precedent' } : null };
    }),
    policiesChecked: policies.filter(p => checkedPolicyIds.has(p.policy_id)).map(p => ({ key: p.key, text: p.text, template: JSON.parse(p.template), constitutional: p.constitutional, approvedBy: p.approved_by, approvedAt: p.approved_at })),
    journal: journal.filter(j => touched.some(a => a.id === j.activity_id)),
    howToVerify: 'npx tsx tools/audit/packet.ts --verify <this file>: recomputes every activity hash from its stored fields and the hash of the row before it, and every document hash from its payload.',
  };
  const dir = args.get('out') ?? `${DB === 'charter-a' ? 'data/companyA' : 'data/dev'}/packets`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${subject.replace(/[^A-Za-z0-9-]+/g, '_')}.json`;
  writeFileSync(path, JSON.stringify(packet, null, 1));
  console.log(`${path}: ${packet.activities.length} activities, ${packet.documents.length} documents, ${packet.decisions.length} decisions, ${packet.policiesChecked.length} policies, ${packet.journal.length} journal lines`);
  verify(path);
}

function verify(path: string): void {
  const p = JSON.parse(readFileSync(path, 'utf8'));
  let ok = 0;
  const bad: string[] = [];
  for (const a of p.activities) {
    const fine = a.prev_hash === a.prevHashExpected && chainHash(a.prev_hash, bodyOf(a)) === a.hash;
    if (fine) ok++;
    else bad.push(`activity ${a.id}`);
  }
  for (const d of p.documents) {
    if (sha256Hex(d.payload) === d.sha) ok++;
    else bad.push(`document ${d.ref_key}`);
  }
  console.log(bad.length ? `FAIL ${bad.join(', ')}` : `PASS ${ok} hashes recomputed (${p.activities.length} activities, ${p.documents.length} documents)`);
  if (bad.length) process.exit(1);
}

(args.has('verify') ? Promise.resolve(verify(args.get('verify')!)) : build()).catch(e => {
  console.error(e);
  process.exit(1);
});

void parseJson;
