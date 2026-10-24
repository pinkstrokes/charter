// The evolution engine's proof, read as a reviewer would: what it learned
// from, what it fixes and breaks, how much of history it would change, and,
// kept apart, how the answer key grades it (never used to choose).
import { Check, ShieldAlert, X } from 'lucide-react';
import { openWhy } from '../app/nav';
import { day, money, pct } from '../lib/format';
import { parseLoose } from '../lib/json';
import { subjectLabel } from '../lib/lineage';
import { templateText, type PolicyTemplate } from '../lib/policies';
import { KV } from './ui';

type Obj = Record<string, unknown>;

const SKILL_KEYS = new Set(['gate', 'domain', 'parent', 'lesson', 'labeled', 'budget', 'changed', 'newLeads', 'safetyViolations', 'complexity', 'robustness', 'alternatives', 'origin', 'rationale', 'candidatesTried', 'candidatesPassed', 'seconds', 'selection', 'grading', 'evaluatedAt']);
const POLICY_KEYS = new Set(['gate', 'searched', 'replayedRequests', 'wouldHaveStopped', 'wouldHaveDelayed', 'benefitCents', 'costCents', 'extendsFrom', 'tightensOnly', 'evaluatedAt']);

export function Gate({ gate }: { gate?: unknown }) {
  if (gate === undefined || gate === null) return null;
  const pass = gate === 'pass' || gate === true;
  return (
    <span className={`gate ${pass ? 'pass' : 'fail'}`}>
      {pass ? <Check size={14} /> : <X size={14} />} gate {pass ? 'pass' : 'fail'}
    </span>
  );
}

function Budget({ label, n, total, limit, note }: { label: string; n: number; total: number; limit?: number; note?: string }) {
  const rate = total ? n / total : 0;
  const over = limit !== undefined && rate > limit;
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span>{label}</span>
        <span className={`num ${over ? 'red' : ''}`}>
          {n} of {total} ({pct(rate)}){limit !== undefined ? `, limit ${pct(limit, 0)}` : ''}
        </span>
      </div>
      {/* full width is twice the limit, so the limit sits at the midpoint mark */}
      <div className="meter" style={{ width: '100%', position: 'relative', overflow: 'visible' }}>
        <i style={{ width: `${Math.min(100, limit ? (rate / limit) * 50 : rate * 100)}%`, background: over ? 'var(--red)' : 'var(--taro)', borderRadius: 3 }} />
        {limit !== undefined && <span style={{ position: 'absolute', left: '50%', top: -3, bottom: -3, width: 1.5, background: 'var(--ink-2)' }} title="limit" />}
      </div>
      {note && <span className="faint" style={{ fontSize: 12 }}>{note}</span>}
    </div>
  );
}

export function SkillProof({ text }: { text: string }) {
  const p = parseLoose<Obj | null>(text, null);
  if (!p || typeof p !== 'object') return <span className="faint">{text ? text : 'No proof: a hand-written starting point.'}</span>;
  const lesson = (p.lesson ?? null) as { cases?: { subject: string; label: string; source: string; reason: string }[] } | null;
  const labeled = (p.labeled ?? null) as { n: number; correctBefore: number; correctAfter: number; fixed?: string[]; broken?: string[] } | null;
  const changed = (p.changed ?? null) as { n: number; total: number; limit?: number } | null;
  const budget = (p.budget ?? null) as { flagged: number; total: number; limit?: number } | null;
  const newLeads = Array.isArray(p.newLeads) ? (p.newLeads as string[]) : [];
  const alternatives = Array.isArray(p.alternatives) ? (p.alternatives as Obj[]) : [];
  const grading = (p.grading ?? null) as Record<string, Record<string, { n: number; current: number; candidate: number }>> | null;
  const rest: Obj = {};
  for (const [k, v] of Object.entries(p)) if (!SKILL_KEYS.has(k)) rest[k] = v;
  const violations = typeof p.safetyViolations === 'number' ? p.safetyViolations : undefined;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="row" style={{ gap: 14 }}>
        <Gate gate={p.gate} />
        {typeof p.candidatesTried === 'number' && (
          <span className="muted num" style={{ fontSize: 13 }}>
            {String(p.candidatesPassed ?? '?')} of {p.candidatesTried} candidates passed{typeof p.seconds === 'number' ? ` in ${p.seconds}s` : ''}
          </span>
        )}
        {violations !== undefined && (
          <span className={violations ? 'red' : 'tick'} style={{ fontSize: 13, fontWeight: 600 }}>
            {violations ? <ShieldAlert size={13} style={{ verticalAlign: -2 }} /> : <Check size={13} style={{ verticalAlign: -2 }} />} {violations} safety violation{violations === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {lesson?.cases?.length ? (
        <div>
          <div className="label">What people taught it</div>
          {lesson.cases.map((c, i) => (
            <div key={i} className="quote-block" style={{ marginTop: 6 }}>
              {c.reason}
              <div className="quote-by">
                {subjectLabel(c.subject)} should be “{c.label.replace(/_/g, ' ')}”; {c.source}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {labeled && (
        <div>
          <div className="label">Cases with a known answer</div>
          <div className="num" style={{ marginTop: 3 }}>
            right before: {labeled.correctBefore} of {labeled.n}; right after: <b>{labeled.correctAfter} of {labeled.n}</b>
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            fixes {labeled.fixed?.length ? labeled.fixed.map(subjectLabel).join(', ') : 'nothing'}; breaks {labeled.broken?.length ? <span className="red">{labeled.broken.map(subjectLabel).join(', ')}</span> : 'nothing'}
          </div>
        </div>
      )}

      {(changed || budget) && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="label">Replayed over every past decision</div>
          {changed && <Budget label="decisions it would change" n={changed.n} total={changed.total} limit={changed.limit} />}
          {budget && <Budget label="store-weeks it would send to audit" n={budget.flagged} total={budget.total} limit={budget.limit} />}
        </div>
      )}

      {newLeads.length > 0 && (
        <div>
          <div className="label">New leads: past weeks it would now flag</div>
          <div className="chips" style={{ marginTop: 4 }}>
            {newLeads.map(s => (
              <span key={s} className="chip">
                {subjectLabel(s)}
              </span>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>
            When this version goes live, replay sends these to a person as audit questions.
          </div>
        </div>
      )}

      {(typeof p.robustness === 'number' || typeof p.complexity === 'number') && (
        <div className="row" style={{ gap: 18, fontSize: 13 }}>
          {typeof p.robustness === 'number' && (
            <span title="Share of small perturbations of the taught cases it still decides the same way">
              robustness <b className="num">{pct(p.robustness, 0)}</b>
            </span>
          )}
          {typeof p.complexity === 'number' && (
            <span title="Size of the program; smaller is preferred">
              complexity <b className="num">{p.complexity}</b>
            </span>
          )}
          {typeof p.origin === 'string' && <span className="muted">written by {p.origin}</span>}
        </div>
      )}

      {typeof p.rationale === 'string' && (
        <div>
          <div className="label">The engine's rationale</div>
          <div className="muted" style={{ fontSize: 13, maxWidth: '72ch' }}>
            {p.rationale}
          </div>
        </div>
      )}

      {alternatives.length > 0 && (
        <div>
          <div className="label">Runners-up that also passed</div>
          <table className="table compact" style={{ marginTop: 4 }}>
            <thead>
              <tr>
                <th>Candidate</th>
                <th className="n">Robustness</th>
                <th className="n">New leads</th>
                <th className="n">Complexity</th>
              </tr>
            </thead>
            <tbody>
              {alternatives.map((a, i) => (
                <tr key={i}>
                  <td>{String(a.origin ?? `#${i + 1}`)}</td>
                  <td className="n">{typeof a.robustness === 'number' ? pct(a.robustness, 0) : '—'}</td>
                  <td className="n">{String(a.newLeads ?? '—')}</td>
                  <td className="n">{String(a.complexity ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {typeof p.selection === 'string' && <div className="faint" style={{ fontSize: 12 }}>Selection: {p.selection}</div>}

      {grading && Object.keys(grading).length > 0 && <Grading grading={grading} />}

      {Object.keys(rest).length > 0 && <KV data={rest} />}
      {typeof p.evaluatedAt === 'string' && <div className="faint" style={{ fontSize: 12 }}>evaluated {new Date(p.evaluatedAt).toLocaleString()}</div>}
    </div>
  );
}

const SPLIT_ORDER = ['train', 'val', 'test', 'live'];

function Grading({ grading }: { grading: Record<string, Record<string, { n: number; current: number; candidate: number }>> }) {
  const splits = Object.keys(grading).sort((a, b) => SPLIT_ORDER.indexOf(a) - SPLIT_ORDER.indexOf(b));
  return (
    <div className="sheet" style={{ borderStyle: 'dashed', background: 'transparent' }}>
      <div className="sheet-pad" style={{ paddingBottom: 6 }}>
        <div className="label">Graded only, never used to choose</div>
        <div className="faint" style={{ fontSize: 12 }}>
          The world's answer key scores current and candidate after selection. The engine never saw test or live cases.
        </div>
      </div>
      <table className="table compact">
        <thead>
          <tr>
            <th>Split</th>
            <th>Scenario family</th>
            <th className="n">Cases</th>
            <th className="n">Current right</th>
            <th className="n">Candidate right</th>
          </tr>
        </thead>
        <tbody>
          {splits.flatMap(split =>
            Object.entries(grading[split]).map(([family, c], i) => (
              <tr key={`${split}:${family}`}>
                <td>{i === 0 ? split : ''}</td>
                <td>{family.replace(/_/g, ' ')}</td>
                <td className="n">{c.n}</td>
                <td className="n">{c.current}</td>
                <td className="n" style={{ fontWeight: c.candidate > c.current ? 600 : 400 }}>
                  {c.candidate}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function PolicyProof({ text }: { text: string }) {
  const p = parseLoose<Obj | null>(text, null);
  if (!p || typeof p !== 'object' || !Object.keys(p).length) return <span className="faint">No proof attached.</span>;
  const stopped = Array.isArray(p.wouldHaveStopped) ? (p.wouldHaveStopped as { activityId: number; at: string; why: string }[]) : [];
  const delayed = Array.isArray(p.wouldHaveDelayed) ? (p.wouldHaveDelayed as { activityId: number; at: string; amountCents: number }[]) : [];
  const rest: Obj = {};
  for (const [k, v] of Object.entries(p)) if (!POLICY_KEYS.has(k)) rest[k] = v;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="row" style={{ gap: 14, fontSize: 13 }}>
        <Gate gate={p.gate} />
        {typeof p.replayedRequests === 'number' && <span className="muted num">replayed against {p.replayedRequests} past requests</span>}
        {typeof p.searched === 'number' && <span className="muted num">{p.searched} rules searched</span>}
        {p.tightensOnly === true && <span className="muted">only tightens</span>}
      </div>
      {stopped.length > 0 && typeof p.benefitCents === 'number' && (
        <div className="row num" style={{ gap: 18, fontSize: 13 }}>
          <span>
            would have saved <b>{money(p.benefitCents)}</b> in return fees and handling
          </span>
          <span>
            {delayed.length ? (
              <>
                would have held back <b>{delayed.length}</b> legitimate {delayed.length === 1 ? 'request' : 'requests'} worth {money(delayed.reduce((s, d) => s + d.amountCents, 0))} for a week
                {typeof p.costCents === 'number' && <> (cost {money(p.costCents)})</>}
              </>
            ) : (
              'would have held back nothing legitimate'
            )}
          </span>
        </div>
      )}
      {stopped.length > 0 && (
        <div>
          <div className="label">Past requests it would have stopped</div>
          {stopped.map((s, i) => (
            <div key={i} className="row" style={{ fontSize: 13, gap: 6 }}>
              <button className="btn small quiet" onClick={() => openWhy(BigInt(s.activityId))}>
                #{s.activityId}
              </button>
              <span className="muted">{day(s.at)}</span>
              <span>{s.why}</span>
            </div>
          ))}
        </div>
      )}
      {delayed.length > 0 && (
        <div>
          <div className="label">Legitimate requests it would have delayed</div>
          {delayed.map((s, i) => (
            <div key={i} className="row" style={{ fontSize: 13, gap: 6 }}>
              <button className="btn small quiet" onClick={() => openWhy(BigInt(s.activityId))}>
                #{s.activityId}
              </button>
              <span className="muted">{day(s.at)}</span>
              <span className="num">{money(s.amountCents)}</span>
            </div>
          ))}
        </div>
      )}
      {typeof p.extendsFrom === 'string' && p.extendsFrom && (
        <div className="muted" style={{ fontSize: 13 }}>
          the same risk on another way money leaves: extends “{templateText(parseLoose<PolicyTemplate | null>(p.extendsFrom, null))}”, and would never have held back a past request of this kind
        </div>
      )}
      {Object.keys(rest).length > 0 && <KV data={rest} />}
    </div>
  );
}
