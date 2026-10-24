// Real bank reconciliation (BenchRec, tools/benchrec): the bank desk learned its
// skill from the institution's reconciliation history, month by month, and is
// scored once on the benchmark's locked eval split, next to its day-0 skill,
// rules written by hand, and the matcher shipped with the dataset. Two measures,
// two scales, never one plot: share matched as bars from zero, precision as a
// dot on a 99-100% track with the floor marked.
import { Check } from 'lucide-react';
import { upper95 } from '@module/reliability';
import { num } from '../lib/format';
import { exprText, outcomeText, type Expr } from '../lib/rules';

interface Desk {
  rules: { rule: number; decide: string; note: string; train: { n: number; wrong: number; upper95: number; lower95?: number; state?: string; actsAlone: boolean } }[];
  eval: { bankLines: number; matched: number; correct: number; precision: number | null; matchRate: number; clearsFloor?: boolean };
}

export interface BenchRecResult {
  dataset?: string;
  floor: number;
  autonomyFrom?: string; // rules earn autonomy on the train months after this one
  months: { month: string; lines: number; alone: number; wrong: number; version: number }[];
  versions: { version: number; from: string; origin: string; lessonsHandled: number; lessons: number; tookOver: number; candidates: number; passed: number; rules: { when: Expr; decide: string; note: string }[] }[];
  day0: Desk;
  learned: Desk;
  handwritten: Desk;
  baseline?: { name: string; matched: number; correct: number; precision: number; matchRate: number } | null;
}

const TRACK_LO = 0.99;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const pct2 = (x: number) => `${(x * 100).toFixed(2)}%`;
// Small error rates need more digits than large ones to say anything.
const errPct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 3 : 1)}%`;

export function isBenchRec(v: unknown): v is BenchRecResult {
  const o = v as BenchRecResult;
  return !!o && typeof o === 'object' && typeof o.floor === 'number' && Array.isArray(o.months) && !!o.learned?.eval && typeof o.learned.eval.bankLines === 'number';
}

function Tick({ yes, no = 'no' }: { yes: boolean; no?: string }) {
  return yes ? (
    <span className="tick" style={{ fontWeight: 600 }}>
      <Check size={13} style={{ verticalAlign: -2 }} aria-hidden /> yes
    </span>
  ) : (
    <span className="muted">{no}</span>
  );
}

export function BenchRecSection({ r }: { r: BenchRecResult }) {
  const lines = r.learned.eval.bankLines;
  const last = r.versions[r.versions.length - 1];
  const rows = [
    { key: 'learned', name: 'Charter, learned', sub: `${r.versions.length - 1} version${r.versions.length === 2 ? '' : 's'} learned from the reconciliation history`, e: r.learned.eval, accent: true },
    { key: 'day0', name: 'Charter, day 0', sub: 'one rule: one allocation has exactly this amount that day', e: r.day0.eval, accent: false },
    { key: 'hand', name: 'Rules written by hand', sub: 'six rules, the yardstick', e: r.handwritten.eval, accent: false },
    ...(r.baseline ? [{ key: 'baseline', name: 'Matcher shipped with the dataset', sub: r.baseline.name.replace(/\s*\(shipped with the dataset\)\s*$/, ''), e: { matched: r.baseline.matched, correct: r.baseline.correct, precision: r.baseline.precision }, accent: false }] : []),
  ].map(x => ({ ...x, share: lines ? x.e.matched / lines : 0, precision: x.e.precision ?? 0, clears: (x.e.precision ?? 0) >= r.floor && x.e.matched > 0, low: x.e.matched ? 1 - upper95(x.e.matched - x.e.correct, x.e.matched) : 0 }));
  const charter = rows[0];
  const toPerson = lines - r.learned.eval.matched;
  const started = new Map(r.versions.map(v => [v.from, v]));
  return (
    <section className="sheet benchrec" aria-labelledby="benchrec-title">
      <div className="sheet-pad" style={{ paddingBottom: 8 }}>
        <div className="section-head">
          <h2 className="section-title" id="benchrec-title">
            Real bank reconciliation (BenchRec)
          </h2>
          <span className="aside">{r.dataset ? `${r.dataset}; ` : ''}learned on the train split, scored once on the locked eval split</span>
        </div>
        <p className="benchrec-headline">
          Learned from the bank&apos;s own reconciliation history, then matched alone <b>{pct1(charter.share)}</b> of <b>{num(lines)}</b> bank lines at <b>{pct2(charter.precision)}</b> precision; clears the {pct1(r.floor)} floor: <Tick yes={charter.clears} />.
        </p>
      </div>
      <table className="table benchrec-compare">
        <thead>
          <tr>
            <th>Matcher</th>
            <th>Bank lines matched</th>
            <th>Precision of what it matched</th>
            <th>Clears the {pct1(r.floor)} floor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(x => (
            <tr key={x.key}>
              <td>
                <div style={{ fontWeight: 600 }}>{x.name}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {x.sub}
                </div>
              </td>
              <td>
                <div className="cell-figure">
                  <span className="num">
                    <b>{pct1(x.share)}</b> <span className="muted">({num(x.e.matched)})</span>
                  </span>
                  <span className="share-track" aria-hidden>
                    <i className={x.accent ? 'accent' : ''} style={{ width: `${x.share * 100}%` }} />
                  </span>
                </div>
              </td>
              <td>
                {x.e.matched ? (
                  <div className="cell-figure">
                    <span className="num">
                      <b>{pct2(x.precision)}</b> <span className="muted">({num(x.e.matched - x.e.correct)} wrong)</span>
                    </span>
                    <span className="precision-track" aria-hidden>
                      <span className="floor" style={{ left: `${((r.floor - TRACK_LO) / (1 - TRACK_LO)) * 100}%` }} />
                      <i className={x.accent ? 'accent' : ''} style={{ left: `${Math.max(0, Math.min(1, (x.precision - TRACK_LO) / (1 - TRACK_LO))) * 100}%` }} />
                    </span>
                    <span className="faint" style={{ fontSize: 12 }}>
                      at least {pct2(x.low)}, 95% sure
                    </span>
                  </div>
                ) : (
                  <span className="muted">matched nothing alone</span>
                )}
              </td>
              <td>
                <Tick yes={x.clears} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="benchrec-scale faint">Bars run from 0 to 100% of bank lines. The precision track runs from 99% to 100%; the upright mark is the {pct1(r.floor)} floor.</p>

      <div className="sheet-pad" style={{ paddingTop: 8, paddingBottom: 8 }}>
        <h3 className="sub-title">How it learned</h3>
        <p className="benchrec-context">
          Month by month the seat decided each train line as it arrived. A line it asked about or matched wrongly was a lesson, with the reconciliation team&apos;s recorded match as the answer; the evolver proposed, the replay gate checked every candidate against every line matched so far, and a version that passed took over the next month.
        </p>
      </div>
      <table className="table benchrec-months">
        <thead>
          <tr>
            <th>Month</th>
            <th className="n">Bank lines</th>
            <th>Matched alone</th>
            <th className="n">Wrong</th>
            <th>Version</th>
          </tr>
        </thead>
        <tbody>
          {r.months.map(m => {
            const v = started.get(m.month);
            return (
              <tr key={m.month}>
                <td className="num">{m.month}</td>
                <td className="n">{num(m.lines)}</td>
                <td>
                  <div className="cell-figure" style={{ gridTemplateColumns: '52px 1fr', alignItems: 'center' }}>
                    <span className="num">{pct1(m.lines ? m.alone / m.lines : 0)}</span>
                    <span className="share-track" aria-hidden>
                      <i className="accent" style={{ width: `${m.lines ? (m.alone / m.lines) * 100 : 0}%` }} />
                    </span>
                  </div>
                </td>
                <td className="n">{num(m.wrong)}</td>
                <td>
                  v{m.version}
                  {v && v.version > 1 ? (
                    <span className="faint" style={{ fontSize: 12 }}>
                      {' '}
                      → v{v.version} after this month: handled {num(v.lessonsHandled)} of {num(v.lessons)} lessons, took over {num(v.tookOver)} matches
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="sheet-pad" style={{ paddingTop: 12, paddingBottom: 8 }}>
        <h3 className="sub-title">The learned skill (v{last.version})</h3>
        <p className="benchrec-context">
          Each rule earns its autonomy as every rule in Charter does, on the train months after this version took over{r.autonomyFrom ? ` (after ${r.autonomyFrom})` : ''}, which no version was fitted to: it acts alone unless its record there proves, at 95%, that it is wrong more often than the {errPct(1 - r.floor).replace(/0+%$/, '%')} the benchmark tolerates; then it is suspended and its lines go to a person. The other desks are measured on the same months.
        </p>
      </div>
      <table className="table benchrec-rules">
        <thead>
          <tr>
            <th rowSpan={2}>Rule</th>
            <th rowSpan={2}>When it fires</th>
            <th rowSpan={2}>Decides</th>
            <th colSpan={3} className="group">
              Train months after it took over
            </th>
            <th rowSpan={2}>Acts alone</th>
          </tr>
          <tr>
            <th className="n">Cases</th>
            <th className="n">Wrong</th>
            <th className="n">Error rate, 95% range</th>
          </tr>
        </thead>
        <tbody>
          {r.learned.rules.map((x, i) => (
            <tr key={x.rule}>
              <td className="num">{x.rule + 1}</td>
              <td>{last.rules[i] ? exprText(last.rules[i].when) : x.note}</td>
              <td>{outcomeText(x.decide)}</td>
              <td className="n">{num(x.train.n)}</td>
              <td className="n">{num(x.train.wrong)}</td>
              <td className="n">
                {x.train.lower95 !== undefined ? `${errPct(x.train.lower95)}–` : ''}
                {errPct(x.train.upper95)}
              </td>
              <td>
                {x.train.actsAlone ? (
                  <span className="tick" style={{ fontWeight: 600 }}>
                    <Check size={13} style={{ verticalAlign: -2 }} aria-hidden /> {x.train.state === 'reduced' ? `yes, proven under ${+((1 - r.floor) * 100).toFixed(2)}%` : 'yes, under inspection'}
                  </span>
                ) : (
                  <span className="muted">suspended: a person decides</span>
                )}
              </td>
            </tr>
          ))}
          <tr className="benchrec-rest">
            <td />
            <td colSpan={5}>No rule acts alone: the line goes to a person</td>
            <td className="n">
              {num(toPerson)} <span className="muted">({pct1(lines ? toPerson / lines : 0)})</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
