// The orchestration score: one lane per seat and per person across business
// days. Seats act; when unsure they ask, and a line runs to whoever answered;
// the kernel's refusals are marked where they happened; knowledge changes run
// down the whole score because they change what everyone does next.
import { useMemo, useRef, useState, useEffect } from 'react';
import type { Activity, Ask } from '../module_bindings/types';
import { openWhy } from '../app/nav';
import { actor, askLabel, commandLabel, day, SEAT_LABEL, SEATS } from '../lib/format';
import { parseObj } from '../lib/json';
import { summarize } from '../lib/summary';
import { DOMAIN_SEAT } from '../lib/rules';
import { useRows } from '../stdb/store';

interface Lane {
  key: string;
  label: string;
  sub: string;
  kind: 'mail' | 'seat' | 'person' | 'system';
}

const LANE_H = 30;
const LABEL_W = 150;
const AXIS_H = 26;
const KNOWLEDGE = new Set(['propose_skill', 'propose_policy', 'activate_skill', 'activate_policy', 'hire_seat', 'close_period']);

function dayNum(iso: string): number {
  return Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);
}

function isoOf(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

function askSeat(kind: string): string {
  const [base, domain] = kind.split(':');
  if (base === 'reading_conflict') return 'mail';
  if (base === 'spot_check' || base === 'correction') return `seat:${DOMAIN_SEAT[domain] ?? 'cash_app'}`;
  const map: Record<string, string> = { audit: 'cash_app', callback: 'cash_app', allocation: 'cash_app', identify_payer: 'cash_app', unapplied_cash: 'cash_app', misapplied: 'cash_app', royalty_decrease: 'cash_app', unknown_report: 'cash_app', collections: 'collections', dispute: 'collections', refund_release: 'refunds', bill_exception: 'ap_clerk', payment_release: 'payments', finding: 'auditor' };
  const seat = map[base];
  return seat === 'auditor' ? 'auditor' : `seat:${seat ?? 'cash_app'}`;
}

export function Score() {
  const activity = useRows('activity');
  const asks = useRows('ask');
  const principals = useRows('principal');
  const seatStates = useRows('seatState');
  const work = useRows('workItem');
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1100);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(600, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const model = useMemo(() => {
    const dated = activity.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a.at));
    if (!dated.length) return null;
    // Start at the first business day after the founding records.
    const realStart = dated.filter(a => a.kind !== 'policy' && a.kind !== 'admin').map(a => dayNum(a.at));
    const start = Math.min(...(realStart.length ? realStart : dated.map(a => dayNum(a.at))));
    const end = Math.max(...dated.map(a => dayNum(a.at)), ...asks.filter(q => q.answeredAt).map(q => dayNum(q.answeredAt)));
    const lanes: Lane[] = [
      { key: 'world', label: 'Bank, ERP, processor', sub: 'trusted feeds', kind: 'system' },
      { key: 'mail', label: 'Mailroom', sub: 'untrusted mail', kind: 'mail' },
    ];
    for (const seat of SEATS) if (seatStates.some(s => s.seat === seat) || dated.some(a => a.principal === `seat:${seat}`)) lanes.push({ key: `seat:${seat}`, label: SEAT_LABEL[seat], sub: 'seat', kind: 'seat' });
    const people = principals.filter(p => p.role === 'controller' || p.role === 'consultant').sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'controller' ? -1 : 1));
    for (const p of people) lanes.push({ key: `${p.role}:${p.name}`, label: p.name, sub: p.role, kind: 'person' });
    lanes.push({ key: 'evolver', label: 'Evolution engine', sub: 'proposes only', kind: 'system' });
    if (principals.some(p => p.role === 'auditor')) lanes.push({ key: 'auditor', label: 'Internal auditor', sub: 'reports only', kind: 'system' });
    const index = new Map(lanes.map((l, i) => [l.key, i]));
    const laneOf = (principal: string): number | undefined => {
      if (principal === 'inbox' || principal === 'seat:mailroom') return index.get('mail');
      if (principal.startsWith('evolver:')) return index.get('evolver');
      if (principal.startsWith('auditor:')) return index.get('auditor');
      if (principal === 'erp' || principal === 'bank-feed' || principal === 'bank feed' || principal === 'processor' || principal === 'auto-settlement' || principal.startsWith('world:')) return index.get('world');
      const replay = /^replay of ([a-z_]+)@/.exec(principal);
      if (replay) return index.get(`seat:${DOMAIN_SEAT[replay[1]] ?? 'cash_app'}`);
      return index.get(principal);
    };
    const acts = new Map<string, { lane: number; day: number; n: number; last: Activity }>();
    const stops: { lane: number; day: number; a: Activity }[] = [];
    const knowledge: { lane: number; day: number; a: Activity }[] = [];
    const inspections: { lane: number; day: number; a: Activity }[] = [];
    const teach: { lane: number; day: number; a: Activity }[] = [];
    const attempts: { lane: number; day: number; a: Activity }[] = [];
    const askActivity = new Map<string, Activity>();
    for (const a of dated) {
      if (a.kind === 'ask') {
        const id = parseObj(a.params).ask;
        if (id !== undefined) askActivity.set(String(id), a);
        continue;
      }
      const d = dayNum(a.at);
      if (a.kind === 'evolution') {
        const lane = index.get('evolver');
        if (lane !== undefined) attempts.push({ lane, day: d, a });
        continue;
      }
      if (a.kind === 'reliability') {
        const rule = String(parseObj(a.params).rule ?? '');
        const lane = index.get(`seat:${DOMAIN_SEAT[rule.split('@')[0]] ?? ''}`);
        if (lane !== undefined) inspections.push({ lane, day: d, a });
        continue;
      }
      const lane = laneOf(a.principal);
      if (lane === undefined) continue;
      if (a.outcome === 'denied' || a.outcome === 'rejected') stops.push({ lane, day: d, a });
      else if (KNOWLEDGE.has(a.command)) knowledge.push({ lane, day: d, a });
      else if (a.command === 'answer_ask') {
        const p = parseObj(a.params);
        if (p.correction !== undefined || p.concern !== undefined || p.audit !== undefined) teach.push({ lane, day: d, a });
      } else {
        const k = `${lane}:${d}`;
        const cur = acts.get(k);
        if (cur) {
          cur.n++;
          if (a.id > cur.last.id) cur.last = a;
        } else acts.set(k, { lane, day: d, n: 1, last: a });
      }
    }
    const links: { from: number; to?: number; d1: number; d2?: number; q: Ask; act?: Activity }[] = [];
    for (const q of asks) {
      if (q.kind.startsWith('correction:')) continue;
      // Who asked is on the record now (raised_by); older rows fall back to the kind.
      const from = (q.raisedBy && q.raisedBy !== 'kernel' ? laneOf(q.raisedBy) : undefined) ?? index.get(askSeat(q.kind));
      if (from === undefined || !/^\d{4}/.test(q.createdAt)) continue;
      const to = q.answeredBy ? index.get(q.answeredBy) : undefined;
      links.push({ from, to, d1: dayNum(q.createdAt), d2: q.answeredAt ? dayNum(q.answeredAt) : undefined, q, act: askActivity.get(q.id.toString()) });
    }
    // Work handed over (work_item.from_seat), folded per day and pair of lanes.
    const hand = new Map<string, { from: number; to: number; day: number; n: number; kinds: Set<string> }>();
    for (const w of work) {
      if (!w.fromSeat || !/^\d{4}/.test(w.createdAt)) continue;
      const from = laneOf(w.fromSeat);
      const to = index.get(`seat:${w.seat}`);
      if (from === undefined || to === undefined || from === to) continue;
      const day = dayNum(w.createdAt);
      const k = `${from}:${to}:${day}`;
      const h = hand.get(k) ?? { from, to, day, n: 0, kinds: new Set<string>() };
      h.n++;
      h.kinds.add(w.kind.replace(/_/g, ' '));
      hand.set(k, h);
    }
    return { start, end, lanes, acts: [...acts.values()], stops, knowledge, inspections, teach, attempts, handoffs: [...hand.values()], links: links.slice(-700) };
  }, [activity, asks, principals, seatStates, work]);

  if (!model) return <div className="empty">Nothing has happened yet.</div>;
  const days = Math.max(1, model.end - model.start + 1);
  const plotW = width - LABEL_W - 12;
  const dayW = plotW / days;
  const x = (d: number) => LABEL_W + (d - model.start + 0.5) * dayW;
  const y = (lane: number) => AXIS_H + lane * LANE_H + LANE_H / 2;
  const height = AXIS_H + model.lanes.length * LANE_H + 8;
  const months: number[] = [];
  for (let d = model.start; d <= model.end; d++) if (isoOf(d).endsWith('-01') || d === model.start) months.push(d);
  const weeks: number[] = [];
  for (let d = model.start; d <= model.end; d++) if (new Date(d * 86_400_000).getUTCDay() === 1) weeks.push(d);
  const go = (a?: Activity) => a && openWhy(a.id);

  return (
    <div ref={wrap} className="sheet score" style={{ padding: '10px 6px 6px' }}>
      <div className="row score-legend" style={{ gap: 14, padding: '0 10px 6px', fontSize: 12 }}>
        <span>
          <svg width="10" height="12" aria-hidden>
            <rect x="3" y="2" width="4" height="10" rx="1" fill="var(--ink-3)" />
          </svg>{' '}
          seat acted (taller is more)
        </span>
        <span>
          <svg width="12" height="12" aria-hidden>
            <circle cx="6" cy="6" r="4" fill="var(--taro)" />
          </svg>{' '}
          asked a person, line to who answered
        </span>
        <span>
          <svg width="12" height="12" aria-hidden>
            <rect x="2" y="2" width="8" height="8" fill="var(--ink)" />
          </svg>{' '}
          a person taught the team
        </span>
        <span>
          <svg width="12" height="12" aria-hidden>
            <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="var(--red)" />
          </svg>{' '}
          the kernel refused
        </span>
        <span>
          <svg width="12" height="12" aria-hidden>
            <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="none" stroke="var(--taro)" strokeWidth="1.6" />
          </svg>{' '}
          knowledge changed
        </span>
        <span>
          <svg width="12" height="12" aria-hidden>
            <path d="M3 11 V2 L10 4.5 L3 7" fill="none" stroke="var(--ink-2)" strokeWidth="1.4" />
          </svg>{' '}
          inspection level changed
        </span>
        <span>
          <svg width="10" height="14" aria-hidden>
            <path d="M5 1 V11 M2 8 L5 12 L8 8" fill="none" stroke="var(--ink-3)" strokeWidth="1.4" />
          </svg>{' '}
          work handed over
        </span>
        <span>
          <svg width="12" height="12" aria-hidden>
            <circle cx="6" cy="6" r="4" fill="none" stroke="var(--ink-3)" strokeWidth="1.4" strokeDasharray="2 1.5" />
          </svg>{' '}
          engine attempt refused
        </span>
      </div>
      <svg width={width - 12} height={height} role="img" aria-label="Who did what, day by day">
        {/* lanes */}
        {model.lanes.map((l, i) => (
          <g key={l.key}>
            <rect x={0} y={AXIS_H + i * LANE_H} width={width - 12} height={LANE_H} fill={i % 2 ? 'transparent' : 'var(--sheet-2)'} />
            <text x={10} y={AXIS_H + i * LANE_H + 13} fontSize={12} fontWeight={600} fill="var(--ink)">
              {l.label}
            </text>
            <text x={10} y={AXIS_H + i * LANE_H + 25} fontSize={10} fill="var(--ink-3)">
              {l.sub}
            </text>
          </g>
        ))}
        {/* axis */}
        {weeks.map(d => (
          <line key={`w${d}`} x1={x(d) - dayW / 2} x2={x(d) - dayW / 2} y1={AXIS_H - 4} y2={height - 8} stroke="var(--rule)" strokeWidth={1} />
        ))}
        {months.map(d => (
          <text key={`m${d}`} x={x(d) - dayW / 2 + 3} y={14} fontSize={11} fill="var(--ink-2)">
            {day(isoOf(d))}
          </text>
        ))}
        {/* knowledge changes run down the score */}
        {model.knowledge.map(k => (
          <line key={`kl${k.a.id}`} x1={x(k.day)} x2={x(k.day)} y1={AXIS_H} y2={height - 8} stroke="var(--taro-line)" strokeDasharray="2 3" strokeWidth={1} />
        ))}
        <defs>
          <marker id="handoff-head" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--ink-3)" />
          </marker>
        </defs>
        {/* work handed over */}
        {model.handoffs.map(h => {
          const xx = x(h.day) - Math.min(3, dayW / 4);
          const y1 = y(h.from) + (h.to > h.from ? 6 : -6);
          const y2 = y(h.to) + (h.to > h.from ? -7 : 7);
          return (
            <line key={`h${h.from}:${h.to}:${h.day}`} x1={xx} x2={xx} y1={y1} y2={y2} stroke="var(--ink-3)" strokeOpacity={0.55} strokeWidth={Math.min(3.5, 1 + Math.log2(h.n))} markerEnd="url(#handoff-head)">
              <title>{`${h.n} ${h.n === 1 ? 'item' : 'items'} handed over on ${day(isoOf(h.day))}: ${[...h.kinds].join(', ')}`}</title>
            </line>
          );
        })}
        {/* ask links */}
        {model.links.map(l => {
          const x1 = x(l.d1);
          const y1 = y(l.from);
          if (l.to === undefined || l.d2 === undefined) {
            return (
              <circle key={`q${l.q.id}`} cx={x1} cy={y1} r={3.2} fill={l.q.status === 'open' ? 'var(--taro)' : 'transparent'} stroke="var(--taro)" strokeWidth={1.2} style={{ cursor: 'pointer' }} onClick={() => go(l.act)}>
                <title>{`${askLabel(l.q.kind)} #${l.q.id}, ${l.q.status} (${day(l.q.createdAt)})`}</title>
              </circle>
            );
          }
          const x2 = x(l.d2);
          const y2 = y(l.to);
          const mid = (y1 + y2) / 2;
          return (
            <g key={`q${l.q.id}`} style={{ cursor: 'pointer' }} onClick={() => go(l.act)}>
              <path d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`} fill="none" stroke="var(--taro)" strokeOpacity={0.45} strokeWidth={1.2} />
              <circle cx={x1} cy={y1} r={3.2} fill="var(--taro)" />
              <circle cx={x2} cy={y2} r={2.6} fill="var(--sheet)" stroke="var(--taro)" strokeWidth={1.2} />
              <title>{`${askLabel(l.q.kind)} #${l.q.id}: asked ${day(l.q.createdAt)}, ${actor(l.q.answeredBy).label} answered “${l.q.answer}” ${day(l.q.answeredAt)}`}</title>
            </g>
          );
        })}
        {/* seat activity */}
        {model.acts.map(m => {
          const h = Math.min(LANE_H - 8, 4 + 3 * Math.log2(1 + m.n));
          return (
            <rect key={`a${m.lane}:${m.day}`} x={x(m.day) - Math.min(2.5, dayW / 3)} y={y(m.lane) - h / 2} width={Math.max(2, Math.min(5, dayW * 0.6))} height={h} rx={1} fill="var(--ink-3)" style={{ cursor: 'pointer' }} onClick={() => go(m.last)}>
              <title>{`${m.n} ${m.n === 1 ? 'action' : 'actions'} on ${day(isoOf(m.day))}; latest: ${commandLabel(m.last.kind, m.last.command)} ${summarize(m.last)}`}</title>
            </rect>
          );
        })}
        {model.teach.map(t => (
          <rect key={`t${t.a.id}`} x={x(t.day) - 4} y={y(t.lane) - 4} width={8} height={8} fill="var(--ink)" style={{ cursor: 'pointer' }} onClick={() => go(t.a)}>
            <title>{`${actor(t.a.principal).label}: ${summarize(t.a)}`}</title>
          </rect>
        ))}
        {model.inspections.map(t => (
          <path key={`i${t.a.id}`} d={`M${x(t.day) - 3},${y(t.lane) + 6} V${y(t.lane) - 7} L${x(t.day) + 5},${y(t.lane) - 4.5} L${x(t.day) - 3},${y(t.lane) - 2}`} fill="none" stroke="var(--ink-2)" strokeWidth={1.4} style={{ cursor: 'pointer' }} onClick={() => go(t.a)}>
            <title>{summarize(t.a)}</title>
          </path>
        ))}
        {model.knowledge.map(k => (
          <path key={`k${k.a.id}`} d={`M${x(k.day)},${y(k.lane) - 6} L${x(k.day) + 6},${y(k.lane)} L${x(k.day)},${y(k.lane) + 6} L${x(k.day) - 6},${y(k.lane)} Z`} fill="var(--sheet)" stroke="var(--taro)" strokeWidth={1.6} style={{ cursor: 'pointer' }} onClick={() => go(k.a)}>
            <title>{`${commandLabel(k.a.kind, k.a.command)}: ${summarize(k.a)} (${actor(k.a.principal).label}, ${day(k.a.at)})`}</title>
          </path>
        ))}
        {model.attempts.map(t => (
          <circle key={`ev${t.a.id}`} cx={x(t.day) - 8} cy={y(t.lane)} r={4.5} fill={t.a.outcome === 'pass' ? 'var(--taro)' : 'var(--sheet)'} stroke={t.a.outcome === 'pass' ? 'var(--taro)' : 'var(--ink-3)'} strokeWidth={1.5} strokeDasharray={t.a.outcome === 'pass' ? undefined : '2 1.5'} style={{ cursor: 'pointer' }} onClick={() => go(t.a)}>
            <title>{`Evolution attempt (${t.a.outcome}): ${summarize(t.a)} (${day(t.a.at)})`}</title>
          </circle>
        ))}
        {model.stops.map(s => (
          <path key={`s${s.a.id}`} d={`M${x(s.day)},${y(s.lane) - 6} L${x(s.day) + 6},${y(s.lane)} L${x(s.day)},${y(s.lane) + 6} L${x(s.day) - 6},${y(s.lane)} Z`} fill="var(--red)" style={{ cursor: 'pointer' }} onClick={() => go(s.a)}>
            <title>{`${s.a.outcome}: ${commandLabel(s.a.kind, s.a.command)} by ${actor(s.a.principal).label} (${day(s.a.at)})`}</title>
          </path>
        ))}
      </svg>
    </div>
  );
}
