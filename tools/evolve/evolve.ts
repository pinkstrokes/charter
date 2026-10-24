// The evolution engine. It reads what the organization knows (people's answers
// and field audits), proposes new skill versions with an LLM, replays each one
// over every past decision, and submits only those that pass the gate. It can
// propose; it cannot activate. The answer key, when present, grades proposals
// for the proof page and is never used to choose between them.
//
//   npx tsx tools/evolve/evolve.ts --db charter-a --once
//   npx tsx tools/evolve/evolve.ts --db charter-a --watch      (live demo)
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { run, type FeatureMap, type SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { Db, evolverToken, parseJson } from './lib';
import { agrees, evaluate, examplesFor, latestBySubject, loadHistory, propose, tune, type Domain, type Evaluation, type Example, type History } from './skills';
import { searchPolicies } from './policies';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
}
const DB = args.get('db') ?? process.env.STDB_DB ?? 'charter-iqwfr';
const COMPANY_DIR = args.get('data') ?? (DB === 'charter-a' ? 'data/companyA' : DB === 'charter-b' ? 'data/companyB' : 'data/dev');
const MODEL = args.get('model') ?? 'qwen3.8-max';
const DOMAINS_TO_EVOLVE: Domain[] = args.has('domain') ? [args.get('domain') as Domain] : ['underreport', 'pre_chase', 'allocation', 'routing_change'];

interface KeyEntry {
  caseId: string;
  family: string;
  split: string;
  subject: string;
  expected: string;
}

function answerKey(): KeyEntry[] {
  const path = args.get('answer-key') ?? `${COMPANY_DIR}/answer_key.json`;
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return (Array.isArray(raw) ? raw : raw.entries ?? []) as KeyEntry[];
}

function domainOf(subject: string): Domain | null {
  if (subject.startsWith('store:')) return 'underreport';
  if (subject.startsWith('receipt:')) return 'allocation';
  if (subject.startsWith('entity:')) return 'pre_chase';
  if (subject.startsWith('routing:')) return 'routing_change';
  return null;
}

// Grading only: how current and candidate do on planted cases, by split and family.
function grade(domain: Domain, current: SkillProgram, candidate: SkillProgram, key: KeyEntry[], h: History) {
  const latest = latestBySubject(h, domain);
  const out: Record<string, Record<string, { n: number; current: number; candidate: number }>> = {};
  for (const e of key) {
    if (domainOf(e.subject) !== domain) continue;
    const d = latest.get(e.subject);
    if (!d) continue;
    const f = parseJson<FeatureMap>(d.features, {});
    const cell = ((out[e.split] ??= {})[e.family] ??= { n: 0, current: 0, candidate: 0 });
    cell.n++;
    cell.current += agrees(domain, run(current, f).outcome.decide, e.expected) ? 1 : 0;
    cell.candidate += agrees(domain, run(candidate, f).outcome.decide, e.expected) ? 1 : 0;
  }
  return out;
}

function log(entry: unknown): void {
  mkdirSync(`${COMPANY_DIR}/eval`, { recursive: true });
  appendFileSync(`${COMPANY_DIR}/eval/evolve_log.jsonl`, JSON.stringify(entry) + '\n');
}

async function evolveDomain(db: Db, h: History, domain: Domain, hidden: Set<string>, key: KeyEntry[]): Promise<string> {
  const versions = h.skills.filter(s => s.domain === domain);
  const active = versions.filter(s => s.status === 'active').sort((a, b) => b.version - a.version)[0];
  if (!active) return `${domain}: no active version`;
  if (versions.some(s => s.status === 'proposed')) return `${domain}: a proposal is waiting for a person`;
  const current = JSON.parse(active.program) as SkillProgram;
  const examples = examplesFor(h, domain, hidden);
  const lesson = examples.filter(e => !agrees(domain, run(current, e.features).outcome.decide, e.label));
  if (!lesson.length) return `${domain}: nothing new to learn (${examples.length} labeled cases, all handled)`;
  const lessonKey = lesson.map(e => e.subject).sort().join('|');
  for (const s of versions.filter(v => v.status === 'rejected')) {
    if ((parseJson<{ lesson?: { subjects?: string[] } }>(s.proof, {}).lesson?.subjects ?? []).sort().join('|') === lessonKey) return `${domain}: a person already rejected a proposal for this lesson`;
  }

  const t0 = Date.now();
  const proposals = await propose(MODEL, domain, current, lesson, examples, h);
  type Scored = { program: SkillProgram; ev: Evaluation; origin: string; rationale: string };
  const scored: Scored[] = [];
  for (const p of proposals) {
    const ev = evaluate(domain, current, p.program, examples, lesson, h, hidden);
    scored.push({ program: p.program, ev, origin: `${MODEL} style ${p.style}`, rationale: p.rationale });
    // Constants are tuned only to rescue a candidate that fails, never to shave flags:
    // a threshold fitted tightly around one case is exactly how a skill overfits.
    if (ev.gate === 'fail') for (const v of tune(domain, current, p.program, examples, lesson, h, hidden)) scored.push({ program: v, ev: evaluate(domain, current, v, examples, lesson, h, hidden), origin: `${MODEL} style ${p.style}, constants tuned by replay`, rationale: p.rationale });
  }
  const passing = scored.filter(s => s.ev.gate === 'pass');
  passing.sort((a, b) => b.ev.labeled.correctAfter - a.ev.labeled.correctAfter || b.ev.robustness - a.ev.robustness || a.ev.complexity - b.ev.complexity);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log({ at: new Date().toISOString(), db: DB, domain, lesson: lesson.map(e => e.subject), candidates: scored.length, passing: passing.length, failures: scored.filter(s => s.ev.gate === 'fail').map(s => s.ev.why) });
  if (!passing.length) {
    const best = scored[0];
    return `${domain}: ${scored.length} candidates in ${secs}s, none passed (${best ? best.ev.why.join('; ') : 'model returned nothing usable'})`;
  }
  const best = passing[0];
  const proof = {
    gate: 'pass',
    domain,
    parent: active.key,
    lesson: { subjects: lesson.map(e => e.subject), cases: lesson.map(e => ({ subject: e.subject, label: e.label, source: e.source, reason: e.reason })) },
    labeled: best.ev.labeled,
    budget: best.ev.budget,
    changed: best.ev.changed,
    newLeads: best.ev.newLeads,
    safetyViolations: best.ev.safety.length,
    complexity: best.ev.complexity,
    robustness: best.ev.robustness,
    alternatives: passing.slice(1, 4).map(s => ({ origin: s.origin, robustness: s.ev.robustness, newLeads: s.ev.newLeads.length, complexity: s.ev.complexity })),
    origin: best.origin,
    rationale: best.rationale,
    candidatesTried: scored.length,
    candidatesPassed: passing.length,
    seconds: Number(secs),
    selection: 'chosen on what the organization knows (answers and field audits); test and live cases were hidden from the evolver',
    grading: key.length ? grade(domain, current, best.program, key, h) : null,
    evaluatedAt: new Date().toISOString(),
  };
  const provenance = lesson.map(e => `${e.source}: "${e.reason}"`).join(' | ');
  if (args.has('dry-run')) {
    writeFileSync(`${COMPANY_DIR}/eval/dry-run-${domain}.json`, JSON.stringify({ program: best.program, proof }, null, 2));
    return `${domain}: dry run, best candidate written`;
  }
  await db.call('propose_skill', domain, JSON.stringify(best.program), active.key, provenance, JSON.stringify(proof));
  writeFileSync(`${COMPANY_DIR}/eval/proposal-${domain}-${active.version + 1}.json`, JSON.stringify({ program: best.program, proof }, null, 2));
  return `${domain}: proposed v${active.version + 1} in ${secs}s (${passing.length}/${scored.length} candidates passed; fixes ${best.ev.labeled.fixed.length}, breaks 0, new leads ${best.ev.newLeads.length})`;
}

async function once(db: Db): Promise<void> {
  const key = answerKey();
  const hidden = new Set(key.filter(e => e.split === 'test' || e.split === 'live').map(e => e.subject));
  const h = await loadHistory(db);
  for (const domain of DOMAINS_TO_EVOLVE) {
    try {
      console.log(await evolveDomain(db, h, domain, hidden, key));
    } catch (e) {
      console.log(`${domain}: error ${(e as Error).message}`);
    }
  }
  if (!args.has('no-policies')) {
    try {
      for (const line of await searchPolicies(db, args.has('dry-run'), COMPANY_DIR)) console.log(line);
    } catch (e) {
      console.log(`policies: error ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const db = new Db(DB, await evolverToken(DB));
  if (!args.has('watch')) return once(db);
  // Live: wake when a person answers something or an audit closes.
  let seen = '';
  for (;;) {
    const marks = await db.sql("SELECT id, status, answered_at FROM ask WHERE status = 'answered'");
    const audits = (await db.sql('SELECT id, attr FROM fact')).filter(f => f.attr === 'audit').length;
    const mark = `${marks.length}:${audits}`;
    if (mark !== seen) {
      seen = mark;
      console.log(`[${new Date().toLocaleTimeString()}] new answers; evolving`);
      await once(db);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

export type { Example };
