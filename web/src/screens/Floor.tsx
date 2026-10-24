import { Banknote, ClipboardCheck, Coins, Landmark, Play, ReceiptText, UserPlus } from 'lucide-react';
import { useMemo } from 'react';
import type { Activity, Policy, Principal, SeatState, Skill, WorkItem } from '../module_bindings/types';
import { Feed } from '../components/Feed';
import { PolicyChip, Result } from '../components/ui';
import { useConfig, useMe } from '../app/data';
import { go, setSub, useNav } from '../app/nav';
import { Score } from './Score';
import { ACTION_LABEL, day, plural, ROLE_LABEL, SEAT_DESK, SEAT_LABEL, SEATS } from '../lib/format';
import { activePolicies, roleView, template, templateAction } from '../lib/policies';
import { DOMAIN_SEAT } from '../lib/rules';
import { useAction } from '../stdb/actions';
import { useRows } from '../stdb/store';

const SEAT_ICON = { cash_app: ReceiptText, collections: Coins, refunds: Banknote, ap_clerk: ClipboardCheck, payments: Landmark } as const;

const NEVER_SHORT: Record<string, string> = {
  endorse_routing_change: 'confirm bank changes',
  activate_policy: 'ratify policies',
  write_off: 'write off balances',
  activate_skill: 'put skills into service',
  close_period: 'close the books',
};

// Which seat raises which kind of question (asks carry no seat column).
const ASK_SEAT: Record<string, string> = {
  audit: 'cash_app',
  callback: 'cash_app',
  allocation: 'cash_app',
  identify_payer: 'cash_app',
  unapplied_cash: 'cash_app',
  misapplied: 'cash_app',
  royalty_decrease: 'cash_app',
  unknown_report: 'cash_app',
  collections: 'collections',
  dispute: 'collections',
  refund_release: 'refunds',
  bill_exception: 'ap_clerk',
  payment_release: 'payments',
  reading_conflict: 'cash_app',
};

function askSeat(kind: string): string | undefined {
  const [base, domain] = kind.split(':');
  if (base === 'spot_check' && domain) return domain === 'pre_chase' ? 'collections' : domain === 'bill_match' ? 'ap_clerk' : 'cash_app';
  return ASK_SEAT[base];
}

interface Tally {
  committed: number;
  stopped: number;
  asked: number;
  last?: Activity;
}

function FloorTabs({ current }: { current: 'team' | 'score' }) {
  return (
    <div className="subtabs" role="tablist" style={{ marginBottom: 2 }}>
      <button className="subtab" role="tab" aria-selected={current === 'team'} onClick={() => setSub('')}>
        Team
      </button>
      <button className="subtab" role="tab" aria-selected={current === 'score'} onClick={() => setSub('score')}>
        Score
      </button>
    </div>
  );
}

export function Floor() {
  const nav = useNav();
  const policies = useRows('policy');
  const seatStates = useRows('seatState');
  const activity = useRows('activity');
  const asks = useRows('ask');
  const work = useRows('workItem');
  const skills = useRows('skill');
  const principals = useRows('principal');
  const stores = useRows('store');
  const cfg = useConfig();

  const tallies = useMemo(() => {
    const t = new Map<string, Tally>();
    const get = (k: string) => t.get(k) ?? (t.set(k, { committed: 0, stopped: 0, asked: 0 }), t.get(k)!);
    for (const a of activity) {
      const x = get(a.principal);
      if (a.outcome === 'denied' || a.outcome === 'rejected') x.stopped++;
      else if (a.outcome === 'committed') x.committed++;
      if (!x.last || a.id > x.last.id) x.last = a;
    }
    for (const a of asks) {
      if (a.kind.startsWith('correction:')) continue;
      // raised_by names the asker; older rows fall back to the kind.
      const by = a.raisedBy && a.raisedBy.startsWith('seat:') ? a.raisedBy.slice(5) : askSeat(a.kind);
      if (by) get(`seat:${by}`).asked++;
    }
    return t;
  }, [activity, asks]);

  const people = useMemo(() => {
    const humans = principals.filter(p => p.role === 'controller' || p.role === 'consultant');
    const names = new Set(humans.map(p => p.name));
    const extra = [...new Set(stores.map(s => s.consultant).filter(Boolean))].filter(n => !names.has(n));
    return { humans: [...humans].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'controller' ? -1 : 1)), unbound: extra };
  }, [principals, stores]);

  if (nav.sub === 'score')
    return (
      <div className="page-inner">
        <FloorTabs current="score" />
        <Score />
      </div>
    );
  return (
    <div className="page-inner">
      <div className="split">
        <div className="stack">
          <FloorTabs current="team" />
          <section aria-label="Seats">
            <div className="section-head">
              <h2 className="section-title">Seats</h2>
              <span className="muted">code that decides with the team's skills and acts only through the kernel</span>
            </div>
            {(['receivables', 'payables'] as const).map(desk => {
              // Payables seats appear only where that pack runs; refunds is always offered for hire.
              const seats = SEATS.filter(seat => SEAT_DESK[seat] === desk && (seat === 'refunds' || seatStates.some(s => s.seat === seat)));
              if (!seats.length) return null;
              const both = SEATS.some(seat => SEAT_DESK[seat] === 'payables' && seatStates.some(s => s.seat === seat));
              return (
                <div key={desk} style={{ marginBottom: 12 }}>
                  {both && <div className="label" style={{ margin: '0 0 6px' }}>{desk === 'receivables' ? 'Receivables' : 'Payables'}</div>}
                  <div className="seats">
                    {seats.map(seat => (
                      <SeatCard key={seat} seat={seat} state={seatStates.find(s => s.seat === seat)} policies={policies} tally={tallies.get(`seat:${seat}`)} work={work} skills={skills} />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
          <RunBar lastRun={seatStates.map(s => s.lastRunAt).sort().pop()} simDate={cfg?.simDate} />
          <section aria-label="People">
            <div className="section-head">
              <h2 className="section-title">People</h2>
              <span className="muted">bound by the same kernel; only they can ratify, release and confirm</span>
            </div>
            <div className="people">
              {people.humans.map(p => (
                <PersonCard key={p.identity.toHexString()} p={p} policies={policies} tally={tallies.get(`${p.role}:${p.name}`)} openAsks={asks.filter(a => a.status === 'open' && (p.role === 'controller' || a.toRole === p.role)).length} />
              ))}
              {people.unbound.map(n => (
                <div key={n} className="sheet person offline">
                  <div className="person-head">
                    <span className="avatar lg consultant">{n.charAt(0)}</span>
                    <div>
                      <div className="person-name">{n}</div>
                      <div className="person-role">Field consultant, not signed in</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
        <Feed />
      </div>
    </div>
  );
}

function seatSummary(state: SeatState | undefined, seat: string): string {
  if (!state?.lastSummary) return '';
  const parts = state.lastSummary.split(' | ');
  const mine = parts.find(p => p.startsWith(`${seat} `));
  const triage = seat === 'cash_app' ? parts.find(p => p.startsWith('triage ')) : undefined;
  const text = mine ? mine.slice(seat.length + 1) : state.lastSummary.startsWith('hired') ? state.lastSummary : '';
  return [triage ? `read ${triage.slice(7)} emails` : '', text].filter(Boolean).join('; ');
}

function SeatCard({ seat, state, policies, tally, work, skills }: { seat: (typeof SEATS)[number]; state?: SeatState; policies: Policy[]; tally?: Tally; work: WorkItem[]; skills: Skill[] }) {
  const me = useMe();
  const hire = useAction();
  const view = useMemo(() => roleView(policies, seat, true), [policies, seat]);
  const hired = state?.status === 'active';
  const Icon = SEAT_ICON[seat];
  const open = work.filter(w => w.seat === seat && w.state === 'open').length;
  const waiting = work.filter(w => w.seat === seat && w.state === 'waiting').length;
  const uses = skills.filter(s => DOMAIN_SEAT[s.domain] === seat && (s.status === 'active' || s.status === 'canary'));
  // The refunds seat only prepares; its work leaves the building under the release rules.
  const downstream = useMemo(() => {
    const action = seat === 'refunds' ? 'issue_refund' : seat === 'payments' ? 'release_payment' : '';
    return action ? activePolicies(policies).filter(p => templateAction(template(p)) === action) : [];
  }, [policies, seat]);
  const learned = [...view.boundBy, ...downstream].filter(p => p.policyId.startsWith('P-'));
  return (
    <article className={`sheet seat ${hired ? '' : 'unhired'}`}>
      <div className="seat-head">
        <span className="seat-icon" aria-hidden>
          <Icon size={16} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="seat-name">{SEAT_LABEL[seat]}</div>
          <div className="seat-status">{hired ? (state && state.runs > 0 ? `${plural(state.runs, 'run')}, last ${day(state.lastRunAt)}` : 'hired, not run yet') : 'not hired'}</div>
        </div>
      </div>
      {!hired ? (
        <>
          <div className="seat-block">
            <span className="muted" style={{ fontSize: 13 }}>
              Starts with every skill and policy the team has learned so far. Prepares refunds of overpaid cash to the account on file; someone else releases them.
            </span>
          </div>
          <div className="seat-block">
            <button className="btn primary" disabled={hire.pending} onClick={() => void hire.run({ call: c => c.reducers.hireSeat({ seat }) })}>
              <UserPlus size={14} /> Hire {SEAT_LABEL[seat].toLowerCase()} seat
            </button>
            <Result r={hire.result} pending={hire.pending} idle={me.isController ? null : <span className="faint" style={{ fontSize: 12 }}>A controller hires seats; try it as {me.name || 'anyone'} to see the kernel say no.</span>} />
          </div>
        </>
      ) : (
        <>
          <div className="seat-block">
            <span className="label">May</span>
            <div className="chips">
              {view.may.map(a => (
                <span key={a} className="chip action">
                  {(ACTION_LABEL[a] ?? a).toLowerCase()}
                </span>
              ))}
              {!view.may.length && <span className="faint">nothing</span>}
            </div>
          </div>
          <div className="seat-block">
            <span className="label">Bound by</span>
            <div className="chips">
              {view.boundBy.map(p => (
                <PolicyChip key={p.key} p={p} />
              ))}
              {downstream.map(p => (
                <PolicyChip key={p.key} p={p} />
              ))}
              {!view.boundBy.length && !downstream.length && <span className="faint" style={{ fontSize: 12 }}>no restrictions on its own actions</span>}
            </div>
            {downstream.length > 0 && (
              <span className="faint" style={{ fontSize: 12 }}>
                {seat === 'payments' ? 'its payments are released only under these' : 'its refunds are released only under these'}
              </span>
            )}
            {learned.map(p => (
              <span key={p.key} className="muted" style={{ fontSize: 12 }}>
                {p.policyId}: {p.text}
              </span>
            ))}
          </div>
          <div className="seat-block">
            <span className="label">Never</span>
            <span className="muted" style={{ fontSize: 12 }}>
              {view.never.map(p => (p.policyId ? `${NEVER_SHORT[JSON.parse(p.template).action] ?? p.text} (${p.policyId})` : '')).join(', ')}
            </span>
          </div>
          <div className="seat-block">
            <span className="label">Decides with</span>
            <div className="chips">
              {uses.length ? (
                uses.map(s => (
                  <button key={s.key} className={`chip ${s.status === 'canary' ? 'canary' : 'active'}`} style={{ cursor: 'pointer' }} onClick={() => go('knowledge', s.domain)} title="See how this skill was learned">
                    {s.key}
                    {s.status === 'canary' ? ' canary' : ''}
                  </button>
                ))
              ) : (
                <span className="faint" style={{ fontSize: 12 }}>no skill of its own: the team's policies decide what it may do</span>
              )}
            </div>
          </div>
          <div className="record">
            <div>
              <b>{tally?.committed ?? 0}</b>
              <span>actions</span>
            </div>
            <div>
              <b className={tally?.stopped ? 'red' : ''}>{tally?.stopped ?? 0}</b>
              <span>stopped</span>
            </div>
            <div>
              <b>{tally?.asked ?? 0}</b>
              <span>questions</span>
            </div>
          </div>
          {(open > 0 || waiting > 0 || seatSummary(state, seat)) && (
            <div className="lastrun">
              {seatSummary(state, seat) && <div>Last run: {seatSummary(state, seat)}</div>}
              {(open > 0 || waiting > 0) && (
                <div>
                  {open} open, {waiting} waiting on a person
                </div>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function RunBar({ lastRun, simDate }: { lastRun?: string; simDate?: string }) {
  const run = useAction();
  const me = useMe();
  return (
    <div className="sheet runbar">
      <button
        className="btn primary"
        disabled={run.pending}
        onClick={() =>
          void run.run({
            call: c => c.procedures.runSeats({}),
            match: r => r.principal.startsWith('seat:') || r.principal === 'kernel',
            wait: 1500,
          })
        }
      >
        <Play size={14} /> Run seats
      </button>
      <span className="muted" style={{ fontSize: 13, flex: 1, minWidth: 200 }}>
        {run.pending ? 'Reading mail, applying cash, chasing balances…' : `Seats read new mail, apply cash, chase balances and prepare refunds for ${simDate ? day(simDate) : 'today'}.${lastRun ? ` Last run ${day(lastRun)}.` : ''}`}
      </span>
      {(run.result || run.pending) && (
        <div style={{ flexBasis: '100%' }}>
          <Result r={run.result && run.result.status === 'ok' ? { ...run.result, message: humanRun(String(run.result.value ?? '')), rows: [] } : run.result} pending={run.pending} />
        </div>
      )}
      {!me.isController && !run.result && <span className="faint" style={{ fontSize: 12 }}>Controllers run the seats.</span>}
    </div>
  );
}

function humanRun(summary: string): string {
  if (!summary) return 'Seats ran.';
  return summary
    .split(' | ')
    .map(part => {
      const [seat, ...rest] = part.split(' ');
      const label = seat === 'triage' ? 'Inbox' : SEAT_LABEL[seat] ?? seat;
      const text = rest.join(' ');
      return `${label}: ${seat === 'triage' ? `${text} emails read` : text}`;
    })
    .join('. ');
}

function PersonCard({ p, policies, tally, openAsks }: { p: Principal; policies: Policy[]; tally?: Tally; openAsks: number }) {
  const view = useMemo(() => roleView(policies, p.role, false), [policies, p.role]);
  const may = view.may.map(a => (ACTION_LABEL[a] ?? a).toLowerCase());
  return (
    <article className="sheet person">
      <div className="person-head">
        <span className={`avatar lg ${p.role}`}>{p.name.charAt(0)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="person-name">{p.name}</div>
          <div className="person-role">{ROLE_LABEL[p.role] ?? p.role}</div>
        </div>
      </div>
      <div className="waiting">
        {openAsks ? (
          <button className="btn small option" onClick={() => go('inbox')}>
            {plural(openAsks, 'question')} waiting
          </button>
        ) : (
          <span className="faint">nothing waiting</span>
        )}
      </div>
      <div className="seat-block">
        <span className="label">May</span>
        <span className="muted" style={{ fontSize: 12 }}>
          {may.slice(0, 6).join(', ')}
          {may.length > 6 ? `, and ${may.length - 6} more` : ''}
        </span>
      </div>
      {view.boundBy.length > 0 && (
        <div className="seat-block">
          <span className="label">Bound by</span>
          <div className="chips">
            {view.boundBy.map(x => (
              <PolicyChip key={x.key} p={x} />
            ))}
          </div>
        </div>
      )}
      <div className="faint" style={{ fontSize: 12 }}>
        {tally?.last ? `Last: ${(ACTION_LABEL[tally.last.command] ?? tally.last.command).toLowerCase()}, ${day(tally.last.at)}` : 'No actions yet'}
        {tally && tally.stopped > 0 ? <span className="red">, {tally.stopped} stopped</span> : null}
      </div>
    </article>
  );
}
