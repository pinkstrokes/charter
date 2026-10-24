// Real bank reconciliation (BenchRec, tools/benchrec): the day-0 bank-reconciliation
// skill on a public benchmark's locked eval split, next to the matcher shipped with
// the dataset. Two measures, two scales, never one plot: share matched as bars from
// zero, precision as a dot on a 99-100% track with the floor marked.
import { Check } from 'lucide-react';
import { upper95 } from '@module/reliability';
import { num } from '../lib/format';

export interface BenchRecResult {
  dataset?: string;
  floor: number;
  rules: { rule: number; note: string; train: { n: number; wrong: number; upper95: number }; actsAlone: boolean; eval: { n: number; wrong: number } }[];
  eval: { bankLines: number; matched: number; correct: number; precision: number; matchRate: number; clearsFloor?: boolean };
  baseline?: { name: string; matched: number; correct: number; precision: number; matchRate: number };
}

const TRACK_LO = 0.99;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const pct2 = (x: number) => `${(x * 100).toFixed(2)}%`;
// Small error rates need more digits than large ones to say anything.
const errPct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 3 : 1)}%`;

export function isBenchRec(v: unknown): v is BenchRecResult {
  const o = v as BenchRecResult;
  return !!o && typeof o === 'object' && typeof o.floor === 'number' && Array.isArray(o.rules) && !!o.eval && typeof o.eval.bankLines === 'number';
}

export function BenchRecSection({ r }: { r: BenchRecResult }) {
  const tolerance = 1 - r.floor;
  const lines = r.eval.bankLines;
  const rows = [
    {
      key: 'charter',
      name: 'Charter',
      sub: 'day-0 skill; only rules that earned autonomy act',
      matched: r.eval.matched,
      correct: r.eval.correct,
      precision: r.eval.precision,
      accent: true,
    },
    ...(r.baseline
      ? [
          {
            key: 'baseline',
            name: 'Matcher shipped with the dataset',
            sub: r.baseline.name.replace(/\s*\(shipped with the dataset\)\s*$/, ''),
            matched: r.baseline.matched,
            correct: r.baseline.correct,
            precision: r.baseline.precision,
            accent: false,
          },
        ]
      : []),
  ].map(x => ({ ...x, share: lines ? x.matched / lines : 0, clears: x.precision >= r.floor, low: x.matched ? 1 - upper95(x.matched - x.correct, x.matched) : 0 }));
  const charter = rows[0];
  const toPerson = lines - r.eval.matched;
  return (
    <section className="sheet benchrec" aria-labelledby="benchrec-title">
      <div className="sheet-pad" style={{ paddingBottom: 8 }}>
        <div className="section-head">
          <h2 className="section-title" id="benchrec-title">
            Real bank reconciliation (BenchRec)
          </h2>
          <span className="aside">{r.dataset ? `${r.dataset}; ` : ''}locked eval split, never seen while the rules earned autonomy</span>
        </div>
        <p className="benchrec-headline">
          Matched alone <b>{pct1(charter.share)}</b> of <b>{num(lines)}</b> bank lines at <b>{pct2(charter.precision)}</b> precision; clears the {pct1(r.floor)} floor:{' '}
          {charter.clears ? (
            <span className="tick" style={{ fontWeight: 600 }}>
              <Check size={14} style={{ verticalAlign: -2 }} aria-hidden /> yes
            </span>
          ) : (
            <b>no</b>
          )}
          .
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
                    <b>{pct1(x.share)}</b> <span className="muted">({num(x.matched)})</span>
                  </span>
                  <span className="share-track" aria-hidden>
                    <i className={x.accent ? 'accent' : ''} style={{ width: `${x.share * 100}%` }} />
                  </span>
                </div>
              </td>
              <td>
                <div className="cell-figure">
                  <span className="num">
                    <b>{pct2(x.precision)}</b> <span className="muted">({num(x.matched - x.correct)} wrong)</span>
                  </span>
                  <span className="precision-track" aria-hidden>
                    <span className="floor" style={{ left: `${((r.floor - TRACK_LO) / (1 - TRACK_LO)) * 100}%` }} />
                    <i className={x.accent ? 'accent' : ''} style={{ left: `${Math.max(0, Math.min(1, (x.precision - TRACK_LO) / (1 - TRACK_LO))) * 100}%` }} />
                  </span>
                  <span className="faint" style={{ fontSize: 12 }}>
                    at least {pct2(x.low)}, 95% sure
                  </span>
                </div>
              </td>
              <td>
                {x.clears ? (
                  <span className="tick" style={{ fontWeight: 600 }}>
                    <Check size={14} style={{ verticalAlign: -2 }} aria-hidden /> yes
                  </span>
                ) : (
                  <span>no</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="benchrec-scale faint">Bars run from 0 to 100% of bank lines. The precision track runs from 99% to 100%; the upright mark is the {pct1(r.floor)} floor.</p>

      <div className="sheet-pad" style={{ paddingTop: 4, paddingBottom: 8 }}>
        <p className="benchrec-context">
          Each rule of the day-0 bank-reconciliation skill acts alone only when, on the train split, we are 95% sure its error rate is under the {errPct(tolerance).replace(/0+%$/, '%')} the benchmark tolerates; everything else goes to a person.
        </p>
      </div>
      <table className="table benchrec-rules">
        <thead>
          <tr>
            <th rowSpan={2}>Rule</th>
            <th rowSpan={2}>When it fires</th>
            <th colSpan={3} className="group">
              Train split
            </th>
            <th rowSpan={2}>Acts alone</th>
            <th colSpan={2} className="group">
              Eval split
            </th>
          </tr>
          <tr>
            <th className="n">Cases</th>
            <th className="n">Wrong</th>
            <th className="n">Error, 95% upper bound</th>
            <th className="n">Matched</th>
            <th className="n">Wrong</th>
          </tr>
        </thead>
        <tbody>
          {r.rules.map(x => (
            <tr key={x.rule}>
              <td className="num">{x.rule + 1}</td>
              <td>{x.note}</td>
              <td className="n">{num(x.train.n)}</td>
              <td className="n">{num(x.train.wrong)}</td>
              <td className="n">{errPct(x.train.upper95)}</td>
              <td>
                {x.actsAlone ? (
                  <span className="tick" style={{ fontWeight: 600 }}>
                    <Check size={13} style={{ verticalAlign: -2 }} aria-hidden /> yes
                  </span>
                ) : (
                  <span className="muted">no, asks a person</span>
                )}
              </td>
              <td className="n">{x.actsAlone ? num(x.eval.n) : '–'}</td>
              <td className="n">{x.actsAlone ? num(x.eval.wrong) : '–'}</td>
            </tr>
          ))}
          <tr className="benchrec-rest">
            <td />
            <td>No rule acts alone: the line goes to a person</td>
            <td colSpan={4} />
            <td className="n">
              {num(toPerson)} <span className="muted">({pct1(lines ? toPerson / lines : 0)})</span>
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </section>
  );
}
