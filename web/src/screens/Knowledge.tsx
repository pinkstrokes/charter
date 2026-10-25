import { Check, FlaskConical, Lock, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Policy, Skill } from '../module_bindings/types';
import { PolicyProof, SkillProof, Gate } from '../components/Proofs';
import { summarize } from '../lib/summary';
import { ActorTag, Empty, OutcomeChip, PolicyChip, Result, StatusChip } from '../components/ui';
import { useMe } from '../app/data';
import { openWhy, setSub, useNav } from '../app/nav';
import { ACTION_LABEL, ACTION_VERB, answerWords, day, ROLE_LABEL, SEAT_LABEL } from '../lib/format';
import { parseObj } from '../lib/json';
import { buildLineage, proofSummary, replay, subjectLabel, type Lineage, type Replay } from '../lib/lineage';
import { idOrder, policyKind, siblings, stoppedByPolicy, template, templateAction, templateText } from '../lib/policies';
import { DOMAIN_LABEL, DOMAIN_NAMES, DOMAIN_SEAT, exprText, isSkillKey, outcomeText, parseProgram } from '../lib/rules';
import { useAction } from '../stdb/actions';
import { Autonomy } from './Autonomy';
import { useRows } from '../stdb/store';

export function Knowledge() {
  const nav = useNav();
  const [tab, domainSub] = nav.sub === 'policies' || nav.sub === 'autonomy' ? [nav.sub, ''] : ['skills', nav.sub];
  return (
    <div className="page-inner">
      <div className="page-head">
        <h1 className="page-title">Knowledge</h1>
        <p className="page-sub">What the team knows, where each piece came from, and who let it into real work.</p>
      </div>
      <div className="subtabs" role="tablist">
        <button className="subtab" role="tab" aria-selected={tab === 'skills'} onClick={() => setSub(domainSub || 'underreport')}>
          Skills
        </button>
        <button className="subtab" role="tab" aria-selected={tab === 'autonomy'} onClick={() => setSub('autonomy')}>
          Autonomy
        </button>
        <button className="subtab" role="tab" aria-selected={tab === 'policies'} onClick={() => setSub('policies')}>
          Policies
        </button>
      </div>
      {tab === 'policies' ? <Policies /> : tab === 'autonomy' ? <Autonomy /> : <Skills domain={DOMAIN_NAMES.includes(domainSub as never) ? domainSub : 'underreport'} />}
    </div>
  );
}

function versionOrder(a: Skill, b: Skill): number {
  return b.version - a.version;
}

function Skills({ domain }: { domain: string }) {
  const skills = useRows('skill');
  const asks = useRows('ask');
  const activity = useRows('activity');
  const decisions = useRows('decision');
  const policies = useRows('policy');
  const versions = useMemo(() => skills.filter(s => s.domain === domain).sort(versionOrder), [skills, domain]);
  const [picked, setPicked] = useState<string>('');
  const selected = versions.find(v => v.key === picked) ?? pickDefault(versions);
  const all = useMemo(() => ({ skills, asks, activity, decisions, policies }), [skills, asks, activity, decisions, policies]);
  const lineage = useMemo(() => (selected ? buildLineage(selected, all) : null), [selected, all]);
  useEffect(() => setPicked(''), [domain]);
  return (
    <>
      <div className="domains" role="tablist" aria-label="Skill domains">
        {DOMAIN_NAMES.map(d => {
          const vs = skills.filter(s => s.domain === d);
          const active = vs.filter(s => s.status === 'active').sort(versionOrder)[0];
          const pending = vs.filter(s => s.status === 'proposed' || s.status === 'shadow' || s.status === 'canary').length;
          return (
            <button key={d} className="domain-tab" role="tab" aria-selected={d === domain} onClick={() => setSub(d)}>
              <b>{DOMAIN_LABEL[d]}</b>
              <span>
                {active ? `${active.key} active` : 'no active version'}
                {pending ? `, ${pending} in review` : ''}
                {vs.length > 1 ? `, ${vs.length} versions` : ''}
              </span>
            </button>
          );
        })}
      </div>
      <EngineLine domain={domain} />
      {lineage && <LineageView l={lineage} />}
      <div className="split-even">
        <section aria-label="Versions">
          <div className="section-head">
            <h2 className="section-title">Versions</h2>
            <span className="aside">used by the {SEAT_LABEL[DOMAIN_SEAT[domain]]?.toLowerCase()} seat</span>
          </div>
          <div className="versions">
            {versions.map(v => (
              <VersionCard key={v.key} v={v} selected={selected?.key === v.key} onSelect={() => setPicked(v.key)} />
            ))}
            {!versions.length && (
              <div className="sheet">
                <Empty title="No versions">This domain has no skill yet.</Empty>
              </div>
            )}
          </div>
        </section>
        {selected && <VersionDetail v={selected} parent={versions.find(x => x.key === selected.parent)} />}
      </div>
    </>
  );
}

// Every attempt of the evolution engine on this domain is on the record (kind
// 'evolution'), refusals included: "one example would change 44% of past decisions".
function EngineLine({ domain }: { domain: string }) {
  const activity = useRows('activity');
  const [open, setOpen] = useState(false);
  const attempts = useMemo(
    () => activity.filter(a => a.kind === 'evolution' && parseObj(a.params).domain === domain).sort((x, y) => (x.id < y.id ? 1 : -1)),
    [activity, domain]
  );
  if (!attempts.length) return null;
  const last = attempts[0];
  const p = parseObj(last.params);
  const refused = attempts.filter(a => a.outcome !== 'pass').length;
  return (
    <div style={{ margin: '-4px 0 12px', fontSize: 13 }}>
      <div className="row muted" style={{ gap: 6 }}>
        <FlaskConical size={13} />
        <span>
          Evolution engine, {day(last.at)}: {last.outcome === 'pass' ? '' : 'refused: '}
          {String(p.summary ?? '')}
        </span>
        <button className="btn small quiet" style={{ height: 22, padding: '0 6px' }} onClick={() => openWhy(last.id)}>
          #{last.id.toString()}
        </button>
        {attempts.length > 1 && (
          <button className="btn small quiet" style={{ height: 22, padding: '0 6px' }} onClick={() => setOpen(o => !o)}>
            {open ? 'Hide' : `All ${attempts.length} attempts, ${refused} refused`}
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 4, paddingLeft: 20 }}>
          {attempts.map(a => (
            <div key={a.id.toString()} className="row" style={{ gap: 6 }}>
              <OutcomeChip outcome={a.outcome} />
              <span className="faint num">{day(a.at)}</span>
              <span>{String(parseObj(a.params).summary ?? '')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Show the version with the most story: newest learned one that is live, else newest learned, else v1.
function pickDefault(versions: Skill[]): Skill | undefined {
  const learned = versions.filter(v => v.version > 1);
  return learned.find(v => v.status === 'active') ?? learned.find(v => v.status === 'canary' || v.status === 'shadow') ?? learned[0] ?? versions[0];
}

// The arc the thread tells, named once where each part begins.
const PHASE: Record<string, string> = {
  origin: 'A person said it',
  proposed: 'Proposed with proof',
  proof: 'Proposed with proof',
  status: 'Let into real work',
  retired: 'Retired',
  policy: 'Made policy',
  inherited: 'Inherited',
  changed: 'Changed real decisions',
};

function LineageView({ l }: { l: Lineage }) {
  const asks = useRows('ask');
  const activity = useRows('activity');
  const origin = l.origins[0];
  const ref = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    setDrawn(true);
  }, []);
  // Taught but not (yet) learned: the latest correction and what the engine made of it.
  const taught = !origin && l.skill.version === 1 ? asks.filter(a => a.kind === `correction:${l.skill.domain}` && a.status === 'answered').sort((a, b) => (a.id < b.id ? 1 : -1))[0] : undefined;
  if (taught) {
    const attempt = activity
      .filter(a => a.kind === 'evolution' && parseObj(a.params).domain === l.skill.domain)
      .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    const who = taught.answeredBy.split(':')[1] ?? taught.answeredBy;
    const role = taught.answeredBy.split(':')[0];
    return (
      <section className="sheet lineage" aria-label="Lineage">
        <div className="lineage-quote">
          <div>
            <blockquote>{taught.reason || taught.answer}</blockquote>
            <div className="lineage-cite">
              <span className={`avatar ${role}`}>{who.charAt(0)}</span>
              <span>
                <b style={{ fontWeight: 600, color: 'var(--ink)' }}>{who}</b>, {ROLE_LABEL[role]?.toLowerCase() ?? role}
                <span className="faint">
                  {' '}
                  corrected {subjectLabel(taught.subject)} to “{answerWords(taught.answer)}”, {day(taught.answeredAt, true)}
                </span>
              </span>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="faint" style={{ fontSize: 12 }}>still</div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>{l.skill.key}</div>
            <StatusChip status={l.skill.status} />
          </div>
        </div>
        <div className="thread draw" role="list">
          <div role="listitem" className="thread-step origin" style={{ ['--i' as string]: 0 }}>
            <span className="phase">A person said it</span>
            <span className="pearl" aria-hidden />
            <div className="step-date">{day(taught.answeredAt)}</div>
            <div className="step-title">
              {who} corrected it to “{answerWords(taught.answer)}”
            </div>
            <div className="step-detail">counts against the rule that decided, and a near-identical case now goes to a person</div>
          </div>
          <div role="listitem" className={`thread-step proof ${attempt && attempt.outcome !== 'pass' ? 'fail' : ''}`} style={{ ['--i' as string]: 1 }} onClick={attempt ? () => openWhy(attempt.id) : undefined}>
            <span className="phase">{attempt ? (attempt.outcome === 'pass' ? 'Proposed with proof' : 'Not made a rule') : 'Waiting'}</span>
            <span className="pearl" aria-hidden />
            <div className="step-date">{attempt ? day(attempt.at) : ' '}</div>
            <div className="step-title" style={attempt ? { cursor: 'pointer' } : undefined}>
              {attempt ? (attempt.outcome === 'pass' ? 'The engine proposed a new version' : 'The engine refused to generalise') : 'The engine has not read it yet'}
            </div>
            {attempt && <div className="step-detail">{String(parseObj(attempt.params).summary ?? '')}</div>}
          </div>
        </div>
      </section>
    );
  }
  if (!origin && l.skill.version === 1) {
    return (
      <section className="sheet lineage" aria-label="Lineage">
        <div className="lineage-quote">
          <div>
            <blockquote style={{ fontSize: 21 }}>Nobody has taught this skill anything yet.</blockquote>
            <div className="lineage-cite">
              {l.skill.key} is the hand-written starting point. When a person answers a question or marks a decision wrong, the evolution engine proposes the next version here, with proof.
            </div>
          </div>
        </div>
      </section>
    );
  }
  const who = origin ? origin.by.split(':')[1] ?? origin.by : '';
  const role = origin ? origin.by.split(':')[0] : '';
  return (
    <section className="sheet lineage" aria-label="Lineage">
      {origin && (
        <div className="lineage-quote">
          <div>
            <blockquote>{origin.text}</blockquote>
            <div className="lineage-cite">
              <span className={`avatar ${role}`}>{who.charAt(0)}</span>
              <span>
                <b style={{ fontWeight: 600, color: 'var(--ink)' }}>{who}</b>, {ROLE_LABEL[role]?.toLowerCase() ?? role}
                <span className="faint">
                  {' '}
                  about {subjectLabel(origin.subject)}
                  {origin.at ? `, said ${day(origin.at, true)}` : ''}
                </span>
              </span>
              {l.origins.length > 1 && <span className="faint">and {l.origins.length - 1} more people</span>}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="faint" style={{ fontSize: 12 }}>became</div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>{l.skill.key}</div>
            <StatusChip status={l.skill.status} fraction={Number(parseObj(l.skill.scope).fraction ?? NaN) || undefined} />
          </div>
        </div>
      )}
      <div className={`thread ${drawn ? 'draw' : ''}`} ref={ref} role="list" aria-label="From a sentence to the team's rule">
        {l.steps.map((s, i) => {
          const phase = PHASE[s.kind === 'status' && (s.status === 'retired' || s.status === 'rejected') ? 'retired' : s.kind];
          const prev = i > 0 ? PHASE[l.steps[i - 1].kind === 'status' && (l.steps[i - 1].status === 'retired' || l.steps[i - 1].status === 'rejected') ? 'retired' : l.steps[i - 1].kind] : '';
          return (
          <div
            key={`${s.kind}-${i}`}
            role="listitem"
            className={`thread-step ${s.kind} ${s.status === 'active' ? 'active' : ''} ${s.ok === false ? 'fail' : ''}`}
            style={{ ['--i' as string]: i }}
            onClick={s.activityId !== undefined ? () => openWhy(s.activityId!) : undefined}
            title={s.activityId !== undefined ? `Open activity #${s.activityId}` : undefined}
          >
            <span className="phase">{phase !== prev ? phase : ''}</span>
            <span className="pearl" aria-hidden />
            <div className="step-date">{s.at ? day(s.at) : ' '}</div>
            <div className="step-title" style={s.activityId !== undefined ? { cursor: 'pointer' } : undefined}>
              {s.title}
            </div>
            {s.detail && <div className="step-detail">{s.detail}</div>}
            {s.by && s.kind !== 'origin' && (
              <div className="step-by">
                by <ActorTag principal={s.by} />
              </div>
            )}
          </div>
          );
        })}
      </div>
    </section>
  );
}

const NEXT: Record<string, { to: string; label: string }[]> = {
  proposed: [
    { to: 'shadow', label: 'Shadow' },
    { to: 'canary', label: 'Canary' },
    { to: 'active', label: 'Activate' },
    { to: 'rejected', label: 'Reject' },
  ],
  shadow: [
    { to: 'canary', label: 'Canary' },
    { to: 'active', label: 'Activate' },
    { to: 'retired', label: 'Retire' },
  ],
  canary: [
    { to: 'active', label: 'Activate' },
    { to: 'shadow', label: 'Back to shadow' },
    { to: 'retired', label: 'Retire' },
  ],
  active: [{ to: 'retired', label: 'Retire' }],
  retired: [{ to: 'shadow', label: 'Shadow again' }],
  rejected: [{ to: 'shadow', label: 'Shadow anyway' }],
};

function VersionCard({ v, selected, onSelect }: { v: Skill; selected: boolean; onSelect: () => void }) {
  const me = useMe();
  const act = useAction();
  const decisions = useRows('decision');
  const [fraction, setFraction] = useState(20);
  const [confirm, setConfirm] = useState('');
  const ps = proofSummary(v.proof);
  const counts = useMemo(() => {
    let live = 0;
    let shadow = 0;
    for (const d of decisions) {
      if (d.skillKey.split('+')[0] !== v.key) continue;
      if (d.shadow) shadow++;
      else live++;
    }
    return { live, shadow };
  }, [decisions, v.key]);
  const fractionNow = Number(parseObj(v.scope).fraction ?? NaN);
  const quote = v.provenance.match(/"([^"]+)"/)?.[1];
  const move = (to: string) => {
    if ((to === 'retired' && v.status === 'active') || to === 'rejected') {
      if (confirm !== to) {
        setConfirm(to);
        return;
      }
    }
    setConfirm('');
    void act.run({ call: c => c.reducers.setSkillStatus({ key: v.key, status: to, fraction: to === 'canary' ? fraction / 100 : 0 }) });
  };
  return (
    <article className="sheet version" aria-selected={selected} onClick={onSelect}>
      <div className="version-head">
        <span className="version-key">{v.key}</span>
        <StatusChip status={v.status} fraction={Number.isFinite(fractionNow) ? fractionNow : undefined} />
        {ps.gate && <Gate gate={ps.gate} />}
        <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {/* A hand-written starting point is seeded with the database, before any company's calendar exists. */}
          {v.parent ? day(v.createdAt, true) : 'day one'}
        </span>
      </div>
      <div className="version-prov">
        {v.parent ? `child of ${v.parent}; ` : ''}
        {quote ? <span className="quote">“{quote}”</span> : v.provenance}
      </div>
      <div className="faint num" style={{ fontSize: 12 }}>
        {counts.live} live decisions{counts.shadow ? `, ${counts.shadow} in shadow` : ''}
        {ps.changed ? `; would change ${ps.changed.n} of ${ps.changed.total} past` : ''}
      </div>
      {(NEXT[v.status] ?? []).length > 0 && (
        <div className="controls" onClick={e => e.stopPropagation()}>
          {(NEXT[v.status] ?? []).map(n => (
            <button key={n.to} className={`btn small ${n.to === 'active' ? 'primary' : ''}`} disabled={act.pending} onClick={() => move(n.to)} title={me.isController ? `Move ${v.key} to ${n.to} as ${me.name}` : 'Only a controller may move a skill (C10, R-ctrl)'}>
              {confirm === n.to ? `Confirm: ${n.label.toLowerCase()}` : n.label}
              {n.to === 'canary' ? ` ${fraction}%` : ''}
            </button>
          ))}
          {(NEXT[v.status] ?? []).some(n => n.to === 'canary') && (
            <label className="row faint" style={{ gap: 4, fontSize: 12 }}>
              <input type="range" min={5} max={50} step={5} value={fraction} onChange={e => setFraction(Number(e.target.value))} aria-label="Canary share" />
            </label>
          )}
          {confirm && (
            <span className="faint" style={{ fontSize: 12 }}>
              {confirm === 'retired' ? 'Seats will ask a person for every case until another version is active.' : 'The proposal stays on the record as rejected.'}
            </span>
          )}
        </div>
      )}
      {act.result || act.pending ? (
        <div onClick={e => e.stopPropagation()}>
          <Result r={act.result} pending={act.pending} />
        </div>
      ) : null}
    </article>
  );
}

function VersionDetail({ v, parent }: { v: Skill; parent?: Skill }) {
  const program = parseProgram(v.program);
  const decisions = useRows('decision');
  const [rep, setRep] = useState<Replay | null>(null);
  useEffect(() => setRep(null), [v.key]);
  const ps = proofSummary(v.proof);
  return (
    <section className="stack" aria-label={`${v.key} detail`}>
      <div className="sheet sheet-pad">
        <div className="section-head">
          <h2 className="section-title">{v.key}, as the kernel runs it</h2>
          <span className="aside">first matching rule wins</span>
        </div>
        {program ? (
          <ol className="rules" style={{ border: '1px solid var(--rule)', borderRadius: 6 }}>
            {program.rules.map((r, i) => {
              const isNew = parent && !(parseProgram(parent.program)?.rules ?? []).some(pr => JSON.stringify(pr) === JSON.stringify(r));
              return (
                <li key={i} className={isNew ? 'fired' : ''}>
                  <span className="ix">{i + 1}</span>
                  <div>
                    <div className="rule-when">if {exprText(r.when)}</div>
                    <div className="rule-then">
                      then <b>{outcomeText(r.then.decide)}</b>
                      {r.then.askRole ? ` (asks the ${r.then.askRole})` : ''}
                      {r.then.note && <span className="rule-note"> “{r.then.note}”</span>}
                    </div>
                    {isNew && <div className="rule-note" style={{ color: 'var(--taro-ink)' }}>new in this version</div>}
                  </div>
                </li>
              );
            })}
            <li>
              <span className="ix">—</span>
              <div>
                <div className="rule-when">otherwise</div>
                <div className="rule-then">
                  <b>{outcomeText(program.otherwise.decide)}</b>
                </div>
              </div>
            </li>
          </ol>
        ) : (
          <span className="faint">Program unreadable.</span>
        )}
      </div>
      <div className="sheet sheet-pad">
        <div className="section-head">
          <h2 className="section-title">Proof</h2>
          <span className="aside">{v.version === 1 ? 'hand-written; nothing to prove against' : 'written by the evolution engine at proposal time'}</span>
        </div>
        <SkillProof text={v.proof} />
        {v.version > 1 && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--rule)', display: 'grid', gap: 8 }}>
            <div className="row">
              <button className="btn small" onClick={() => setRep(replay(v, parent, decisions))}>
                <Play size={13} /> Replay in this browser
              </button>
              <span className="faint" style={{ fontSize: 12 }}>
                re-runs {parent?.key ?? 'the parent'} and {v.key} on the latest decision for every subject, with the kernel's interpreter
              </span>
            </div>
            {rep && <ReplayResult rep={rep} claimed={ps.changed} />}
          </div>
        )}
      </div>
    </section>
  );
}

function ReplayResult({ rep, claimed }: { rep: Replay; claimed?: { n: number; total: number } }) {
  const agrees = claimed && claimed.n === rep.flips.length && claimed.total === rep.cases;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <FlaskConical size={14} className="faint" />
        <span className="num">
          {rep.flips.length} of {rep.cases} past decisions change ({rep.ms} ms)
        </span>
        {claimed &&
          (agrees ? (
            <span className="tick" style={{ fontWeight: 600 }}>
              <Check size={13} style={{ verticalAlign: -2 }} /> matches the proof
            </span>
          ) : (
            <span className="muted">the proof said {claimed.n} of {claimed.total} at proposal time; history has grown since, and the engine hid test cases from itself</span>
          ))}
      </div>
      {rep.flips.length > 0 && (
        <table className="table compact">
          <thead>
            <tr>
              <th>Case</th>
              <th>Was</th>
              <th>Now</th>
              <th className="n">Decided</th>
            </tr>
          </thead>
          <tbody>
            {rep.flips.slice(0, 20).map(f => (
              <tr key={f.decision.id.toString()}>
                <td>{subjectLabel(f.decision.subject)}</td>
                <td>{outcomeText(f.before)}</td>
                <td style={{ fontWeight: 600 }}>{outcomeText(f.after)}</td>
                <td className="n">{day(f.decision.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- policies ----------

function Policies() {
  const policies = useRows('policy');
  const groups = useMemo(() => {
    const sorted = [...policies].sort((a, b) => idOrder(a.policyId) - idOrder(b.policyId) || b.version - a.version);
    return {
      constitution: sorted.filter(p => policyKind(p) === 'constitution'),
      role: sorted.filter(p => policyKind(p) === 'role'),
      promoted: sorted.filter(p => policyKind(p) === 'promoted'),
    };
  }, [policies]);
  return (
    <div className="split">
      <div className="stack">
        <section className="sheet" aria-label="Learned policies">
          <div className="sheet-pad" style={{ paddingBottom: 6 }}>
            <div className="section-head">
              <h2 className="section-title">Learned policies</h2>
              <span className="aside">may only tighten; a person ratifies each one</span>
            </div>
          </div>
          {groups.promoted.length === 0 ? (
            <Empty title="None yet">The evolution engine searches past money movements for rules that would have stopped a loss; proposals wait here for a controller.</Empty>
          ) : (
            groups.promoted.map(p => <PromotedPolicy key={p.key} p={p} />)
          )}
        </section>
        <section className="sheet" aria-label="Constitution">
          <div className="sheet-pad" style={{ paddingBottom: 6 }}>
            <div className="section-head">
              <h2 className="section-title">Constitution</h2>
              <span className="aside">
                <Lock size={11} style={{ verticalAlign: -1 }} /> locked; the kernel refuses any change
              </span>
            </div>
          </div>
          {groups.constitution.map(p => (
            <ConstitutionRow key={p.key} p={p} />
          ))}
        </section>
      </div>
      <section className="sheet" aria-label="Role matrix">
        <div className="sheet-pad" style={{ paddingBottom: 6 }}>
          <div className="section-head">
            <h2 className="section-title">Who may do what</h2>
            <span className="aside">the role matrix; nothing is allowed unless a rule here grants it</span>
          </div>
        </div>
        {groups.role.map(p => {
          const tpl = template(p);
          return (
            <div key={p.key} className="policy-card" style={{ gridTemplateColumns: '74px minmax(0,1fr)' }}>
              <span className="policy-id">{p.policyId}</span>
              <div>
                <div style={{ fontWeight: 500 }}>{tpl?.t === 'role_can' ? ROLE_LABEL[tpl.role] ?? tpl.role : ''}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {tpl?.t === 'role_can' ? tpl.actions.map(a => ACTION_VERB[a] ?? a).join(', ') : p.text}
                </div>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

// The lock is the kernel's, not the page's: anyone may try, and the attempt is recorded.
function ConstitutionRow({ p }: { p: Policy }) {
  const act = useAction();
  return (
    <div className="policy-card">
      <span className="policy-id">
        <Lock size={11} className="faint" />
        {p.policyId}
      </span>
      <div style={{ display: 'grid', gap: 4 }}>
        <div>{p.text}</div>
        <div className="policy-tpl">{templateText(template(p))}</div>
        <Result r={act.result} pending={act.pending} />
      </div>
      <button className="btn small quiet" disabled={act.pending} onClick={() => void act.run({ call: c => c.reducers.decidePolicy({ key: p.key, approve: false }) })} title="Ask the kernel to retire this rule">
        Try to retire
      </button>
    </div>
  );
}

function PromotedPolicy({ p }: { p: Policy }) {
  const act = useAction();
  const me = useMe();
  const activity = useRows('activity');
  const policies = useRows('policy');
  const stopped = useMemo(() => stoppedByPolicy(activity, p.policyId), [activity, p.policyId]);
  const kin = useMemo(() => siblings(policies, p), [policies, p]);
  const tpl = template(p);
  const decide = (approve: boolean) => void act.run({ call: c => c.reducers.decidePolicy({ key: p.key, approve }) });
  return (
    <div className="policy-card" style={{ gridTemplateColumns: '64px minmax(0,1fr)' }}>
      <span className="policy-id">{p.policyId}</span>
      <div style={{ display: 'grid', gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          <span style={{ fontWeight: 500 }}>{p.text}</span>
          <StatusChip status={p.status} />
        </div>
        <div className="policy-tpl">
          enforced as: {templateText(tpl)}
          {p.approvedBy ? `; ratified by ${p.approvedBy.split(':')[1] ?? p.approvedBy} on ${day(p.approvedAt)}` : ''}
        </div>
        <div className="row" style={{ gap: 6, fontSize: 13 }}>
          <span className="label">Learned from</span>
          {isSkillKey(p.sourceSkill) ? (
            <button className="chip active" style={{ cursor: 'pointer' }} onClick={() => setSub(p.sourceSkill.split('@')[0])}>
              {p.sourceSkill}
            </button>
          ) : (
            <span className="muted">{p.sourceSkill || 'not recorded'}</span>
          )}
        </div>
        {kin.length > 0 && tpl && 'fact' in tpl && (
          <div className="row" style={{ gap: 6, fontSize: 13 }}>
            <span className="label">Same guard elsewhere</span>
            {kin.map(k => (
              <span key={k.key} className="row" style={{ gap: 4 }}>
                <PolicyChip p={k} />
                <span className="muted">{(ACTION_LABEL[templateAction(template(k)) ?? ''] ?? '').toLowerCase()}</span>
              </span>
            ))}
            <span className="faint">all hold while {tpl.fact.replace(/_/g, ' ')}</span>
          </div>
        )}
        <div>
          <span className="label">{stopped.length ? `Stopped ${stopped.length} ${stopped.length === 1 ? 'attempt' : 'attempts'}` : 'Has not had to stop anything yet'}</span>
          {stopped.map(a => (
            <div key={a.id.toString()} className="row" style={{ gap: 6, fontSize: 13, marginTop: 3 }}>
              <button className="btn small quiet" style={{ height: 22, padding: '0 6px' }} onClick={() => openWhy(a.id)}>
                #{a.id.toString()}
              </button>
              <span className="faint num">{day(a.at)}</span>
              <ActorTag principal={a.principal} />
              <span>
                tried to {(ACTION_VERB[a.command] ?? a.command.replace(/_/g, ' ')).replace(/s$/, '').replace(/ies$/, 'y')}: {summarize(a)}
              </span>
            </div>
          ))}
        </div>
        <PolicyProof text={p.proof} />
        {(p.status === 'proposed' || p.status === 'active') && (
          <div className="controls">
            {p.status === 'proposed' && (
              <button className="btn small primary" disabled={act.pending} onClick={() => decide(true)} title={me.isController ? `Ratify as ${me.name}` : 'Only a person with the controller role may ratify (C6)'}>
                <Check size={13} /> Ratify
              </button>
            )}
            <button className="btn small" disabled={act.pending} onClick={() => decide(false)}>
              <X size={13} /> {p.status === 'active' ? 'Retire' : 'Reject'}
            </button>
          </div>
        )}
        <Result r={act.result} pending={act.pending} />
      </div>
    </div>
  );
}
