import { ArrowDown, ArrowRight, ArrowUp, Check, FlaskConical, Lock, MessageSquareWarning, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Activity, Decision, Skill } from '../module_bindings/types';
import { ActorTag, FeatureTable, KV, Money, OutcomeChip, PolicyChip, Result, StatusChip } from '../components/ui';
import { runVerify, useChainState } from '../components/Chain';
import { MisappliedText } from '../components/CashFacts';
import { useActivityById, useActivityDesc, useMe, usePolicyLookup } from '../app/data';
import { closeWhy, go, openWhy } from '../app/nav';
import { actor, answerWords, askLabel, commandLabel, day, money, num, prettyText, ROLE_LABEL } from '../lib/format';
import { parseArr, parseLoose, parseObj, present } from '../lib/json';
import { actionsOf, decisionFor, originsOf, planPolicies, proofSummary, ruleOrigin, skillTransitions, subjectLabel } from '../lib/lineage';
import { factText, template } from '../lib/policies';
import { askDomain, DOMAINS, domainOf, explainComparisons, exprText, featureLabel, outcomeText, parseProgram, parseTreatments, run, sameTreatment, type FeatureMap } from '../lib/rules';
import { summarize } from '../lib/summary';
import { useAction } from '../stdb/actions';
import { charter } from '../stdb/client';
import { useRows } from '../stdb/store';

export function Why({ id }: { id: bigint }) {
  const byId = useActivityById();
  const ordered = useActivityDesc();
  const a = byId.get(id);
  const index = ordered.findIndex(x => x.id === id);
  const step = (d: number) => {
    const next = ordered[index + d];
    if (next) openWhy(next.id);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        step(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <>
      <div className="scrim" onClick={closeWhy} />
      <aside className="drawer" role="dialog" aria-label={`Why: activity ${id}`}>
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 8, marginBottom: 4 }}>
              {a && <OutcomeChip outcome={a.outcome} />}
              <span className="faint num" style={{ fontSize: 12 }}>
                #{id.toString()}
                {a ? `, ${day(a.at, true)}` : ''}
              </span>
            </div>
            <h2 className="drawer-title">{a ? commandLabel(a.kind, a.command) : 'Not on the record yet'}</h2>
            {a && <div className="muted" style={{ marginTop: 2 }}>{summarize(a)}</div>}
          </div>
          <button className="icon-btn" onClick={() => step(-1)} disabled={index <= 0} aria-label="Newer row" title="Newer (↑)">
            <ArrowUp size={16} />
          </button>
          <button className="icon-btn" onClick={() => step(1)} disabled={index < 0 || index >= ordered.length - 1} aria-label="Older row" title="Older (↓)">
            <ArrowDown size={16} />
          </button>
          <button className="icon-btn" onClick={closeWhy} aria-label="Close" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body" key={id.toString()}>{a ? <WhyBody key={id.toString()} a={a} /> : <p className="muted">Row #{id.toString()} has not reached this browser. It may belong to another database, or it is still arriving.</p>}</div>
      </aside>
    </>
  );
}

function WhyBody({ a }: { a: Activity }) {
  const decisions = useRows('decision');
  const skills = useRows('skill');
  const policyOf = usePolicyLookup();
  const params = parseObj(a.params);
  const reasons = parseArr<string>(a.reasons);
  const context = present(parseObj(a.context));
  const claims = parseArr<{ label: string; lhs: number; rhs: number[]; invoices?: string[]; bills?: string[]; tolerance: number }>(a.claims);
  const used = parseArr<string>(a.used);
  const stopped = a.outcome === 'denied' || a.outcome === 'rejected';
  const decision = useMemo(() => decisionFor(a, decisions), [a, decisions]);
  const policyIds = planPolicies(a.plan);
  const hitIds = new Set(reasons.map(r => /^([A-Z][A-Za-z]*-?[A-Za-z0-9]*):/.exec(r)?.[1]).filter(Boolean) as string[]);
  const principalKind = String(context.principalKind ?? (a.principal.startsWith('seat:') ? 'seat' : ''));
  // A seat carrying out a person's answer names the question in its plan (ask:141).
  const planAsk = parseArr<string>(a.plan).find(x => /^ask:\d+$/.test(x));
  const askRef = a.kind === 'ask' || (a.command === 'answer_ask' && params.ask !== undefined) ? params.ask : planAsk ? Number(planAsk.slice(4)) : undefined;
  const askId = typeof askRef === 'number' ? BigInt(askRef) : undefined;
  // A correction names the decision it corrects; a concern names the store-week it is about.
  const corrected = typeof params.correction === 'number' ? decisions.find(x => x.id === BigInt(params.correction as number)) : undefined;
  const concernOn = typeof params.concern === 'string' ? decisions.filter(x => x.subject === params.concern && !x.shadow).pop() : undefined;
  // Rows that name their question only through the evidence: a person's reversal answers a
  // "wrong invoice?" question about that receipt; set-aside work raises a question about itself.
  const asks = useRows('ask');
  const related = useMemo(() => {
    if (a.command === 'reverse_application' && typeof params.receipt === 'string') {
      const q = asks.filter(x => x.kind === 'misapplied' && parseObj(x.evidence).earlier === params.receipt && x.status === 'answered' && x.answeredAt <= a.at).pop();
      return q ? { id: q.id, title: 'Done on this answer' } : undefined;
    }
    if (a.command === 'set_aside' && typeof params.work === 'number') {
      const q = asks.find(x => x.kind === 'set_aside' && parseObj(x.evidence).work === params.work);
      return q ? { id: q.id, title: 'The question it raised' } : undefined;
    }
    return undefined;
  }, [a, asks, params.receipt, params.work]);
  // Rows whose own box says everything their params hold.
  const ownBox = a.kind === 'ask' || a.command === 'verdict_declined' || a.command === 'set_aside' || a.command === 'reverse_application';

  return (
    <>
      {stopped && (
        <div className="stopped-box" role="alert">
          <h3>
            <ShieldAlert size={14} style={{ verticalAlign: -2 }} /> {a.outcome === 'rejected' ? 'Rejected by the kernel; nothing changed' : 'Denied by policy; nothing changed'}
          </h3>
          <ul>
            {reasons.map((r, i) => {
              const pid = /^([A-Z][A-Za-z]*-?[A-Za-z0-9]*):/.exec(r)?.[1];
              const p = pid ? policyOf(pid) : undefined;
              return (
                <li key={i}>
                  {r}
                  {p && <div className="policy-text">{p.text}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {a.command === 'inspection_level' && <ReliabilityBox params={params} />}
      {a.command === 'verdict_declined' && <VerdictDeclinedBox params={params} reason={reasons[0] ?? ''} />}
      {a.command === 'set_aside' && <SetAsideBox params={params} error={reasons[0] ?? ''} />}
      {a.command === 'reverse_application' && <ReversalBox a={a} params={params} />}
      {a.command === 'apply_receipt' && params.payer !== undefined && <PayerBox payer={params.payer} />}
      {askId !== undefined && <AskBox id={askId} a={a} skills={skills} decisions={decisions} title={planAsk && a.kind !== 'ask' && a.command !== 'answer_ask' ? 'Carried out on this answer' : undefined} />}
      {askId === undefined && related && <AskBox id={related.id} a={a} skills={skills} decisions={decisions} title={related.title} />}

      <section className="why-section">
        <h3>Who</h3>
        <div className="row" style={{ gap: 10 }}>
          <ActorTag principal={a.principal} role={a.role} />
          {(ROLE_LABEL[a.role] ?? a.role) !== actor(a.principal, a.role).label && <span className="muted">{ROLE_LABEL[a.role] ?? a.role}</span>}
          {principalKind && <span className="chip">{principalKind === 'seat' ? 'a seat: code, not a person' : principalKind === 'human' ? 'a person' : principalKind}</span>}
        </div>
      </section>

      {!ownBox && (
        <section className="why-section">
          <h3>What it asked for</h3>
          <Params params={params} command={a.command} />
        </section>
      )}

      {(decision ?? corrected ?? concernOn) && (
        <DecisionBox
          d={(decision ?? corrected ?? concernOn)!}
          skills={skills}
          a={a}
          title={a.command === 'verdict_declined' ? 'The decision the verdict was about' : decision ? 'Why the seat decided this' : corrected ? 'The decision being corrected' : 'The decision the concern is about'}
        />
      )}

      {policyIds.length > 0 && (
        <section className="why-section">
          <h3>Policies the kernel checked</h3>
          {policyIds.map(pid => {
            const p = policyOf(pid);
            if (!p) return null;
            const tpl = template(p);
            const grants = tpl?.t === 'role_can';
            if (grants && tpl.role !== a.role) return null; // lists this action for another role
            return (
              <div key={pid} className="policy-line">
                <PolicyChip p={p} hit={hitIds.has(pid)} />
                <div>
                  <span className={hitIds.has(pid) ? 'red' : ''}>{p.text}</span>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {grants ? 'permits this role' : hitIds.has(pid) ? 'this rule said no' : 'checked, satisfied'}
                    {p.policyId.startsWith('P-') && p.approvedBy ? `; learned, ratified by ${p.approvedBy.split(':')[1] ?? p.approvedBy} on ${day(p.approvedAt)}` : ''}
                  </div>
                </div>
              </div>
            );
          })}
          {reasons.some(r => r.startsWith('no rule lets')) && <div className="red" style={{ fontSize: 13 }}>No active policy lets the {ROLE_LABEL[a.role] ?? a.role} do this.</div>}
        </section>
      )}

      {Object.keys(context).length > 0 && <ContextBox context={context} hit={hitIds} policyIds={policyIds} />}

      {claims.length > 0 && (
        <section className="why-section">
          <h3>Claims checked against the ledger</h3>
          {claims.map((c, i) => {
            const failed = reasons.some(r => r.includes(`claim "${c.label}"`));
            return (
              <div key={i} className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'nowrap' }}>
                {failed ? <X size={14} className="red" /> : <Check size={14} className="tick" />}
                <div>
                  <div>{c.label}</div>
                  <div className="muted num" style={{ fontSize: 12 }}>
                    claimed {money(c.lhs)}
                    {c.invoices?.length || c.bills?.length ? `; the kernel re-adds the open balance of ${[...(c.invoices ?? []), ...(c.bills ?? [])].join(', ')} from the ledger` : ''}
                    {c.rhs.length ? ` plus ${c.rhs.map(x => money(x)).join(' + ')}` : ''}; tolerance {money(c.tolerance)}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {used.length > 0 && (
        <section className="why-section">
          <h3>Evidence it used</h3>
          <div style={{ display: 'grid', gap: 6 }}>
            {used.map(u => (
              <Ref key={u} r={u} />
            ))}
          </div>
        </section>
      )}

      <ChainBox a={a} />
    </>
  );
}

// An inspection-level change for one rule (module reliability.ts).
function ReliabilityBox({ params }: { params: Record<string, unknown> }) {
  const n = (k: string) => (typeof params[k] === 'number' ? (params[k] as number) : 0);
  const pctOf = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
  return (
    <section className="why-section">
      <h3>Earned autonomy</h3>
      <div style={{ display: 'grid', gap: 6 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className="mono">{String(params.rule ?? '')}</span>
          <StatusChip status={String(params.from ?? '')} />
          <span className="faint">to</span>
          <StatusChip status={String(params.to ?? '')} />
        </div>
        <div className="muted num" style={{ fontSize: 13 }}>
          {n('errors')} wrong in {n('checked')} checks. With 95% confidence its error rate is between {pctOf(n('lower95'))} and {pctOf(n('upper95'))}; the team tolerates {pctOf(n('tolerable'))}.
        </div>
        <div>
          <button className="btn small option" onClick={() => go('knowledge', 'autonomy')}>
            See every rule's record
          </button>
        </div>
      </div>
    </section>
  );
}

// The question behind an ask row (or answered by an answer row), and the decision that raised it.
function AskBox({ id, a, skills, decisions, title = 'The question' }: { id: bigint; a: Activity; skills: Skill[]; decisions: Decision[]; title?: string }) {
  const asks = useRows('ask');
  const q = asks.find(x => x.id === id);
  if (!q) return null;
  const ev = parseObj(q.evidence);
  const features = ev.features && typeof ev.features === 'object' ? (ev.features as Record<string, unknown>) : null;
  const domain = askDomain(q.kind, ev) ?? (features ? domainOf(features) : undefined);
  // The module names the decision behind a question in its evidence; older rows fall back to a match.
  const named = typeof ev.decision === 'number' ? ev.decision : typeof ev.earlierDecision === 'number' ? ev.earlierDecision : undefined;
  const exact = named !== undefined ? decisions.find(x => x.id === BigInt(named)) : undefined;
  const d =
    exact ??
    (domain ? decisions.filter(x => x.domain === domain && !x.shadow && (x.subject === q.subject || x.subject.startsWith(`${q.subject}:`)) && x.at === q.createdAt).pop() : undefined);
  return (
    <>
      <section className="why-section">
        <h3>{title}</h3>
        <div style={{ display: 'grid', gap: 8 }}>
          <div>{prettyText(q.question)}</div>
          <div className="row" style={{ gap: 8, fontSize: 13 }}>
            <span className="chip asked">{askLabel(q.kind)}</span>
            <span className="muted">
              #{q.id.toString()} {q.raisedBy && q.raisedBy !== 'kernel' ? `raised by ${actor(q.raisedBy).label.toLowerCase().startsWith('replay') ? q.raisedBy : actor(q.raisedBy).label}, ` : ''}to the {ROLE_LABEL[q.toRole]?.toLowerCase() ?? q.toRole}, asked {day(q.createdAt)}
              {q.status === 'open' ? `, due ${day(q.deadline)}` : ''}
            </span>
            {q.status === 'open' && (
              <button className="btn small option" onClick={() => go('inbox')}>
                Answer in the inbox
              </button>
            )}
          </div>
          {q.status === 'answered' && (
            <div className="quote-block">
              {q.reason || `“${q.answer}”`}
              <div className="quote-by">
                {q.answeredBy.split(':')[1] ?? q.answeredBy} answered “{answerWords(q.answer)}” on {day(q.answeredAt)}
              </div>
            </div>
          )}
          {q.status === 'expired' && <div className="muted">Expired unanswered on {day(q.deadline)}.</div>}
          {!d && features && q.kind !== 'misapplied' && <FeatureTable features={features} domain={domain} />}
        </div>
      </section>
      {q.kind === 'misapplied' && <MisappliedFacts evidence={ev} />}
      {d && <DecisionBox d={d} skills={skills} a={a} title={q.kind === 'misapplied' ? 'The earlier decision it questions' : 'The decision that raised it'} />}
    </>
  );
}

// Where a verdict came from, in words (module reliability.ts STRENGTH keys).
const VERDICT_SOURCE: Record<string, string> = {
  answer: 'answering a question',
  spot_check: 'in a spot check',
  correction: 'marking the decision wrong',
  field_audit: 'after a field audit',
  internal_audit: 'in an internal audit',
};

// A person's verdict that would break the agreement: kept on the record, not counted, not learned.
function VerdictDeclinedBox({ params, reason }: { params: Record<string, unknown>; reason: string }) {
  const by = String(params.by ?? '');
  const who = by ? actor(by).label : 'A person';
  const source = VERDICT_SOURCE[String(params.source ?? '')] ?? '';
  return (
    <section className="why-section">
      <h3>A verdict the team did not take</h3>
      <div style={{ display: 'grid', gap: 8 }}>
        <div>
          {who}
          {source ? `, ${source},` : ''} said the seat should have decided <b style={{ fontWeight: 600 }}>{outcomeText(String(params.verdict ?? ''))}</b> on {subjectLabel(String(params.subject ?? ''))}. The seat had decided{' '}
          <b style={{ fontWeight: 600 }}>{outcomeText(String(params.decided ?? ''))}</b>.
        </div>
        {reason && (
          <div>
            Declined: {reason.charAt(0).toUpperCase() + reason.slice(1)}.
          </div>
        )}
        <div className="muted" style={{ fontSize: 13 }}>
          The decision stands. The verdict is kept on the record but not counted against the seat, and the evolution engine does not learn from it.
        </div>
      </div>
    </section>
  );
}

// Work the desk could not finish; it fails on its own and goes to a person.
function SetAsideBox({ params, error }: { params: Record<string, unknown>; error: string }) {
  const kind = String(params.kind ?? 'work').replace(/_/g, ' ');
  return (
    <section className="why-section">
      <h3>Set aside for a person</h3>
      <div style={{ display: 'grid', gap: 6 }}>
        <div>
          The {kind} for {subjectLabel(String(params.subject ?? ''))} could not be handled{error ? ':' : '.'}
          {error && <span className="mono" style={{ fontSize: 12.5 }}> {error}</span>}
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          Each item runs in its own transaction, so nothing it started was kept and the rest of the run went on. Work item #{String(params.work ?? '')} is marked failed.
        </div>
      </div>
    </section>
  );
}

// ACH return codes a franchisor sees most (NACHA).
const RETURN_CODE: Record<string, string> = {
  R01: 'insufficient funds',
  R02: 'account closed',
  R03: 'no account, or the account could not be found',
  R04: 'invalid account number',
  R07: 'authorization revoked',
  R08: 'payment stopped',
  R09: 'uncollected funds',
  R10: 'the customer says it was not authorized',
  R16: 'account frozen',
  R20: 'not a transaction account',
  R29: 'the company says it was not authorized',
};

// Cash taken back off invoices: a debit the bank returned, or a person putting a receipt back to unapplied.
function ReversalBox({ a, params }: { a: Activity; params: Record<string, unknown> }) {
  const applications = useRows('application');
  if (typeof params.returnTxn === 'string') {
    const code = String(params.code ?? '');
    return (
      <section className="why-section">
        <h3>What was undone</h3>
        <div>
          The bank returned debit <b style={{ fontWeight: 600 }}>{String(params.original ?? '')}</b> as {params.returnTxn}
          {code ? `, code ${code}${RETURN_CODE[code] ? `: ${RETURN_CODE[code]}` : ''}` : ''}. The invoices it had paid are open again.
        </div>
      </section>
    );
  }
  const ids = Array.isArray(params.applications) ? (params.applications as (number | string)[]).map(x => String(x)) : [];
  const rows = ids.map(id => ({ id, app: applications.find(x => x.id.toString() === id) }));
  const total = rows.reduce((sum, r) => sum + (r.app ? Number(r.app.amountCents) : 0), 0);
  const known = rows.every(r => r.app);
  return (
    <section className="why-section">
      <h3>What was undone</h3>
      <div style={{ display: 'grid', gap: 8 }}>
        <div>
          {actor(a.principal, a.role).label} put {known ? <Money cents={total} /> : 'the cash'} of receipt <b style={{ fontWeight: 600 }}>{String(params.receipt ?? '')}</b> back to unapplied cash
          {typeof params.reason === 'string' && params.reason ? `, because ${params.reason}` : ''}.
        </div>
        {rows.length > 0 && (
          <table className="table compact">
            <thead>
              <tr>
                <th>Taken off invoice</th>
                <th className="n">Amount</th>
                <th>Applied by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>{r.app ? r.app.invoiceId : `application #${r.id}`}</td>
                  <td className="n">{r.app ? <Money cents={r.app.amountCents} /> : ''}</td>
                  <td>
                    {r.app && r.app.activityId > 0n ? (
                      <button className="btn small quiet" onClick={() => openWhy(r.app!.activityId)}>
                        #{r.app.activityId.toString()}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

// How the bank feed decided who paid: the sources it weighed, and anyone else it could have been.
function PayerBox({ payer }: { payer: unknown }) {
  const entities = useRows('entity');
  const p = (payer && typeof payer === 'object' ? payer : {}) as { code?: string; evidence?: string[]; candidates?: string[] };
  const name = (code: string) => entities.find(e => e.code === code)?.name;
  const others = (p.candidates ?? []).filter(c => c !== p.code);
  return (
    <section className="why-section">
      <h3>Who paid</h3>
      <div style={{ display: 'grid', gap: 6 }}>
        <div>
          {p.code ? (
            <>
              <b style={{ fontWeight: 600 }}>{p.code}</b>
              {name(p.code) ? `, ${name(p.code)}` : ''}
            </>
          ) : (
            'Not decided from the bank line; a person says who it is.'
          )}
        </div>
        {(p.evidence ?? []).length > 0 && (
          <ul className="evidence-list">
            {(p.evidence ?? []).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        {others.length > 0 && <div className="muted" style={{ fontSize: 13 }}>Also possible: {others.map(c => (name(c) ? `${c} (${name(c)})` : c)).join(', ')}</div>}
      </div>
    </section>
  );
}

// The two payments behind a "cash applied to the wrong invoice?" question.
function MisappliedFacts({ evidence }: { evidence: Record<string, unknown> }) {
  if (!evidence.invoice) return null;
  return (
    <section className="why-section">
      <h3>The earlier payment</h3>
      <MisappliedText evidence={evidence} />
    </section>
  );
}

function Params({ params, command }: { params: Record<string, unknown>; command: string }) {
  const p = { ...params };
  const allocations = Array.isArray(p.allocations) ? (p.allocations as { id: string; cents: number }[]) : null;
  const features = p.features && typeof p.features === 'object' ? (p.features as Record<string, unknown>) : null;
  delete p.allocations;
  delete p.features;
  delete p.payer; // shown as "Who paid"
  if (command === 'answer_ask' && typeof p.reason === 'string') delete p.reason; // quoted with the question
  const inherits = command === 'hire_seat' ? (p.inherits as { skills?: string[]; policies?: string[] } | undefined) : undefined;
  if (inherits) delete p.inherits;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <KV data={p} columns={2} />
      {allocations && (
        <table className="table compact">
          <thead>
            <tr>
              <th>Invoice</th>
              <th className="n">Applied</th>
            </tr>
          </thead>
          <tbody>
            {allocations.map(x => (
              <tr key={x.id}>
                <td>{x.id}</td>
                <td className="n">{money(x.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {features && Object.keys(features).length > 0 && <FeatureTable features={features} />}
      {inherits && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div>
            <span className="label">Skills it starts with</span>
            <div className="chips" style={{ marginTop: 3 }}>
              {(inherits.skills ?? []).map(k => (
                <button key={k} className="chip active" style={{ cursor: 'pointer' }} onClick={() => go('knowledge', k.split('@')[0])}>
                  {k}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Policies it is bound by</span>
            <div className="chips" style={{ marginTop: 3 }}>
              {(inherits.policies ?? []).map(k => (
                <span key={k} className={`chip policy ${k.startsWith('P-') ? 'promoted' : k.startsWith('C') ? 'constitution' : ''}`}>
                  {k.split('@')[0]}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function DecisionBox({ d, skills, a, title = 'Why the seat decided this' }: { d: Decision; skills: Skill[]; a?: Activity; title?: string }) {
  const baseKey = d.skillKey.split('+')[0];
  const precedent = /\+precedent#(\d+)/.exec(d.skillKey)?.[1];
  const skill = skills.find(s => s.key === baseKey);
  const program = skill ? parseProgram(skill.program) : null;
  const features = parseLoose<FeatureMap>(d.features, {});
  const fired = d.ruleIndex;
  const rule = program && fired >= 0 ? program.rules[fired] : undefined;
  const comparisons = rule ? explainComparisons(rule.when, features) : [];
  const usedNames = new Set<string>();
  if (rule) collectFeatures(rule.when, usedNames);
  // What the team's skill in force today would say about the same facts.
  const current = skills.filter(s => s.domain === d.domain && s.status === 'active').sort((x, y) => y.version - x.version)[0];
  let now: { key: string; decide: string; rule: number } | null = null;
  if (current && current.key !== baseKey && Object.keys(features).length) {
    const prog = parseProgram(current.program);
    try {
      if (prog) {
        const r = run(prog, features);
        now = { key: current.key, decide: r.outcome.decide, rule: r.trace.ruleIndex };
      }
    } catch {
      now = null;
    }
  }
  return (
    <section className="why-section">
      <h3>{title}</h3>
      <div className="rule-box">
        <div className="rule-box-head">
          <span>{baseKey}</span>
          {skill && <StatusChip status={skill.status} />}
          <span style={{ marginLeft: 'auto', fontWeight: 400 }}>
            decided <b>{outcomeText(d.outcome)}</b> on {subjectLabel(d.subject)}
          </span>
        </div>
        {precedent && (
          <div className="rule-note" style={{ padding: '8px 11px', borderBottom: '1px solid var(--rule)', color: 'var(--ink)' }}>
            <MessageSquareWarning size={13} style={{ verticalAlign: -2, color: 'var(--taro)' }} /> Following a person's correction (question #{precedent}) instead of its own rule:{' '}
            <span className="serif" style={{ fontStyle: 'italic' }}>
              {d.note}
            </span>
          </div>
        )}
        {program ? (
          <ol className="rules">
            {program.rules.map((r, i) => (
              <li key={i} className={i === fired ? 'fired' : ''}>
                <span className="ix">{i + 1}</span>
                <div>
                  <div className="rule-when">if {exprText(r.when)}</div>
                  <div className="rule-then">
                    then <b>{outcomeText(r.then.decide)}</b>
                    {r.then.note ? <span className="rule-note"> “{r.then.note}”</span> : null}
                  </div>
                  {i === fired && comparisons.length > 0 && (
                    <ul className="cmp-list">
                      {comparisons.map((c, j) => (
                        <li key={j}>
                          {c.holds === false ? <X size={11} /> : <Check size={11} />} {c.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  {i === fired && skill && <RuleOrigin rule={r} skill={skill} skills={skills} />}
                </div>
              </li>
            ))}
            <li className={fired === -1 ? 'fired' : ''}>
              <span className="ix">—</span>
              <div>
                <div className="rule-when">otherwise</div>
                <div className="rule-then">
                  <b>{outcomeText(program.otherwise.decide)}</b>
                  {fired === -1 && <span className="rule-note"> no rule matched this case</span>}
                </div>
              </div>
            </li>
          </ol>
        ) : (
          <div className="rule-note" style={{ padding: 10 }}>
            {d.note || 'skill program not available'}
          </div>
        )}
      </div>
      {d.label && <CheckedLater d={d} />}
      <CausedActions d={d} />
      {now && (
        <div className="row" style={{ marginTop: 8, fontSize: 13, gap: 6 }}>
          <span className="chip active">{now.key}</span>
          <span>
            in force today, would decide <b style={{ fontWeight: 600 }}>{outcomeText(now.decide)}</b>
            {now.rule >= 0 ? ` (rule ${now.rule + 1})` : ' (otherwise)'}
            {now.decide !== d.outcome ? '; the team has learned since' : '; the same'}
          </span>
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
          Every feature the seat saw ({Object.keys(features).length})
        </summary>
        <div style={{ marginTop: 6 }}>
          <FeatureTable features={features} domain={d.domain} used={usedNames} />
        </div>
      </details>
      <CorrectDecision d={d} a={a} />
    </section>
  );
}

// Where the rule that fired came from: the version that introduced it, when it went
// live, whose answers taught it, and what replaying it over the past showed first.
function RuleOrigin({ rule, skill, skills }: { rule: NonNullable<ReturnType<typeof parseProgram>>['rules'][number]; skill: Skill; skills: Skill[] }) {
  const asks = useRows('ask');
  const activity = useRows('activity');
  const origin = ruleOrigin(rule, skill, skills);
  const live = skillTransitions(origin.key, activity).find(t => t.to === 'active');
  const proof = proofSummary(origin.proof);
  const source = proof.gate === 'imported' ? (proof.raw?.source as { company?: string; skill?: string } | undefined) : undefined;
  const people = originsOf(origin, asks);
  const who = (by: string) => by.split(':')[1] ?? by;
  // Of the lessons this version handles, the reason people gave most often for this rule's outcome.
  const lessons = ((proof.raw?.lesson as { cases?: { label: string; reason: string; source: string; handled?: boolean }[] } | undefined)?.cases ?? []).filter(c => c.label === rule.then.decide && c.handled !== false && c.reason);
  const reasons = new Map<string, { n: number; by: string }>();
  for (const c of lessons) reasons.set(c.reason, { n: (reasons.get(c.reason)?.n ?? 0) + 1, by: /(?:answered|audit) by (\S+)/.exec(c.source)?.[1] ?? c.source });
  const top = [...reasons].sort((x, y) => y[1].n - x[1].n)[0];
  return (
    <div className="rule-origin">
      {origin.version === 1 && !source ? (
        <>Written on day one, before anyone answered anything.</>
      ) : (
        <>
          Learned in{' '}
          <button type="button" className="chip active" style={{ cursor: 'pointer' }} onClick={() => go('knowledge', origin.domain)}>
            {origin.key}
          </button>
          {live ? `, live ${day(live.at)}` : ''}
          {source ? (
            `, at ${source.company ?? 'a sister company'} (${source.skill ?? 'its skill'}), ratified here`
          ) : top ? (
            <>
              , from {who(top[1].by)}’s answers: <span className="serif">“{top[0]}”</span>
              {lessons.length > 1 ? ` (${lessons.length} cases)` : ''}
            </>
          ) : people.length ? (
            <>
              , from {who(people[0].by)}: <span className="serif">“{people[0].text}”</span>
              {people.length > 1 ? ` and ${people.length - 1} more` : ''}
            </>
          ) : null}
          {proof.fixed !== undefined ? `; replayed over the past first: fixed ${proof.fixed}, broke ${proof.broken ?? 0}` : ''}.
        </>
      )}
    </div>
  );
}

// What the module recorded as caused by this decision (used: decision:<id>).
function CausedActions({ d }: { d: Decision }) {
  const activity = useRows('activity');
  // Inspection changes and declined verdicts name the decision too, but are not its consequences.
  const caused = useMemo(() => actionsOf(d, activity).filter(x => x.kind !== 'reliability'), [d, activity]);
  if (!caused.length) return null;
  return (
    <div style={{ marginTop: 8, fontSize: 13 }}>
      <span className="label">What it caused</span>
      {caused.slice(0, 6).map(c => (
        <div key={c.id.toString()} className="row" style={{ gap: 6, marginTop: 2 }}>
          <button className="btn small quiet" style={{ height: 22, padding: '0 6px' }} onClick={() => openWhy(c.id)}>
            #{c.id.toString()}
          </button>
          <span>{commandLabel(c.kind, c.command)}</span>
          <span className="muted">{summarize(c)}</span>
          <OutcomeChip outcome={c.outcome} />
        </div>
      ))}
    </div>
  );
}

const CHECK_SOURCE: Record<string, string> = {
  answer: 'a person answering its question',
  spot_check: 'a spot check',
  correction: 'a correction',
  field_audit: 'a field audit',
  internal_audit: 'the internal auditor',
};

// A later check of this decision: what a person or an audit established.
function CheckedLater({ d }: { d: Decision }) {
  const [source, ...who] = d.labelSource.split(':');
  const by = who.length >= 2 ? who[1] : who.join(':');
  const right = sameTreatment(d.domain, d.outcome, d.label, parseTreatments(d.treatments));
  return (
    <div className="row" style={{ marginTop: 8, fontSize: 13, gap: 6, flexWrap: 'nowrap', alignItems: 'baseline' }}>
      {right ? <Check size={13} className="tick" /> : <X size={13} />}
      <span>
        Checked later by {CHECK_SOURCE[source] ?? source}
        {by ? ` (${by})` : ''}: {right ? 'the decision was right' : <b style={{ fontWeight: 600 }}>it should have been {outcomeText(d.label).toLowerCase()}</b>}. This counts toward the rule's record.
      </span>
    </div>
  );
}

function collectFeatures(e: unknown, out: Set<string>): void {
  if (!e || typeof e !== 'object') return;
  const x = e as { op?: string; name?: string; a?: unknown; b?: unknown; args?: unknown[] };
  if (x.op === 'feat' && x.name) out.add(x.name);
  if (x.a) collectFeatures(x.a, out);
  if (x.b) collectFeatures(x.b, out);
  x.args?.forEach(y => collectFeatures(y, out));
}

const PLACEHOLDER: Record<string, string> = {
  underreport: 'e.g. supplies imply far more sales than they reported',
  pre_chase: 'e.g. they wired the balance yesterday; the money is in transit',
  allocation: 'e.g. the remittance says this pays the March royalty only',
  routing_change: 'e.g. the owner never asked for this; it came from a look-alike address',
};

// "This was wrong": a person relabels the decision with one line of why; the
// evolution engine reads it as a labeled case.
function CorrectDecision({ d, a }: { d: Decision; a?: Activity }) {
  const me = useMe();
  const act = useAction();
  const asks = useRows('ask');
  const skills = useRows('skill');
  const [open, setOpen] = useState(false);
  const outcomes = ((DOMAINS as Record<string, { outcomes: readonly string[] }>)[d.domain]?.outcomes ?? []).filter(o => o !== d.outcome);
  const [choice, setChoice] = useState(outcomes[0] ?? '');
  const [reason, setReason] = useState('');
  const [since, setSince] = useState<bigint | null>(null);
  const corrections = asks.filter(x => x.kind === `correction:${d.domain}` && parseObj(x.evidence).decision === Number(d.id));
  const proposedAfter = since === null ? [] : skills.filter(s => s.domain === d.domain && s.status === 'proposed');
  const reply = useEngineReply(d.domain, since);
  void a;
  return (
    <div style={{ marginTop: 10 }}>
      {corrections.map(c => (
        <div key={c.id.toString()} className="quote-block" style={{ marginBottom: 8 }}>
          {c.reason}
          <div className="quote-by">
            {c.answeredBy.split(':')[1] ?? c.answeredBy} said it should have been “{answerWords(c.answer)}” ({day(c.answeredAt)})
          </div>
        </div>
      ))}
      {!open ? (
        <button className="btn small" onClick={() => setOpen(true)} disabled={!outcomes.length}>
          <MessageSquareWarning size={13} /> This was wrong
        </button>
      ) : (
        <form
          className="sheet sheet-pad"
          style={{ display: 'grid', gap: 8, background: 'var(--sheet-2)' }}
          onSubmit={e => {
            e.preventDefault();
            void act.run({ call: c => c.reducers.correctDecision({ decisionId: d.id, outcome: choice, reason }) }).then(r => {
              const row = r.rows[r.rows.length - 1];
              if (r.status === 'ok' && row) setSince(row.id);
            });
          }}
        >
          <div className="row" style={{ gap: 6 }}>
            <span className="label">It should have been</span>
            {outcomes.map(o => (
              <button type="button" key={o} className="btn small option" aria-pressed={choice === o} onClick={() => setChoice(o)}>
                {choice === o && <Check size={12} />}
                {outcomeText(o)}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Why, in one line (the team learns from this sentence)</span>
            <input className="input serif" style={{ fontStyle: 'italic' }} value={reason} onChange={e => setReason(e.target.value)} placeholder={PLACEHOLDER[d.domain] ?? 'what the seat missed'} />
          </label>
          <div className="row">
            <button className="btn primary small" type="submit" disabled={act.pending || !choice || !reason.trim()}>
              Record correction as {me.name || 'nobody'}
            </button>
            <button className="btn small quiet" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <Result r={act.result} pending={act.pending} />
          {act.result?.status === 'ok' && (
            <div className="muted" style={{ fontSize: 13 }}>
              {proposedAfter.length ? (
                <>
                  Proposed from corrections so far:{' '}
                  {proposedAfter.map(s => (
                    <button key={s.key} className="chip proposed" style={{ cursor: 'pointer' }} onClick={() => go('knowledge', s.domain)}>
                      {s.key}
                    </button>
                  ))}
                </>
              ) : reply ? (
                <span>
                  Evolution engine{' '}
                  <button className="btn small quiet" style={{ height: 22, padding: '0 6px' }} onClick={() => openWhy(reply.id)}>
                    #{reply.id.toString()}
                  </button>
                  : {reply.outcome === 'pass' ? '' : 'refused, '}
                  {String(parseObj(reply.params).summary ?? '')}
                </span>
              ) : (
                'Waiting for the evolution engine to read this correction…'
              )}
            </div>
          )}
        </form>
      )}
    </div>
  );
}

// The evolution engine's attempts are on the record (kind 'evolution'); show the
// first one on this domain after the correction.
function useEngineReply(domain: string, after: bigint | null): Activity | undefined {
  const activity = useRows('activity');
  return useMemo(() => {
    if (after === null) return undefined;
    return activity
      .filter(x => x.kind === 'evolution' && x.id > after && parseObj(x.params).domain === domain)
      .sort((x, y) => (x.id < y.id ? -1 : 1))[0];
  }, [activity, domain, after]);
}

function ContextBox({ context, hit, policyIds }: { context: Record<string, unknown>; hit: Set<string>; policyIds: string[] }) {
  const policyOf = usePolicyLookup();
  const facts = (context.facts ?? null) as Record<string, boolean> | null;
  const trusted = (context.trustedFields ?? null) as Record<string, boolean> | null;
  const mattered = new Set<string>();
  for (const id of policyIds) {
    const tpl = policyOf(id) ? template(policyOf(id)!) : null;
    if (tpl && (tpl.t === 'forbid_when' || tpl.t === 'require_fact') && hit.has(id)) mattered.add(tpl.fact);
  }
  const rest = { ...context };
  delete rest.facts;
  delete rest.trustedFields;
  delete rest.principalKind;
  const shown = ['amountCents', 'approvals', 'requestedBy'].filter(k => k in rest);
  if (!shown.length && !trusted && !facts) return null;
  return (
    <section className="why-section">
      <h3>What the policy check saw</h3>
      <div style={{ display: 'grid', gap: 10 }}>
        {shown.length > 0 && (
          <dl className="kv">
            {'amountCents' in rest && (
              <>
                <dt>amount</dt>
                <dd>
                  <Money cents={rest.amountCents as number} />
                </dd>
              </>
            )}
            {'approvals' in rest && (
              <>
                <dt>approvals so far</dt>
                <dd className="num">{String(rest.approvals)}</dd>
              </>
            )}
            {'requestedBy' in rest && (
              <>
                <dt>requested by</dt>
                <dd>
                  <ActorTag principal={String(rest.requestedBy)} />
                </dd>
              </>
            )}
          </dl>
        )}
        {trusted && (
          <div>
            <span className="label">Fields that must come from a trusted source</span>
            {Object.entries(trusted).map(([k, v]) => (
              <div key={k} className={`fact ${v ? 'on' : ''}`} style={{ marginTop: 4 }}>
                {v ? <ShieldCheck size={13} className="tick" /> : <ShieldAlert size={13} className="red" />}
                <span className="what">
                  {k.replace(/_/g, ' ')}: {v ? 'from a trusted source (bank, processor, ERP or callback desk)' : 'not from a trusted source'}
                </span>
              </div>
            ))}
          </div>
        )}
        {facts && (
          <div>
            <span className="label">Facts the kernel computed</span>
            <div className="facts" style={{ marginTop: 4 }}>
              {Object.entries(facts).map(([k, v]) => (
                <div key={k} className={`fact ${v ? 'on' : ''} ${mattered.has(k) ? 'mattered' : ''}`} title={factText(k)}>
                  <span className="dot" />
                  <span className="what">
                    <b style={{ fontWeight: 500 }}>{k.replace(/_/g, ' ')}</b>: {v ? 'true' : 'false'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Ref({ r }: { r: string }) {
  const [kind, ...rest] = r.split(':');
  const id = rest.join(':');
  const invoices = useRows('invoice');
  const receipts = useRows('receipt');
  const asks = useRows('ask');
  const obs = useRows('observation');
  const facts = useRows('fact');
  const skills = useRows('skill');
  const refunds = useRows('refund');
  const routing = useRows('routingRequest');
  const debits = useRows('debitInstruction');
  const decisions = useRows('decision');
  const work = useRows('workItem');
  const entities = useRows('entity');
  const policyOf = usePolicyLookup();
  useEffect(() => {
    if (kind === 'obs' && /^\d+$/.test(id)) charter.ensure('observation', BigInt(id));
    if (kind === 'fact' && /^\d+$/.test(id)) charter.ensure('fact', BigInt(id));
  }, [kind, id]);
  let body: React.ReactNode = <span className="faint">{r}</span>;
  if (kind === 'invoice') {
    const inv = invoices.find(i => i.id === id);
    if (inv)
      body = (
        <span>
          {inv.kind} invoice {inv.id}: <Money cents={inv.amountCents} />, <Money cents={inv.openCents} /> open, {inv.status}
        </span>
      );
  } else if (kind === 'receipt') {
    const rc = receipts.find(x => x.id === id);
    if (rc)
      body = (
        <span>
          receipt {rc.id} from {rc.payerName}: <Money cents={rc.amountCents} />, <Money cents={rc.unappliedCents} /> unapplied
        </span>
      );
  } else if (kind === 'ask') {
    const q = asks.find(x => x.id.toString() === id);
    if (q)
      body = (
        <span>
          question #{id} to the {q.toRole}: {q.question.slice(0, 140)}
          {q.question.length > 140 ? '…' : ''}
          {q.status === 'answered' && (
            <span className="quote">
              {' '}
              answered “{q.answer}”{q.reason ? `: ${q.reason}` : ''}
            </span>
          )}
        </span>
      );
  } else if (kind === 'obs') {
    const o = obs.find(x => x.id.toString() === id);
    if (o) {
      if (o.kind === 'email') {
        const p = parseObj(o.payload);
        body = (
          <div className="untrusted-box">
            <div className="row" style={{ gap: 6 }}>
              <span className="chip untrusted">untrusted email</span>
              <span>
                from {String(p.fromName ?? '')} &lt;{String(p.from ?? '')}&gt;: {String(p.subject ?? '')}
              </span>
            </div>
            <pre>{String(p.body ?? '')}</pre>
          </div>
        );
      } else
        body = (
          <span>
            {o.kind.replace(/_/g, ' ')} from {o.source} {o.trusted ? '(trusted)' : '(untrusted)'}, valid {day(o.validAt)}
          </span>
        );
    } else if (id === '0') body = <span className="faint">no source observation (raised by a person)</span>;
  } else if (kind === 'fact') {
    const f = facts.find(x => x.id.toString() === id);
    if (f)
      body = (
        <span>
          {f.attr.replace(/_/g, ' ')} for {f.subject}: <span className="muted">{shortValue(f.value)}</span> {f.trusted ? '' : '(untrusted)'}
        </span>
      );
  } else if (kind === 'skill') {
    const s = skills.find(x => x.key === id);
    if (s)
      body = (
        <span className="row" style={{ gap: 6 }}>
          skill {s.key} <StatusChip status={s.status} />
        </span>
      );
  } else if (kind === 'policy') {
    const p = policyOf(id.split('@')[0]);
    if (p)
      body = (
        <span className="row" style={{ gap: 6 }}>
          <PolicyChip p={p} /> {p.text}
        </span>
      );
  } else if (kind === 'refund') {
    const rf = refunds.find(x => x.id.toString() === id);
    if (rf)
      body = (
        <span>
          refund #{id}: <Money cents={rf.amountCents} /> to {rf.bankAccount}, {rf.status}
        </span>
      );
  } else if (kind === 'routing') {
    const rr = routing.find(x => x.id.toString() === id);
    if (rr)
      body = (
        <span>
          bank-change request #{id} for {rr.entityCode} to {rr.requestedAccount}: {rr.status}
        </span>
      );
  } else if (kind === 'debit') {
    const d = debits.find(x => x.id === id);
    if (d)
      body = (
        <span>
          debit {d.id}: <Money cents={d.amountCents} /> from {d.bankAccount}, {d.status}
        </span>
      );
  } else if (kind === 'decision') {
    const d = decisions.find(x => x.id.toString() === id);
    if (d)
      body = (
        <span>
          decision #{id} by {d.skillKey}: {outcomeText(d.outcome)} on {subjectLabel(d.subject)}
        </span>
      );
  } else if (kind === 'work') {
    const w = work.find(x => x.id.toString() === id);
    body = w ? (
      <span>
        work item #{id}: {w.kind.replace(/_/g, ' ')} for {subjectLabel(w.subject)}, {w.state.replace(/_/g, ' ')}
      </span>
    ) : (
      <span>work item #{id}</span>
    );
  } else if (kind === 'entity') body = <span>counterparty {id}{entities.find(e => e.code === id) ? `, ${entities.find(e => e.code === id)!.name}` : ''}</span>;
  else if (kind === 'contract') body = <span>contract terms {id}</span>;
  else if (kind === 'audit') body = <span>field audit {id.replace(':', ', week of ')}</span>;
  else if (kind === 'bank') body = <span>bank transaction {id}</span>;
  else if (kind === 'activity') body = <button className="btn small quiet" onClick={() => openWhy(BigInt(id))}>activity #{id}</button>;
  return (
    <div className="row" style={{ alignItems: 'baseline', flexWrap: 'nowrap', gap: 8, fontSize: 13 }}>
      <span className="faint mono" style={{ minWidth: 92, fontSize: 11 }}>
        {r.length > 22 ? `${r.slice(0, 21)}…` : r}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>{body}</div>
    </div>
  );
}

function shortValue(v: string): string {
  const o = parseLoose<Record<string, unknown> | null>(v, null);
  if (!o || typeof o !== 'object') return v.slice(0, 120);
  return Object.entries(o)
    .slice(0, 6)
    .map(([k, x]) => `${featureLabel(k)} ${typeof x === 'number' && /cents|card|cash|gross|amount/.test(k) ? money(x) : typeof x === 'object' ? '…' : String(x)}`)
    .join(', ');
}

function ChainBox({ a }: { a: Activity }) {
  const chain = useChainState();
  const r = chain.from === a.id || (chain.from === null && !chain.report?.tampered) ? chain.report : null;
  const [tampered, setTampered] = useState(false);
  return (
    <section className="why-section">
      <h3>On the chain</h3>
      <div className="hash-pair">
        <div className="hash">
          <small>previous row's hash</small>
          {a.prevHash}
        </div>
        <ArrowRight size={16} className="faint" />
        <div className="hash">
          <small>this row's hash</small>
          {a.hash}
        </div>
      </div>
      <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
        sha256(previous hash | canonical JSON of this record). Change one character anywhere and every check after it fails.
      </div>
      <div className="verify">
        <button
          className="btn small"
          disabled={chain.running}
          onClick={() => {
            setTampered(false);
            runVerify(undefined, a.id);
          }}
        >
          <ShieldCheck size={13} /> Verify chain
        </button>
        <button
          className="btn small quiet"
          disabled={chain.running}
          onClick={() => {
            setTampered(true);
            runVerify(a.id, a.id);
          }}
          title="Edits this row in your browser's copy only, then re-verifies"
        >
          <FlaskConical size={13} /> Try editing this row
        </button>
        {r && (
          <span className={`verify-out ${r.done ? (r.firstBreak ? 'bad' : 'ok') : ''}`}>
            {!r.done ? (
              `checking ${num(r.checked)} of ${num(r.total)}…`
            ) : r.firstBreak ? (
              <>
                <ShieldAlert size={14} /> {tampered && r.tampered ? 'Edited copy fails' : 'Breaks'} at #{r.firstBreak.id.toString()}: {r.firstBreak.why}
              </>
            ) : (
              <>
                <ShieldCheck size={14} /> {num(r.verified)} of {num(r.total)} rows verify{r.headMatches ? ', head matches' : r.headMatches === false ? ', head differs' : ''} ({r.ms} ms)
              </>
            )}
          </span>
        )}
      </div>
      {r?.done && r.anchored && (
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          <Lock size={11} /> anchored hash {r.anchored.hash.slice(0, 12)}… ({day(r.anchored.at)}) {r.anchored.found ? 'is on the chain' : 'was not found'}
        </div>
      )}
    </section>
  );
}
