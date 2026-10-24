// Month by month, per domain: how much a seat settles without a person, how often
// it is right when it does (only where the answer key knows the truth), and how
// many questions it still sends to people. Percentages share one 0-100% axis; the
// question counts get their own strip below on the same months (never a second
// y-scale on one plot). New skill versions are marked on the time axis.
import { Table2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { lower95, upper95 } from '@module/reliability';
import { DOMAIN_LABEL, DOMAIN_SEAT } from '../lib/rules';
import { num, SEAT_LABEL } from '../lib/format';

// The report also counts approvals people give for releases; those are not decisions a seat makes.
const LABEL: Record<string, string> = { ...DOMAIN_LABEL, payments: 'Releasing payments', refunds: 'Releasing refunds' };

export interface TrendCell {
  decisions: number;
  alone: number;
  aloneGraded: number;
  aloneRight: number;
  questions: number;
}
export interface TrendMonth {
  month: string; // YYYY-MM
  domains: Record<string, TrendCell>;
}
export interface VersionMark {
  key: string; // allocation@3
  domain: string;
  date: string; // YYYY-MM-DD
  how: 'went live' | 'created';
}

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m: string, long = false) => `${(long ? LONG : SHORT)[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const dayName = (d: string) => `${SHORT[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const pctText = (v: number) => `${Math.round(v * 100)}%`;

interface Point {
  i: number;
  v: number;
}
interface Series {
  share: (Point & { alone: number; decisions: number })[];
  acc: (Point & { right: number; graded: number; lo: number; hi: number })[];
}

function seriesOf(cells: (TrendCell | undefined)[]): Series {
  const share: Series['share'] = [];
  const acc: Series['acc'] = [];
  cells.forEach((c, i) => {
    if (!c) return;
    if (c.decisions > 0) share.push({ i, v: c.alone / c.decisions, alone: c.alone, decisions: c.decisions });
    if (c.aloneGraded > 0) {
      const errors = c.aloneGraded - c.aloneRight;
      // One-sided 95% bounds on the error rate, turned into a range for accuracy.
      acc.push({ i, v: c.aloneRight / c.aloneGraded, right: c.aloneRight, graded: c.aloneGraded, lo: 1 - upper95(errors, c.aloneGraded), hi: 1 - lower95(errors, c.aloneGraded) });
    }
  });
  return { share, acc };
}

// Consecutive runs of months, so a missing month breaks the line instead of being bridged.
function runs<T extends Point>(pts: T[]): T[][] {
  const out: T[][] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last[last.length - 1].i === p.i - 1) last.push(p);
    else out.push([p]);
  }
  return out;
}

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const step = v <= 20 ? 5 : v <= 50 ? 10 : v <= 200 ? 50 : 100;
  return Math.ceil(v / step) * step;
}

// Two labels that would overlap are spread apart around their middle; the caller draws leaders.
function spread(a: number, b: number, gap: number): [number, number] {
  if (Math.abs(a - b) >= gap) return [a, b];
  const mid = (a + b) / 2;
  return a <= b ? [mid - gap / 2, mid + gap / 2] : [mid + gap / 2, mid - gap / 2];
}

export function TrendSection({ trend, marks, marksFrom }: { trend: TrendMonth[]; marks: VersionMark[]; marksFrom: 'activity' | 'report' | 'created' }) {
  const months = useMemo(() => [...new Set(trend.map(t => t.month))].sort(), [trend]);
  const byMonth = useMemo(() => new Map(trend.map(t => [t.month, t.domains])), [trend]);
  const domains = useMemo(() => {
    const all = [...new Set(trend.flatMap(t => Object.keys(t.domains)))];
    const graded = (d: string) => trend.some(t => (t.domains[d]?.aloneGraded ?? 0) > 0);
    return all.sort((a, b) => Number(graded(b)) - Number(graded(a)) || a.localeCompare(b));
  }, [trend]);
  const panels: string[] = [];
  const quiet: string[] = [];
  for (const d of domains) {
    const cells = months.map(m => byMonth.get(m)?.[d]);
    const s = seriesOf(cells);
    const shares = s.share.map(p => p.v);
    const asked = cells.some(c => (c?.questions ?? 0) > 0);
    const moves = shares.length > 1 && Math.max(...shares) - Math.min(...shares) >= 0.05;
    // A line needs at least two months; one month of data reads better as a sentence.
    if (shares.length >= 2 && (s.acc.length || asked || moves)) panels.push(d);
    else quiet.push(d);
  }
  return (
    <div className="sheet sheet-pad trend">
      <div className="section-head">
        <h2 className="section-title">Month by month</h2>
        <span className="aside">how much each seat settles without a person, how often it is right when it does, and the questions it still sends to people</span>
      </div>
      <div className="trend-legend" aria-hidden>
        <span>
          <i className="key line alone" /> Settled alone
        </span>
        <span>
          <i className="key line right" /> Right when alone
        </span>
        <span>
          <i className="key wash right" /> 95% range for that month
        </span>
        <span>
          <i className="key bar" /> Questions to people
        </span>
        <span>
          <i className="key diamond" /> {marksFrom === 'created' ? 'New version created' : 'New version went live'}
        </span>
      </div>
      <p className="trend-note">
        Right when alone counts only decisions the answer key can grade (for cash, whether the money landed on the invoices the payer meant); the shaded range is wide when few were graded.{' '}
        {marksFrom === 'created'
          ? 'This report does not say when each version went live, so versions are marked on the day the evolution engine created them.'
          : marksFrom === 'activity'
            ? 'Versions are marked on the day a person put them into service, from the activity log.'
            : 'Versions are marked on the day they went live.'}
      </p>
      <div className="trend-panels">
        {panels.map(d => (
          <DomainPanel key={d} domain={d} months={months} cells={months.map(m => byMonth.get(m)?.[d])} marks={marks.filter(m => m.domain === d)} />
        ))}
      </div>
      {quiet.map(d => (
        <QuietLine key={d} domain={d} months={months} cells={months.map(m => byMonth.get(m)?.[d])} />
      ))}
    </div>
  );
}

// A domain with too little to plot (one month, or flat with nothing graded and no
// questions): one sentence with the same numbers instead of an empty chart.
function QuietLine({ domain, months, cells }: { domain: string; months: string[]; cells: (TrendCell | undefined)[] }) {
  const seen = cells.map((c, i) => ({ c, i })).filter((x): x is { c: TrendCell; i: number } => !!x.c && x.c.decisions > 0);
  const asked = cells.reduce((sum, c) => sum + (c?.questions ?? 0), 0);
  const label = <b>{LABEL[domain] ?? domain}</b>;
  const questions = `${num(asked)} question${asked === 1 ? '' : 's'} to people`;
  if (!seen.length)
    return asked ? (
      <p className="trend-quiet">
        {label}: no decisions of its own; {questions} over these months.
      </p>
    ) : null;
  const total = (k: keyof TrendCell) => seen.reduce((sum, x) => sum + x.c[k], 0);
  const graded = total('aloneGraded');
  const right = total('aloneRight');
  const gradedText = graded ? `; right when alone ${num(right)} of ${num(graded)} graded` : '; not graded: the answer key has no cases for it';
  if (seen.length === 1) {
    const { c, i } = seen[0];
    return (
      <p className="trend-quiet">
        {label}: {num(c.decisions)} decision{c.decisions === 1 ? '' : 's'} in {monthName(months[i])}, {num(c.alone)} settled alone ({pctText(c.alone / c.decisions)}), {questions}
        {gradedText}.
      </p>
    );
  }
  const counts = seen.map(x => x.c.decisions);
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  const alone = seen.every(x => x.c.alone === x.c.decisions);
  return (
    <p className="trend-quiet">
      {label}: {lo === hi ? num(lo) : `${num(lo)} to ${num(hi)}`} decisions a month from {monthName(months[seen[0].i])}
      {alone ? ', all settled alone' : `, ${pctText(total('alone') / total('decisions'))} settled alone`}, {asked ? questions : 'no questions to people'}
      {gradedText}.
    </p>
  );
}

function DomainPanel({ domain, months, cells, marks }: { domain: string; months: string[]; cells: (TrendCell | undefined)[]; marks: VersionMark[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(300, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);

  const s = useMemo(() => seriesOf(cells), [cells]);
  const n = months.length;
  const narrow = w < 560;
  const padL = 38;
  const padR = narrow ? 96 : 150;
  const band = (w - padL - padR) / Math.max(1, n);
  const xc = (i: number) => padL + (i + 0.5) * band;
  const xDate = (d: string) => {
    const i = months.indexOf(d.slice(0, 7));
    if (i < 0) return null;
    const dim = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).getUTCDate();
    return padL + (i + (Number(d.slice(8, 10)) - 1) / dim) * band;
  };

  // Version labels sit in a band above the plot; a label that would overlap the previous one takes the next row.
  const placed = useMemo(() => {
    const out: { m: VersionMark; x: number; row: number }[] = [];
    const ends: number[] = [];
    for (const m of [...marks].sort((a, b) => a.date.localeCompare(b.date))) {
      const x = xDate(m.date);
      if (x === null) continue;
      const width = 14 + m.key.length * 6.4;
      let row = 0;
      while (ends[row] !== undefined && ends[row] > x - 4) row++;
      ends[row] = x + width;
      out.push({ m, x, row });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, w, months.join()]);
  const rows = placed.length ? Math.max(...placed.map(p => p.row)) + 1 : 0;

  const top = 6 + rows * 15 + (rows ? 6 : 0);
  const plotH = narrow ? 130 : 160;
  const axisY = top + plotH;
  const y = (v: number) => top + (1 - v) * plotH;
  const stripTitleY = axisY + 40;
  const stripTop = stripTitleY + 8;
  const stripH = 48;
  const H = stripTop + stripH + 8;
  const qMax = niceMax(Math.max(0, ...cells.map(c => c?.questions ?? 0)));
  const yq = (v: number) => stripTop + stripH - (v / qMax) * stripH;
  const bw = Math.max(4, Math.min(24, band * 0.42));

  const line = (pts: Point[]) => pts.map((p, k) => `${k ? 'L' : 'M'}${xc(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const wash = (pts: Series['acc']) => `${pts.map((p, k) => `${k ? 'L' : 'M'}${xc(p.i).toFixed(1)},${y(p.hi).toFixed(1)}`).join(' ')} ${[...pts].reverse().map(p => `L${xc(p.i).toFixed(1)},${y(p.lo).toFixed(1)}`).join(' ')} Z`;
  const bar = (i: number, v: number) => {
    const x0 = xc(i) - bw / 2;
    const x1 = xc(i) + bw / 2;
    const yb = stripTop + stripH;
    const yt = yq(v);
    const r = Math.min(4, (yb - yt) / 2, bw / 2);
    return `M${x0},${yb} L${x0},${yt + r} Q${x0},${yt} ${x0 + r},${yt} L${x1 - r},${yt} Q${x1},${yt} ${x1},${yt + r} L${x1},${yb} Z`;
  };

  const lastShare = s.share[s.share.length - 1];
  const lastAcc = s.acc[s.acc.length - 1];
  const firstShare = s.share[0];
  const firstAcc = s.acc[0];
  const [endShareY, endAccY] = spread(lastShare ? y(lastShare.v) : -99, lastAcc ? y(lastAcc.v) : 999, 16);
  // Both series starting at the same value get one label.
  const sameStart = !!firstShare && !!firstAcc && s.share.length > 1 && firstShare.i === firstAcc.i && pctText(firstShare.v) === pctText(firstAcc.v);
  // A start value that sits on a labelled gridline (0, 25, 50, 75, 100%) is already read off the axis.
  const onGrid = (p?: Point) => !!p && Math.round(p.v * 100) % 25 === 0;
  const [startShareY, startAccY] = sameStart ? [y(firstShare!.v), 0] : spread(firstShare ? y(firstShare.v) : -99, firstAcc ? y(firstAcc.v) : 999, 15);
  const labelX = (p: Point) => xc(p.i) + 12;

  const pick = (clientX: number) => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    const i = Math.floor((clientX - box.left - padL) / band);
    setHover(i >= 0 && i < n ? i : null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setHover(h => Math.max(0, Math.min(n - 1, (h ?? (e.key === 'ArrowRight' ? -1 : n)) + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Escape') setHover(null);
  };
  const label = LABEL[domain] ?? domain;
  const seat = SEAT_LABEL[DOMAIN_SEAT[domain] ?? ''];
  const showEvery = band < 54 ? 2 : 1;

  return (
    <section className="trend-panel">
      <div className="trend-head">
        <h3>{label}</h3>
        {seat && <span className="aside">{seat} seat</span>}
        <button className="btn small" aria-pressed={table} onClick={() => setTable(t => !t)} title="Every number in this chart, as a table">
          <Table2 size={13} /> {table ? 'Chart' : 'Table'}
        </button>
      </div>
      <Headline months={months} s={s} cells={cells} />
      {table ? (
        <TrendTable months={months} cells={cells} s={s} marks={marks} />
      ) : (
        <div
          ref={wrap}
          className="trend-plot"
          tabIndex={0}
          role="group"
          aria-label={`${label}: month by month. Use the left and right arrow keys to read each month; the Table button lists every value.`}
          onPointerMove={e => pick(e.clientX)}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(h => h ?? n - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
        >
          <svg width={w} height={H} role="img" aria-hidden>
            {/* grid and axis: solid hairlines, recessive */}
            {[0, 0.25, 0.5, 0.75, 1].map(v => (
              <g key={v}>
                <line x1={padL} x2={w - padR + 8} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis' : 'grid'} />
                <text x={padL - 6} y={y(v) + 3.5} className="tick" textAnchor="end">
                  {v * 100}%
                </text>
              </g>
            ))}
            {months.map((m, i) =>
              i % showEvery === 0 ? (
                <text key={m} x={xc(i)} y={axisY + 15} className="tick" textAnchor="middle">
                  {i === 0 || m.endsWith('-01') ? monthName(m) : SHORT[Number(m.slice(5, 7)) - 1]}
                </text>
              ) : null
            )}

            {/* new versions: a hairline through the plot, a diamond and the key in the band above */}
            {placed.map(({ m, x, row }) => {
              const yy = 6 + row * 15 + 5;
              return (
                <g key={m.key} className="version">
                  <line x1={x} x2={x} y1={yy + 5} y2={axisY} className="version-rule" />
                  <rect x={x - 3.5} y={yy - 3.5} width={7} height={7} transform={`rotate(45 ${x} ${yy})`} className="version-mark" />
                  <text x={x + 8} y={yy + 3.5} className="version-text">
                    {m.key}
                  </text>
                </g>
              );
            })}

            {/* accuracy range, then the two lines, then markers with a surface ring */}
            {runs(s.acc).map((r, k) => (
              <path key={`w${k}`} d={wash(r)} className="wash right" />
            ))}
            {runs(s.share).map((r, k) => (
              <path key={`s${k}`} d={line(r)} className="series alone" />
            ))}
            {runs(s.acc).map((r, k) => (
              <path key={`a${k}`} d={line(r)} className="series right" />
            ))}
            {s.share.map(p => (
              <circle key={`sp${p.i}`} cx={xc(p.i)} cy={y(p.v)} r={hover === p.i ? 5 : 4} className="dot alone" />
            ))}
            {s.acc.map(p => (
              <circle key={`ap${p.i}`} cx={xc(p.i)} cy={y(p.v)} r={hover === p.i ? 5 : 4} className="dot right" />
            ))}

            {/* the first and last values, labelled; names ride the end labels */}
            {firstShare && s.share.length > 1 && band / 2 >= 34 && !onGrid(firstShare) && (
              <text x={xc(firstShare.i) - 9} y={startShareY + 4} className="value" textAnchor="end">
                {pctText(firstShare.v)}
              </text>
            )}
            {firstAcc && s.acc.length > 1 && band / 2 >= 34 && !sameStart && !onGrid(firstAcc) && (
              <text x={xc(firstAcc.i) - 9} y={startAccY + 4} className="value" textAnchor="end">
                {pctText(firstAcc.v)}
              </text>
            )}
            {lastShare && (
              <g>
                {Math.abs(endShareY - y(lastShare.v)) > 2 && <line x1={xc(lastShare.i) + 6} y1={y(lastShare.v)} x2={labelX(lastShare) - 2} y2={endShareY} className="leader" />}
                <text x={labelX(lastShare)} y={endShareY + 4} className="value">
                  <tspan className="strong">{pctText(lastShare.v)}</tspan>
                  {!narrow && <tspan dx={5}>settled alone</tspan>}
                </text>
              </g>
            )}
            {lastAcc && (
              <g>
                {Math.abs(endAccY - y(lastAcc.v)) > 2 && <line x1={xc(lastAcc.i) + 6} y1={y(lastAcc.v)} x2={labelX(lastAcc) - 2} y2={endAccY} className="leader" />}
                <text x={labelX(lastAcc)} y={endAccY + 4} className="value">
                  <tspan className="strong">{pctText(lastAcc.v)}</tspan>
                  {!narrow && <tspan dx={5}>right when alone</tspan>}
                </text>
              </g>
            )}

            {/* questions to people: their own strip and scale, same months */}
            <text x={padL} y={stripTitleY} className="strip-title">
              Questions to people
            </text>
            <line x1={padL} x2={w - padR + 8} y1={stripTop + stripH} y2={stripTop + stripH} className="axis" />
            <line x1={padL} x2={w - padR + 8} y1={stripTop} y2={stripTop} className="grid" />
            <text x={padL - 6} y={stripTop + 3.5} className="tick" textAnchor="end">
              {qMax}
            </text>
            <text x={padL - 6} y={stripTop + stripH + 3.5} className="tick" textAnchor="end">
              0
            </text>
            {cells.map((c, i) => (c && c.questions > 0 ? <path key={`q${i}`} d={bar(i, c.questions)} className={`qbar ${hover === i ? 'on' : ''}`} /> : null))}
            {cells.every(c => !c || c.questions === 0) && (
              <text x={padL + 8} y={stripTop + stripH - 8} className="tick">
                none
              </text>
            )}

            {/* crosshair */}
            {hover !== null && <line x1={xc(hover)} x2={xc(hover)} y1={top} y2={stripTop + stripH} className="crosshair" />}
          </svg>
          {hover !== null && <Tip i={hover} x={xc(hover)} w={w} top={top} months={months} cells={cells} s={s} marks={marks} />}
        </div>
      )}
    </section>
  );
}

function Headline({ months, s, cells }: { months: string[]; s: Series; cells: (TrendCell | undefined)[] }) {
  const a = s.share[0];
  const b = s.share[s.share.length - 1];
  const ga = s.acc[0];
  const gb = s.acc[s.acc.length - 1];
  const qa = cells.findIndex(c => !!c && c.decisions > 0);
  const qb = cells.length - 1 - [...cells].reverse().findIndex(c => !!c && c.decisions > 0);
  if (!a || !b) return null;
  return (
    <p className="trend-headline">
      {monthName(months[a.i])} to {monthName(months[b.i])}: settled alone <b>{pctText(a.v)}</b> → <b>{pctText(b.v)}</b>
      {ga && gb && (
        <>
          , right when alone <b>{pctText(ga.v)}</b> → <b>{pctText(gb.v)}</b>
        </>
      )}
      {qa >= 0 && qb >= 0 && (
        <>
          , questions to people <b>{num(cells[qa]?.questions ?? 0)}</b> → <b>{num(cells[qb]?.questions ?? 0)}</b> a month
        </>
      )}
      .
    </p>
  );
}

function Tip({ i, x, w, top, months, cells, s, marks }: { i: number; x: number; w: number; top: number; months: string[]; cells: (TrendCell | undefined)[]; s: Series; marks: VersionMark[] }) {
  const c = cells[i];
  const sh = s.share.find(p => p.i === i);
  const ac = s.acc.find(p => p.i === i);
  const live = marks.filter(m => m.date.startsWith(months[i]));
  const left = x + 14 + 230 > w ? x - 14 - 230 : x + 14;
  return (
    <div className="trend-tip" style={{ left, top }} role="status">
      <div className="tip-month">{monthName(months[i], true)}</div>
      {!c || c.decisions === 0 ? (
        <div className="tip-row muted">no decisions this month</div>
      ) : (
        <>
          <div className="tip-row">
            <i className="key line alone" />
            <b>{sh ? pctText(sh.v) : '–'}</b> settled alone
            <span className="tip-n">
              {num(c.alone)} of {num(c.decisions)}
            </span>
          </div>
          <div className="tip-row">
            <i className="key line right" />
            {ac ? (
              <>
                <b>{pctText(ac.v)}</b> right when alone
                <span className="tip-n">
                  {num(ac.right)} of {num(ac.graded)} graded; 95% range <span className="nowrap">{pctText(ac.lo)} to {pctText(ac.hi)}</span>
                </span>
              </>
            ) : (
              <span className="muted">none graded this month</span>
            )}
          </div>
        </>
      )}
      <div className="tip-row">
        <i className="key bar" />
        <b>{num(c?.questions ?? 0)}</b> questions to people
      </div>
      {live.map(m => (
        <div key={m.key} className="tip-row">
          <i className="key diamond" />
          <b>{m.key}</b> {m.how} {dayName(m.date)}
        </div>
      ))}
    </div>
  );
}

function TrendTable({ months, cells, s, marks }: { months: string[]; cells: (TrendCell | undefined)[]; s: Series; marks: VersionMark[] }) {
  return (
    <table className="table compact trend-table">
      <thead>
        <tr>
          <th>Month</th>
          <th className="n">Decisions</th>
          <th className="n">Settled alone</th>
          <th className="n">Graded</th>
          <th className="n">Right when alone</th>
          <th className="n">95% range</th>
          <th className="n">Questions</th>
          <th>New versions</th>
        </tr>
      </thead>
      <tbody>
        {months.map((m, i) => {
          const c = cells[i];
          const sh = s.share.find(p => p.i === i);
          const ac = s.acc.find(p => p.i === i);
          const live = marks.filter(x => x.date.startsWith(m));
          return (
            <tr key={m}>
              <td>{monthName(m)}</td>
              <td className="n">{c ? num(c.decisions) : '–'}</td>
              <td className="n">{sh ? `${pctText(sh.v)} (${num(sh.alone)})` : '–'}</td>
              <td className="n">{c ? num(c.aloneGraded) : '–'}</td>
              <td className="n">{ac ? `${pctText(ac.v)} (${num(ac.right)})` : '–'}</td>
              <td className="n">{ac ? `${pctText(ac.lo)}–${pctText(ac.hi)}` : ''}</td>
              <td className="n">{c ? num(c.questions) : '–'}</td>
              <td>{live.map(x => `${x.key} ${x.how} ${dayName(x.date)}`).join('; ')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
