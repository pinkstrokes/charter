// Skills travel, data does not. A skill version learned at one company is
// offered to another as a program and a few aggregate numbers; no record of
// the source company crosses. The target replays the program over its own
// history and its own people's answers, through the same gate as any
// proposal, and its own controller decides.
//   npx tsx tools/evolve/transfer.ts --from charter-a --to charter-b --domain allocation
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { canonical } from '../../module/spacetimedb/src/core/hash';
import type { SkillProgram } from '../../module/spacetimedb/src/core/dsl';
import { Db, evolverToken, parseJson } from './lib';
import { evaluate, examplesFor, loadHistory, splitLessons, type Domain } from './skills';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1] ?? 'true');
const FROM = args.get('from') ?? 'charter-a';
const TO = args.get('to') ?? 'charter-b';
const DOMAIN = (args.get('domain') ?? 'allocation') as Domain;

async function main(): Promise<void> {
  const src = new Db(FROM, await evolverToken(FROM));
  const dst = new Db(TO, await evolverToken(TO));
  const [srcSkills, srcCfg, dstCfg] = await Promise.all([src.sql('SELECT key, domain, version, status, program, proof FROM skill'), src.sql('SELECT company_name FROM config'), dst.sql('SELECT company_name FROM config')]);
  const chosen = args.has('key') ? srcSkills.find(s => s.key === args.get('key')) : srcSkills.filter(s => s.domain === DOMAIN && s.status === 'active').sort((a, b) => b.version - a.version)[0];
  if (!chosen) throw new Error(`no ${DOMAIN} skill to transfer from ${FROM}`);
  const program = JSON.parse(chosen.program) as SkillProgram;
  const sourceProof = parseJson<{ labeled?: { n: number; correctAfter: number }; candidatesTried?: number }>(chosen.proof, {});
  // Exactly what crosses the boundary.
  const crossing = {
    program,
    programHash: createHash('sha256').update(canonical(program)).digest('hex'),
    source: { company: srcCfg[0]?.company_name ?? FROM, skill: chosen.key, labeledCases: sourceProof.labeled?.n ?? null, rightAfter: sourceProof.labeled?.correctAfter ?? null },
  };

  const h = await loadHistory(dst);
  const active = h.skills.filter(s => s.domain === DOMAIN && s.status === 'active').sort((a, b) => b.version - a.version)[0];
  if (!active) throw new Error(`${TO} has no active ${DOMAIN} skill`);
  if (canonical(JSON.parse(active.program)) === canonical(program)) {
    console.log(`${TO} already runs this program`);
    return;
  }
  const current = JSON.parse(active.program) as SkillProgram;
  // The target's locked test and live splits stay hidden, as for its own evolver.
  const keyPath = `${TO === 'charter-a' ? 'data/companyA' : TO === 'charter-b' ? 'data/companyB' : 'data/dev'}/answer_key.json`;
  const keyRaw = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) : [];
  const hidden = new Set(((Array.isArray(keyRaw) ? keyRaw : keyRaw.entries ?? []) as { split: string; subject: string }[]).filter(e => e.split === 'test' || e.split === 'live').map(e => e.subject));
  const examples = examplesFor(h, DOMAIN, hidden);
  const { required, optional } = splitLessons(DOMAIN, current, examples);
  const ev = evaluate(DOMAIN, current, program, examples, required, h, hidden, optional);
  const proof = {
    gate: ev.gate,
    transfer: true,
    crossed: { programHash: crossing.programHash, source: crossing.source, records: 0 },
    targetCompany: dstCfg[0]?.company_name ?? TO,
    labeled: ev.labeled,
    lesson: { subjects: [...required, ...optional].map(e => e.subject).slice(0, 50), required: required.length, optionalFixed: ev.lesson.optionalFixed, optionalTotal: optional.length },
    changed: ev.changed,
    safetyViolations: ev.safety.length,
    robustness: ev.robustness,
    why: ev.why,
    selection: `replayed over ${TO}'s own history and answers; nothing from ${FROM} but the program and the numbers above`,
    evaluatedAt: new Date().toISOString(),
  };
  mkdirSync('data/transfers', { recursive: true });
  writeFileSync(`data/transfers/${FROM}-to-${TO}-${DOMAIN}.json`, JSON.stringify({ crossing, proof }, null, 2));
  if (ev.gate !== 'pass') {
    console.log(`${DOMAIN}: ${crossing.source.skill} from ${crossing.source.company} does not pass at ${proof.targetCompany}: ${ev.why.join('; ')}`);
    return;
  }
  await dst.call('propose_skill', DOMAIN, JSON.stringify(program), active.key, `transferred from ${crossing.source.company} (${chosen.key}); program ${crossing.programHash.slice(0, 12)}, no records crossed`, JSON.stringify(proof));
  console.log(`${DOMAIN}: proposed at ${proof.targetCompany} from ${crossing.source.company}'s ${chosen.key}: fixes ${ev.labeled.fixed.length}, takes over ${ev.lesson.optionalFixed}/${optional.length}, breaks ${ev.labeled.broken.length}, changes ${ev.changed.n} past decisions`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
