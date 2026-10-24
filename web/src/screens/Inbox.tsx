import { CornerDownRight, Mail, MessageSquarePlus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Ask, Entity, Store } from '../module_bindings/types';
import { Empty, FeatureTable, Result, SeverityChip, StatusChip } from '../components/ui';
import { toast } from '../components/Toast';
import { MisappliedText } from '../components/CashFacts';
import { openAsksFor, useMe } from '../app/data';
import { go } from '../app/nav';
import { actor, answerWords, askLabel, currencySymbol, day, daysBetween, money, prettyText, ROLE_LABEL } from '../lib/format';
import { parseArr, parseLoose, parseObj } from '../lib/json';
import { subjectLabel } from '../lib/lineage';
import { askDomain, domainOf, outcomeText, parseProgram, ruleText } from '../lib/rules';
import { useAction } from '../stdb/actions';
import { useRows } from '../stdb/store';
import { useConfig } from '../app/data';

export function Inbox() {
  const me = useMe();
  const asks = useRows('ask');
  const entities = useRows('entity');
  const stores = useRows('store');
  const open = useMemo(() => (me.isOutsider ? [] : openAsksFor(asks, me.role)), [asks, me]);
  const answered = useMemo(
    () =>
      asks
        .filter(a => a.status === 'answered' && a.reason)
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .slice(0, 12),
    [asks]
  );
  return (
    <div className="page-inner">
      <div className="page-head">
        <h1 className="page-title">Inbox</h1>
        <p className="page-sub">
          {me.isOutsider
            ? 'Outsiders have no inbox.'
            : me.isController
              ? `${me.name} is a controller and sees every open question.`
              : `Questions the seats sent to the ${ROLE_LABEL[me.role]?.toLowerCase() ?? me.role}.`}
        </p>
      </div>
      <div className="split">
        <div className="asks">
          {me.isOutsider ? (
            <div className="sheet">
              <Empty title="Nothing here for an outsider">
                Anyone can email the company. Mail lands in the AR inbox as untrusted data and is read by a quarantined reader.{' '}
                <button className="btn small option" style={{ marginLeft: 6 }} onClick={() => go('security')}>
                  <Mail size={13} /> Try it
                </button>
              </Empty>
            </div>
          ) : open.length === 0 ? (
            <div className="sheet">
              <Empty title="No open questions">When a seat is unsure it asks a person here, with its evidence and the closest precedent.</Empty>
            </div>
          ) : (
            open.map(a => <AskCard key={a.id.toString()} a={a} entities={entities} stores={stores} />)
          )}
        </div>
        <div className="stack">
          {!me.isOutsider && <Concern stores={stores} />}
          {!me.isOutsider && <OpenAudits />}
          <section className="sheet sheet-pad">
            <div className="section-head">
              <h2 className="section-title">What people told the team</h2>
              <span className="aside">the evolution engine learns from these</span>
            </div>
            {answered.length === 0 ? (
              <span className="faint">No answers with reasons yet.</span>
            ) : (
              <div className="answers-recent">
                {answered.map(a => (
                  <div key={a.id.toString()} className="answer-item">
                    <div className="quote-block">{a.reason}</div>
                    <div className="quote-by">
                      {a.answeredBy.split(':')[1] ?? a.answeredBy} {a.kind.startsWith('correction:') ? 'corrected it to' : 'answered'} “{answerWords(a.answer)}”, {subjectLabel(a.subject)}
                      {subjectLabel(a.subject).includes(day(a.answeredAt)) ? '' : `, ${day(a.answeredAt)}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function AskCard({ a, entities, stores }: { a: Ask; entities: Entity[]; stores: Store[] }) {
  const me = useMe();
  const cfg = useConfig();
  const act = useAction();
  const [reason, setReason] = useState('');
  const options = parseArr<string>(a.options);
  const evidence = parseObj(a.evidence);
  const features = (evidence.features ?? null) as Record<string, unknown> | null;
  const domain = askDomain(a.kind, evidence) ?? (features ? domainOf(features) : undefined);
  const used = new Set(Object.keys((evidence.used ?? {}) as Record<string, unknown>));
  const facts = (evidence.facts ?? null) as Record<string, boolean> | null;
  const solutions = Array.isArray(evidence.solutions) ? (evidence.solutions as string[][]) : null;
  const store = a.subject.startsWith('store:') ? stores.find(s => s.code === a.subject.split(':')[1]) : undefined;
  const late = cfg ? daysBetween(cfg.simDate, a.deadline) : 0;
  const mine = me.isController || a.toRole === me.role;
  const precedent = parsePrecedent(a.precedent);
  const answer = (o: string) =>
    void act.run({ call: c => c.reducers.answerAsk({ askId: a.id, answer: o, reason }) }).then(r => {
      const last = r.rows[r.rows.length - 1];
      if (r.status === 'ok') toast(`${r.as} answered #${a.id.toString()}: “${o}”`, last?.id);
    });
  return (
    <article className="sheet ask">
      <div className="ask-head">
        <span className="ask-kind">{askLabel(a.kind)}</span>
        {a.raisedBy && a.raisedBy !== 'kernel' && <span>from {a.raisedBy.startsWith('replay') ? a.raisedBy : actor(a.raisedBy).label}</span>}
        <span>{subjectLabel(a.subject)}</span>
        {store && <span>{store.name}</span>}
        <span>to the {ROLE_LABEL[a.toRole]?.toLowerCase() ?? a.toRole}</span>
        <span style={{ marginLeft: 'auto' }} className="num">
          #{a.id.toString()} asked {day(a.createdAt)}, {late < 0 ? `overdue since ${day(a.deadline)}` : `due ${day(a.deadline)}`}
        </span>
      </div>
      <div className="ask-q">{prettyText(a.question)}</div>
      {a.kind.startsWith('spot_check:') && <SpotCheck evidence={evidence} domain={domain} />}
      {(typeof evidence.referenced === 'string' && evidence.referenced) || (Array.isArray(evidence.remittance) && evidence.remittance.length) ? (
        <div className="row" style={{ gap: 14, fontSize: 13 }}>
          {typeof evidence.referenced === 'string' && evidence.referenced && (
            <span>
              The bank reference names <b style={{ fontWeight: 600 }}>{evidence.referenced}</b>
              {typeof features?.reference_gap_cents === 'number'
                ? features.reference_gap_cents < 0
                  ? `; the payment is ${money(-features.reference_gap_cents)} more than its open balance`
                  : features.reference_gap_cents > 0
                    ? `; the payment is ${money(features.reference_gap_cents)} short of its open balance`
                    : '; the payment is exactly its open balance'
                : ''}
              .
            </span>
          )}
          {Array.isArray(evidence.remittance) && evidence.remittance.length > 0 && (
            <span>
              The payer's remittance advice lists {evidence.remittance.length} invoice{evidence.remittance.length === 1 ? '' : 's'}
              {features?.remittance_consistent === true ? ' that add up to the payment' : features?.remittance_consistent === false ? ' that do not add up to the payment' : ''}.
            </span>
          )}
        </div>
      ) : null}
      {a.kind === 'misapplied' && <MisappliedText evidence={evidence} />}
      {a.kind === 'label_check' && <LabelCheckNote evidence={evidence} />}
      {a.kind === 'set_aside' && typeof evidence.work === 'number' && <SetAsideNote work={evidence.work} />}
      {a.kind === 'reading_conflict' && <ReadingConflict evidence={evidence} />}
      {a.kind === 'finding' && <FindingInfo subject={a.subject} />}
      {a.kind !== 'reading_conflict' && (
        <div className="ask-grid" style={features || facts || (solutions && a.kind !== 'allocation') ? undefined : { gridTemplateColumns: 'minmax(0,1fr)' }}>
          {(features || facts || solutions) && <div style={{ display: 'grid', gap: 8 }}>
            {features && <FeatureTable features={features} domain={domain} used={used} />}
            {solutions && a.kind !== 'allocation' && (
              <div className="features">
                <table>
                  <tbody>
                    {solutions.map((s, i) => (
                      <tr key={i}>
                        <td>set {i + 1}</td>
                        <td>{s.join(' + ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {facts && (
              <div className="features">
                <table>
                  <tbody>
                    {Object.entries(facts).map(([k, v]) => (
                      <tr key={k}>
                        <td>{k.replace(/_/g, ' ')}</td>
                        <td>{v ? 'yes' : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>}
          <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
            {typeof evidence.skill === 'string' && (
              <div className="muted" style={{ fontSize: 13 }}>
                Raised by{' '}
                <button className="chip active" style={{ cursor: 'pointer' }} onClick={() => go('knowledge', String(evidence.skill).split('@')[0])}>
                  {String(evidence.skill)}
                </button>
                {evidence.replay ? ' replaying past weeks after it went live' : ''}
                {typeof evidence.note === 'string' && evidence.note ? `: ${evidence.note}` : ''}
              </div>
            )}
            {typeof evidence.overpaid === 'number' && (
              <div className="muted" style={{ fontSize: 13 }}>
                Overpaid cash on this account: {money(evidence.overpaid)}
              </div>
            )}
            {/* set-aside work is not a judgement call: no precedent, no confidence */}
            {a.kind !== 'set_aside' && (
              <>
                <div className="precedent">
                  <div className="label">Last time</div>
                  {precedent ? (
                    <div style={{ fontSize: 13 }}>
                      <span className="quote">{precedent.reason ? `“${precedent.reason}”` : `“${precedent.answer}”`}</span>
                      <div className="quote-by">
                        answered “{precedent.answer}” on question #{precedent.id}, {day(precedent.on)}
                      </div>
                    </div>
                  ) : (
                    <div className="faint" style={{ fontSize: 13 }}>
                      no close precedent; this is new to the team
                    </div>
                  )}
                </div>
                <div className="confidence" title="How sure the seat was before asking">
                  seat's confidence
                  <span className="meter">
                    <i style={{ width: `${Math.round(a.confidence * 100)}%` }} />
                  </span>
                  <span className="num">{Math.round(a.confidence * 100)}%</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <form
        className="answer-row"
        onSubmit={e => {
          e.preventDefault();
        }}
      >
        <label className="field">
          <span>Your reason, in one line (the team learns from it)</span>
          <input className="input serif" style={{ fontStyle: 'italic' }} value={reason} onChange={e => setReason(e.target.value)} placeholder={a.kind === 'callback' ? 'e.g. Maya says she never sent it' : 'why you are answering this way'} />
        </label>
        {a.kind === 'allocation' ? (
          <AllocationOptions subject={a.subject} options={options} evidence={evidence} pending={act.pending} onAnswer={answer} />
        ) : (
          <div className="row">
            {options.map(o => (
              <button key={o} type="button" className="btn option" disabled={act.pending} onClick={() => answer(o)} title={`Answer “${o}” as ${me.name}`}>
                <CornerDownRight size={13} /> {a.kind === 'identify_payer' ? `${o} ${entities.find(e => e.code === o)?.name ?? ''}` : outcomeText(o)}
              </button>
            ))}
          </div>
        )}
        {!mine && <span className="faint" style={{ fontSize: 12 }}>This question is for the {a.toRole}; the kernel will refuse {me.name}.</span>}
        <Result r={act.result} pending={act.pending} />
      </form>
    </article>
  );
}

// Cash application: every answer is a set of invoices. Say where each set came
// from (the payer's remittance advice, the bank reference, the seat's own search)
// and what applying it would leave, so the person chooses money, not strings.
function AllocationOptions({ subject, options, evidence, pending, onAnswer }: { subject: string; options: string[]; evidence: Record<string, unknown>; pending: boolean; onAnswer: (o: string) => void }) {
  const invoices = useRows('invoice');
  const receipts = useRows('receipt');
  const features = (evidence.features ?? {}) as Record<string, unknown>;
  const receipt = receipts.find(r => `receipt:${r.id}` === subject);
  const payment = receipt ? Number(receipt.unappliedCents) : Number(features.receipt_amount ?? 0);
  const open = new Map(invoices.map(i => [i.id, Number(i.openCents)]));
  const remittance = Array.isArray(evidence.remittance) ? (evidence.remittance as string[]) : [];
  const referenced = typeof evidence.referenced === 'string' ? evidence.referenced : '';
  const solutions = Array.isArray(evidence.solutions) ? (evidence.solutions as string[][]) : [];
  const same = (x: string[], y: string[]) => x.length === y.length && [...x].sort().join('|') === [...y].sort().join('|');
  return (
    <div className="alloc-options">
      {options.map(o => {
        if (o === 'apply oldest first')
          return (
            <button key={o} type="button" className="btn option alloc-option" disabled={pending} onClick={() => onAnswer(o)} title={`Answer “${o}”`}>
              <span className="alloc-src">Contract order</span>
              <span className="alloc-ids" style={{ fontFamily: 'inherit' }}>oldest first, in the order the franchise agreement sets</span>
              <span className="alloc-sum">
                <span className="num">{money(payment)}</span>
                <small>uses the whole payment</small>
              </span>
            </button>
          );
        const ids = o.split(' + ');
        const sources: string[] = [];
        if (remittance.length && same(remittance, ids)) sources.push("Payer's remittance advice");
        if (referenced && o === referenced) sources.push('Bank reference');
        const k = solutions.findIndex(sol => same(sol, ids));
        if (k >= 0) sources.push(`Seat's search, set ${k + 1}`);
        const single = ids.length === 1 ? (open.get(ids[0]) ?? 0) : 0;
        const applied = ids.length === 1 ? Math.min(payment, single) : ids.reduce((sum, id) => sum + (open.get(id) ?? 0), 0);
        const left = payment - applied;
        const consequence =
          ids.length === 1 && single > payment ? `pays ${money(applied)} of its ${money(single)}` : left > 0 ? `leaves ${money(left)} unapplied` : left === 0 ? 'uses the whole payment' : `${money(-left)} more than the payment`;
        return (
          <button key={o} type="button" className="btn option alloc-option" disabled={pending} onClick={() => onAnswer(o)} title={`Answer “${o}”`}>
            <span className="alloc-src">{sources.join(', ') || 'Another set'}</span>
            <span className="alloc-ids">
              {ids.map(id => (
                <span key={id}>{id}</span>
              ))}
            </span>
            <span className="alloc-sum">
              <span className="num">{money(applied)}</span>
              <small>{consequence}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// A second look before a verdict counts against a rule with a clean record.
function LabelCheckNote({ evidence }: { evidence: Record<string, unknown> }) {
  const stats = useRows('ruleStat');
  const rule = String(evidence.rule ?? '');
  const stat = stats.find(x => x.key === rule);
  return (
    <div className="row" style={{ gap: 8, fontSize: 13 }}>
      <span>
        The seat decided <b style={{ fontWeight: 600 }}>{outcomeText(String(evidence.decided ?? ''))}</b>; your verdict was <b style={{ fontWeight: 600 }}>{outcomeText(String(evidence.verdict ?? ''))}</b>
        {typeof evidence.spotCheck === 'number' ? ` (spot check #${evidence.spotCheck})` : ''}.
      </span>
      {stat && (
        <span className="muted">
          {prettyText(rule)} is <StatusChip status={stat.state} /> {stat.checked} checked, {stat.errors} wrong. A slip is not counted against it; a verdict that stands is.
        </span>
      )}
    </div>
  );
}

// Work the desk set aside: the item and what it was doing when it failed.
function SetAsideNote({ work }: { work: number }) {
  const items = useRows('workItem');
  const w = items.find(x => x.id === BigInt(work));
  if (!w) return null;
  return (
    <div className="muted" style={{ fontSize: 13 }}>
      Work item #{work}: {w.kind.replace(/_/g, ' ')} for {subjectLabel(w.subject)}, {w.state.replace(/_/g, ' ')}. It ran in its own transaction, so nothing it started was kept.
    </div>
  );
}

// A spot check: which rule decided, and how hard it is being inspected.
function SpotCheck({ evidence, domain }: { evidence: Record<string, unknown>; domain?: string }) {
  const skills = useRows('skill');
  const stats = useRows('ruleStat');
  const skillKey = String(evidence.skill ?? '').split('+')[0];
  const skill = skills.find(s => s.key === skillKey);
  const rule = typeof evidence.rule === 'number' ? evidence.rule : -1;
  const stat = stats.find(x => x.key === evidence.stat);
  return (
    <div className="row" style={{ gap: 8, fontSize: 13 }}>
      <span>
        The seat decided <b style={{ fontWeight: 600 }}>{outcomeText(String(evidence.decided ?? ''))}</b> by {skillKey || 'its skill'}: {ruleText(parseProgram(skill?.program ?? ''), rule)}.
      </span>
      {stat && (
        <span className="muted">
          This rule is <StatusChip status={stat.state} /> {stat.checked} checked, {stat.errors} wrong; {Math.round(stat.sampleRate * 100)}% of its decisions come to a person{domain ? '' : ''}.
        </span>
      )}
    </div>
  );
}

// Two independent readers (different model families) read the same email and disagree on money.
function ReadingConflict({ evidence }: { evidence: Record<string, unknown> }) {
  const obs = useRows('observation');
  const cfg = useConfig();
  const a = (evidence.readingA ?? {}) as Record<string, unknown>;
  const b = (evidence.readingB ?? {}) as Record<string, unknown>;
  const diff = Array.isArray(evidence.diff) ? (evidence.diff as string[]) : [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => k !== 'reason');
  // Fields the kernel says matter for money (core diff names): stronger highlight.
  const FIELD: Record<string, string> = { invoices: 'invoice_refs', amount: 'amount', store: 'store_code', week: 'week_start', 'new account': 'new_account_last4', type: 'type', card_sales: 'card_sales', cash_sales: 'cash_sales', gross_sales: 'gross_sales' };
  const material = new Set(diff.map(d => FIELD[d.split(':')[0].trim()] ?? d.split(':')[0].trim()));
  const email = obs.find(o => o.id.toString() === String(evidence.observation ?? ''));
  const p = email ? parseObj(email.payload) : null;
  const show = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') || '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="features">
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 9px', fontSize: 12 }}>Field</th>
              <th style={{ textAlign: 'left', padding: '6px 9px', fontSize: 12 }}>Reading A, {cfg?.llmModel ?? 'maker'}</th>
              <th style={{ textAlign: 'left', padding: '6px 9px', fontSize: 12 }}>Reading B, {String(evidence.checker ?? 'checker')}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map(k => {
              const differs = JSON.stringify(a[k] ?? '') !== JSON.stringify(b[k] ?? '');
              return (
                <tr key={k} className={material.has(k) ? 'used' : ''} title={material.has(k) ? 'the readers disagree on a field that moves money' : differs ? 'worded differently; does not change what happens' : undefined}>
                  <td>{k.replace(/_/g, ' ')}</td>
                  <td style={{ textAlign: 'left', fontWeight: differs ? 600 : 400 }}>{show(a[k])}</td>
                  <td style={{ textAlign: 'left', fontWeight: differs ? 600 : 400 }}>{show(b[k])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {diff.length > 0 && <div className="muted" style={{ fontSize: 13 }}>They disagree on {diff.join('; ')}. Nothing moves until a person picks a reading.</div>}
      {p && (
        <details>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
            The email both of them read
          </summary>
          <div className="untrusted-box" style={{ marginTop: 6 }}>
            <div className="row" style={{ gap: 6 }}>
              <span className="chip untrusted">untrusted</span>
              <span>
                {String(p.fromName ?? '')} &lt;{String(p.from ?? '')}&gt;: {String(p.subject ?? '')}
              </span>
            </div>
            <pre>{String(p.body ?? '')}</pre>
          </div>
        </details>
      )}
    </div>
  );
}

function FindingInfo({ subject }: { subject: string }) {
  const findings = useRows('finding');
  const f = findings.find(x => `finding:${x.id.toString()}` === subject);
  if (!f) return null;
  return (
    <div className="row" style={{ gap: 8, fontSize: 13 }}>
      <SeverityChip severity={f.severity} />
      <span className="muted">
        {f.test.replace(/_/g, ' ')}, {f.period}, on {subjectLabel(f.subject)}
      </span>
    </div>
  );
}

function parsePrecedent(text: string): { id: string; on: string; answer: string; reason: string } | null {
  if (!text) return null;
  const m = /ask #(\d+) on (\S+): "([^"]*)"(?: because (.*))?/.exec(text);
  if (!m) return { id: '?', on: '', answer: text, reason: '' };
  return { id: m[1], on: m[2], answer: m[3], reason: m[4] ?? '' };
}

function Concern({ stores }: { stores: Store[] }) {
  const decisions = useRows('decision');
  const me = useMe();
  const act = useAction();
  const weeks = useMemo(() => {
    const out: { store: string; week: string; outcome: string; skill: string }[] = [];
    const seen = new Set<string>();
    for (const d of [...decisions].sort((a, b) => (a.id < b.id ? 1 : -1))) {
      if (d.domain !== 'underreport' || d.shadow) continue;
      if (seen.has(d.subject)) continue;
      seen.add(d.subject);
      const [, store, week] = d.subject.split(':');
      out.push({ store, week, outcome: d.outcome, skill: d.skillKey });
    }
    return out.sort((a, b) => (a.week === b.week ? a.store.localeCompare(b.store) : a.week < b.week ? 1 : -1));
  }, [decisions]);
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const chosen = weeks.find(w => `${w.store}:${w.week}` === pick) ?? weeks[0];
  return (
    <section className="sheet sheet-pad">
      <div className="section-head">
        <h2 className="section-title">Raise a concern</h2>
        <span className="aside">{me.isConsultant ? 'you know your stores' : 'for consultants and controllers'}</span>
      </div>
      {weeks.length === 0 ? (
        <span className="faint">No weekly sales reports have been judged yet.</span>
      ) : (
        <form
          style={{ display: 'grid', gap: 9 }}
          onSubmit={e => {
            e.preventDefault();
            if (!chosen) return;
            void act.run({ call: c => c.reducers.raiseConcern({ store: chosen.store, week: chosen.week, note }) });
          }}
        >
          <label className="field">
            <span>Store and week</span>
            <select className="select" value={chosen ? `${chosen.store}:${chosen.week}` : ''} onChange={e => setPick(e.target.value)}>
              {weeks.map(w => (
                <option key={`${w.store}:${w.week}`} value={`${w.store}:${w.week}`}>
                  {stores.find(s => s.code === w.store)?.name ?? w.store}, week of {day(w.week)}: {w.outcome.replace(/_/g, ' ')} by {w.skill.split('+')[0]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>What you noticed</span>
            <textarea className="textarea serif" style={{ fontStyle: 'italic' }} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. They bought supplies for far more drinks than they reported, and their cash share dropped while every other store held steady." />
          </label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={act.pending || !note.trim()}>
              <MessageSquarePlus size={14} /> Raise concern as {me.name}
            </button>
          </div>
          <Result r={act.result} pending={act.pending} />
        </form>
      )}
    </section>
  );
}

function OpenAudits() {
  const facts = useRows('fact');
  const stores = useRows('store');
  const act = useAction();
  const me = useMe();
  const [gross, setGross] = useState<Record<string, string>>({});
  const audits = useMemo(() => {
    const latest = new Map<string, { store: string; week: string; status: string; by?: string; owedCents?: number }>();
    for (const f of [...facts].filter(x => x.attr === 'audit').sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const v = parseLoose<{ store: string; week: string; status: string; by?: string; owedCents?: number } | null>(f.value, null);
      if (v) latest.set(`${v.store}:${v.week}`, v);
    }
    return [...latest.values()];
  }, [facts]);
  const open = audits.filter(a => a.status === 'open');
  const closed = audits.filter(a => a.status === 'closed');
  if (!audits.length) return null;
  return (
    <section className="sheet sheet-pad">
      <div className="section-head">
        <h2 className="section-title">Field audits</h2>
        <span className="aside">
          {open.length} open, {closed.length} closed
        </span>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {open.map(a => {
          const k = `${a.store}:${a.week}`;
          return (
            <form
              key={k}
              className="row"
              style={{ alignItems: 'flex-end' }}
              onSubmit={e => {
                e.preventDefault();
                const dollars = Number(String(gross[k] ?? '').replace(/[$,\s]/g, ''));
                if (!Number.isFinite(dollars) || dollars <= 0) return;
                void act.run({ call: c => c.reducers.closeAudit({ store: a.store, week: a.week, auditedGrossCents: BigInt(Math.round(dollars * 100)), note: `audited gross ${money(Math.round(dollars * 100))}` }) });
              }}
            >
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontWeight: 600 }}>{stores.find(s => s.code === a.store)?.name ?? a.store}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  week of {day(a.week)}, opened by {a.by?.split(':')[1] ?? a.by ?? 'the team'}
                </div>
              </div>
              <label className="field" style={{ width: 150 }}>
                <span>Audited gross sales</span>
                <input className="input num" inputMode="decimal" placeholder={`${currencySymbol()}15,200`} value={gross[k] ?? ''} onChange={e => setGross(g => ({ ...g, [k]: e.target.value }))} />
              </label>
              <button className="btn small" type="submit" disabled={act.pending} title={`Record the finding as ${me.name}`}>
                <Search size={13} /> Record finding
              </button>
            </form>
          );
        })}
        {closed.slice(-4).map(a => (
          <div key={`${a.store}:${a.week}`} className="muted" style={{ fontSize: 13 }}>
            {stores.find(s => s.code === a.store)?.name ?? a.store}, week of {day(a.week)}: closed{a.owedCents ? `, ${money(a.owedCents)} royalty under-billed` : ', report was right'}
          </div>
        ))}
        <Result r={act.result} pending={act.pending} />
      </div>
    </section>
  );
}
