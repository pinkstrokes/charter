import { Check, FileJson, RefreshCw, X } from 'lucide-react';
import { charterApi } from '../stdb/api';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { TrendSection, type TrendMonth, type VersionMark } from '../components/Trend';
import { BenchRecSection, isBenchRec } from '../components/BenchRec';
import { parseObj } from '../lib/json';
import { useRows } from '../stdb/store';
import { Empty, KV } from '../components/ui';
import { valueText } from '../lib/values';
import { SkillProof } from '../components/Proofs';
import { money, num, pct } from '../lib/format';
import { charter, useCharter } from '../stdb/client';

interface ProofFile {
  name: string;
  json?: unknown;
  error?: string;
  modified?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export function Proof() {
  const info = useCharter();
  const [dir, setDir] = useState('');
  const [data, setData] = useState<{ dir: string; current: string; available: { id: string; label: string }[]; files: ProofFile[]; benchrec?: ProofFile | null } | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      const res = await fetch(charterApi('proof', charter.info.db, dir));
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [dir]);
  useEffect(() => {
    if (info.db) void load();
  }, [info.db, load]);
  const isReport = (f: ProofFile) => /(^|\/)(run_)?report\.json$/.test(f.name) && isObj(f.json) && ('outcomes' in (f.json as Obj) || 'chain' in (f.json as Obj));
  const report = data?.files.find(isReport);
  const bench = data?.benchrec?.json && isBenchRec(data.benchrec.json) ? <BenchRecSection r={data.benchrec.json} /> : null;
  const others = data?.files.filter(f => f !== report) ?? [];
  return (
    <div className="page-inner">
      <div className="page-head">
        <h1 className="page-title">Proof</h1>
        <p className="page-sub">What is real, what is simulated, and how we know: numbers written by the run and the evolution engine, shown as they are.</p>
        <div className="row" style={{ marginLeft: 'auto' }}>
          {data && data.available.length > 1 && (
            <select className="select" style={{ width: 'auto', minHeight: 30 }} value={dir || data.current} onChange={e => setDir(e.target.value)} aria-label="Data folder">
              {data.available.map(d => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
          <button className="btn small" onClick={() => void load()}>
            <RefreshCw size={13} /> Reload
          </button>
        </div>
      </div>
      {err && <div className="banner error">{err}</div>}
      {data && data.files.length === 0 && (
        <div className="sheet">
          <Empty title={`Nothing in ${data.dir} yet`}>When the six-month run finishes it writes run_report.json and eval/*.json there; this page reads them as they appear.</Empty>
        </div>
      )}
      {report ? <Report f={report} db={info.db} extra={bench} /> : bench}
      <div className="stack" style={{ marginTop: report ? 16 : 0 }}>
        {others.map(f => (
          <section key={f.name} className="sheet sheet-pad">
            <div className="section-head">
              <FileJson size={15} className="faint" />
              <h2 className="section-title">{f.name}</h2>
              <span className="aside">
                {data?.dir}/{f.name}
                {f.modified ? `, written ${new Date(f.modified).toLocaleString()}` : ''}
              </span>
            </div>
            {f.error ? <div className="red">{f.error}</div> : <FileBody json={f.json} />}
          </section>
        ))}
      </div>
    </div>
  );
}

// Money the run kept or moved, as plain figures; a figure that is zero because the
// run had nothing of that kind is left out rather than shown as a reassuring $0.
function MoneyKept({ m }: { m: Record<string, number> }) {
  const tiles: { label: string; value: string; sub?: string }[] = [];
  const stopped = m.duplicateBillsStoppedCents ?? 0;
  const paid = m.duplicateBillsPaidCents ?? 0;
  if (stopped || paid) {
    tiles.push({ label: 'Duplicate bills stopped', value: money(stopped) });
    tiles.push({ label: 'Duplicate bills paid anyway', value: money(paid) });
  }
  if (m.auditInvoices) tiles.push({ label: 'Royalty billed after audits', value: money(m.auditInvoicesCents ?? 0), sub: `${num(m.auditInvoices)} audit invoice${m.auditInvoices === 1 ? '' : 's'}` });
  if (m.refundsReleased) tiles.push({ label: 'Refunds released', value: num(m.refundsReleased) });
  if (!tiles.length) return null;
  return (
    <div className="stat-row">
      {tiles.map(t => (
        <div key={t.label} className="sheet stat">
          <div className="stat-label">{t.label}</div>
          <div className="stat-value">{t.value}</div>
          {t.sub && <div className="stat-sub">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function FileBody({ json }: { json: unknown }) {
  if (isObj(json) && isObj(json.proof) && isObj(json.program)) return <SkillProof text={JSON.stringify(json.proof)} />;
  if (isObj(json) && isObj(json.families) && Object.values(json.families).some(f => isObj(f) && 'planted' in f)) return <RunReport r={json} />;
  if (Array.isArray(json)) return <Auto v={json} />;
  return <Auto v={json} />;
}

// When a version went live: from the activity log if this report describes the
// database the page is connected to, else from the report (activatedAt if it has
// it, otherwise the day the version was created).
function useVersionMarks(r: Obj, db: string): { marks: VersionMark[]; from: 'activity' | 'report' | 'created' } {
  const activity = useRows('activity');
  return useMemo(() => {
    const gens = Array.isArray(r.generations) ? (r.generations as { key: string; status: string; createdAt?: string; activatedAt?: string }[]) : [];
    const later = (key: string) => Number(key.split('@')[1] ?? 1) > 1;
    if (r.db === db) {
      const marks: VersionMark[] = [];
      for (const a of activity) {
        if (a.command !== 'activate_skill' || a.outcome !== 'committed') continue;
        const p = parseObj(a.params);
        const key = String(p.key ?? '');
        if (p.to === 'active' && later(key)) marks.push({ key, domain: key.split('@')[0], date: a.at, how: 'went live' });
      }
      return { marks, from: 'activity' };
    }
    const dated = gens.filter(g => later(g.key) && (g.activatedAt || ((g.status === 'active' || g.status === 'retired') && g.createdAt)));
    const fromReport = dated.some(g => g.activatedAt);
    return {
      marks: dated.map(g => ({ key: g.key, domain: g.key.split('@')[0], date: String(g.activatedAt ?? g.createdAt).slice(0, 10), how: g.activatedAt ? 'went live' : 'created' })),
      from: fromReport ? 'report' : 'created',
    };
  }, [r, db, activity]);
}

function Report({ f, db, extra }: { f: ProofFile; db: string; extra?: ReactNode }) {
  const r = f.json as Obj;
  const trend = Array.isArray(r.trend) && r.trend.length ? (r.trend as TrendMonth[]) : null;
  const versions = useVersionMarks(r, db);
  const moneyKept = isObj(r.money) ? (r.money as Record<string, number>) : null;
  const outcomes = isObj(r.outcomes) ? (r.outcomes as Record<string, Record<string, { n: number; right: number; missing?: number }>>) : null;
  const landed = isObj(r.cashLanded) ? (r.cashLanded as Record<string, Record<string, { n: number; right: number }>>) : null;
  const asking = isObj(r.knowingWhenToAsk) ? (r.knowingWhenToAsk as Record<string, { handledAlone: number; wrong: number; upper95: number }>) : null;
  const gens = Array.isArray(r.generations) ? (r.generations as { key: string; status: string; createdAt?: string; test?: Record<string, { n: number; right: number }> }[]) : [];
  const invariants = isObj(r.invariants) ? (r.invariants as Record<string, boolean>) : null;
  const chain = isObj(r.chain) ? (r.chain as { rows: number; verified: number; firstBreak: unknown; head: string }) : null;
  const known = new Set(['db', 'generatedAt', 'answerKeyEntries', 'outcomes', 'cashLanded', 'knowingWhenToAsk', 'generations', 'invariants', 'chain', 'trend', 'money']);
  const rest: Obj = {};
  for (const [k, v] of Object.entries(r)) if (!known.has(k)) rest[k] = v;
  const hasLanded = !!landed && Object.values(landed).some(x => isObj(x) && Object.keys(x).length > 0);
  const splits = outcomes ? Object.keys(outcomes).sort((a, b) => ['train', 'val', 'test', 'live'].indexOf(a) - ['train', 'val', 'test', 'live'].indexOf(b)) : [];
  return (
    <section className="stack">
      {typeof r.db === 'string' && r.db !== db && (
        <div className="banner">
          This report was generated from database {r.db}; you are connected to {db}. Its numbers describe {r.db}.
        </div>
      )}
      {trend && <TrendSection trend={trend} marks={versions.marks} marksFrom={versions.from} />}
      {moneyKept && <MoneyKept m={moneyKept} />}
      {extra}
      <div className="sheet sheet-pad">
        <div className="section-head">
          <h2 className="section-title">Run report</h2>
          <span className="aside">
            {f.name}
            {r.generatedAt ? `, generated ${new Date(String(r.generatedAt)).toLocaleString()}` : ''}
          </span>
        </div>
        <div className="row" style={{ gap: 22, fontSize: 14 }}>
          {typeof r.answerKeyEntries === 'number' && (
            <span>
              <b className="num">{num(r.answerKeyEntries)}</b> planted cases with a known answer
            </span>
          )}
          {chain && (
            <span className={chain.verified === chain.rows && !chain.firstBreak ? 'tick' : 'red'} style={{ fontWeight: 600 }}>
              {chain.verified === chain.rows ? <Check size={14} style={{ verticalAlign: -2 }} /> : <X size={14} style={{ verticalAlign: -2 }} />} {num(chain.verified)} of {num(chain.rows)} chain rows verify outside the database
            </span>
          )}
          {invariants && (
            <span className={Object.values(invariants).every(Boolean) ? 'tick' : 'red'} style={{ fontWeight: 600 }}>
              {Object.values(invariants).every(Boolean) ? <Check size={14} style={{ verticalAlign: -2 }} /> : <X size={14} style={{ verticalAlign: -2 }} />} {Object.values(invariants).filter(Boolean).length} of {Object.keys(invariants).length} ledger controls hold
            </span>
          )}
        </div>
      </div>
      {outcomes && (
        <div className="sheet">
          <div className="sheet-pad" style={{ paddingBottom: 6 }}>
            <div className="section-head">
              <h2 className="section-title">Decisions against the answer key</h2>
              <span className="aside">train and val are what the team could learn from; test and live were hidden from the evolution engine</span>
            </div>
            {hasLanded && (
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                For cash, <b>money landed</b> is the stricter reading: right only when each receipt ended up on exactly the invoices the payer meant, whatever the outcome label said.
              </p>
            )}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Split</th>
                <th>Scenario family</th>
                <th className="n">Cases</th>
                <th className="n">Right</th>
                <th className="n">Share right</th>
                <th className="n">Missing</th>
                {hasLanded && <th className="n">Money landed right</th>}
                {hasLanded && <th className="n">Share</th>}
              </tr>
            </thead>
            <tbody>
              {splits.flatMap(s =>
                Object.entries(outcomes[s]).map(([fam, c], i) => {
                  const m = landed?.[s]?.[fam];
                  const differs = m !== undefined && (m.right !== c.right || m.n !== c.n);
                  return (
                    <tr key={`${s}:${fam}`}>
                      <td style={{ fontWeight: i === 0 ? 600 : 400 }}>{i === 0 ? s : ''}</td>
                      <td>{fam.replace(/_/g, ' ')}</td>
                      <td className="n">{c.n}</td>
                      <td className="n">{c.right}</td>
                      <td className="n">{c.n ? pct(c.right / c.n, 0) : '—'}</td>
                      <td className="n">{c.missing ?? 0}</td>
                      {hasLanded && (
                        <td className="n" style={{ fontWeight: differs ? 600 : 400 }} title={differs ? 'the outcome label and where the money went disagree' : undefined}>
                          {m ? (m.n !== c.n ? `${m.right} of ${m.n}` : m.right) : <span className="faint">n/a</span>}
                        </td>
                      )}
                      {hasLanded && <td className="n">{m ? (m.n ? pct(m.right / m.n, 0) : '—') : ''}</td>}
                    </tr>
                  );
                })
              )}
              {hasLanded &&
                Object.entries(landed!).flatMap(([s, fams]) =>
                  Object.entries(fams)
                    .filter(([fam]) => !outcomes[s]?.[fam])
                    .map(([fam, m]) => (
                      <tr key={`landed:${s}:${fam}`}>
                        <td>{s}</td>
                        <td>{fam.replace(/_/g, ' ')}</td>
                        <td className="n">{m.n}</td>
                        <td className="n faint">n/a</td>
                        <td className="n" />
                        <td className="n" />
                        <td className="n">{m.right}</td>
                        <td className="n">{m.n ? pct(m.right / m.n, 0) : '—'}</td>
                      </tr>
                    ))
                )}
            </tbody>
          </table>
        </div>
      )}
      <div className="split-even">
        {asking && (
          <div className="sheet">
            <div className="sheet-pad" style={{ paddingBottom: 6 }}>
              <div className="section-head">
                <h2 className="section-title">Knowing when to ask</h2>
                <span className="aside">cases a seat handled alone, and how often it was wrong</span>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th className="n">Handled alone</th>
                  <th className="n">Wrong</th>
                  <th className="n">Error, 95% upper bound</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(asking).map(([d, x]) => (
                  <tr key={d}>
                    <td>{d.replace(/_/g, ' ')}</td>
                    <td className="n">{x.handledAlone}</td>
                    <td className="n">{x.wrong}</td>
                    <td className="n">{pct(x.upper95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {gens.length > 0 && (
          <div className="sheet">
            <div className="sheet-pad" style={{ paddingBottom: 6 }}>
              <div className="section-head">
                <h2 className="section-title">Skill generations on held-out test cases</h2>
              </div>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Test results by family</th>
                </tr>
              </thead>
              <tbody>
                {gens.map(g => (
                  <tr key={g.key}>
                    <td style={{ fontWeight: 600 }}>{g.key}</td>
                    <td>
                      <span className={`chip ${g.status}`}>{g.status}</span>
                    </td>
                    <td className="num" style={{ fontSize: 13 }}>
                      {g.test && Object.keys(g.test).length
                        ? Object.entries(g.test)
                            .map(([fam, c]) => `${fam.replace(/_/g, ' ')} ${c.right}/${c.n}`)
                            .join(', ')
                        : <span className="faint">no test cases in this domain</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {(invariants || Object.keys(rest).length > 0) && (
        <div className="split-even">
          {invariants && (
            <div className="sheet sheet-pad">
              <div className="section-head">
                <h2 className="section-title">Ledger controls at the end of the run</h2>
              </div>
              {Object.entries(invariants).map(([k, ok]) => (
                <div key={k} className="row" style={{ gap: 6 }}>
                  {ok ? <Check size={14} className="tick" /> : <X size={14} className="red" />}
                  {k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}
                </div>
              ))}
            </div>
          )}
          {Object.keys(rest).length > 0 && (
            <div className="sheet sheet-pad">
              <div className="section-head">
                <h2 className="section-title">Also in the report</h2>
              </div>
              <Auto v={rest} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// The world run's own report: what was planted, what the team did with it.
function RunReport({ r }: { r: Obj }) {
  const families = r.families as Record<string, { planted?: number; decisions?: Record<string, Record<string, number>>; asks?: Record<string, number>; money?: Record<string, number>; cases?: unknown[] }>;
  const asks = isObj(r.asks) ? (r.asks as Obj) : null;
  const llm = isObj(r.llm) ? (r.llm as Obj) : null;
  const ratified = Array.isArray(r.ratified) ? (r.ratified as Obj[]) : [];
  const shown = new Set(['db', 'window', 'wall_seconds', 'seat_runs', 'llm', 'families', 'asks', 'ratified']);
  const rest: Obj = {};
  for (const [k, v] of Object.entries(r)) if (!shown.has(k)) rest[k] = v;
  const window = Array.isArray(r.window) ? (r.window as string[]) : [];
  const right = (d: Record<string, number>) => {
    const n = d.n ?? 0;
    const latest = d.latest_right ?? d.right;
    return latest !== undefined ? `${latest} of ${n} right${d.first_right !== undefined && d.first_right !== latest ? ` (first time ${d.first_right})` : ''}` : `${n}`;
  };
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="row" style={{ gap: 20, fontSize: 14 }}>
        {window.length === 2 && (
          <span>
            <b>{window[0]}</b> to <b>{window[1]}</b> simulated
          </span>
        )}
        {typeof r.seat_runs === 'number' && <span className="num">{num(r.seat_runs)} seat runs</span>}
        {typeof r.wall_seconds === 'number' && <span className="num">{num(r.wall_seconds)} s of wall time</span>}
        {llm && typeof llm.module_calls === 'number' && (
          <span className="num">
            {num(llm.module_calls as number)} model reads, {num((llm.module_failures as number) ?? 0)} failed
          </span>
        )}
      </div>
      <table className="table compact">
        <thead>
          <tr>
            <th>Scenario family</th>
            <th className="n">Planted</th>
            <th>How the team decided</th>
            <th>Asked people</th>
            <th>Money</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(families).map(([fam, f]) => (
            <tr key={fam}>
              <td style={{ fontWeight: 600 }}>{fam.replace(/_/g, ' ')}</td>
              <td className="n">{f.planted ?? '—'}</td>
              <td style={{ fontSize: 12 }}>
                {f.decisions && Object.keys(f.decisions).length
                  ? Object.entries(f.decisions)
                      .map(([d, v]) => `${d.replace(/_/g, ' ')}: ${right(v)}`)
                      .join('; ')
                  : '—'}
              </td>
              <td style={{ fontSize: 12 }}>{f.asks && Object.keys(f.asks).length ? Object.entries(f.asks).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') : '—'}</td>
              <td style={{ fontSize: 12 }} className="num">
                {f.money && Object.keys(f.money).length ? Object.entries(f.money).map(([k, v]) => `${k.replace(/_cents$/, '').replace(/_/g, ' ')} ${k.endsWith('_cents') ? money(v) : v}`).join(', ') : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(asks || ratified.length > 0) && (
        <div className="split-even">
          {asks && (
            <div>
              <div className="label" style={{ marginBottom: 4 }}>
                People in the loop
              </div>
              <dl className="kv">
                {typeof asks.staff_answers === 'number' && (
                  <>
                    <dt>answers given</dt>
                    <dd className="num">{num(asks.staff_answers as number)}</dd>
                  </>
                )}
                {typeof asks.human_error_rate === 'number' && (
                  <>
                    <dt>simulated human error rate</dt>
                    <dd className="num">{pct(asks.human_error_rate as number)}</dd>
                  </>
                )}
                {isObj(asks.answered_by) && (
                  <>
                    <dt>answered by</dt>
                    <dd>{Object.entries(asks.answered_by as Obj).map(([k, v]) => `${k.split(':')[1] ?? k} ${String(v)}`).join(', ')}</dd>
                  </>
                )}
              </dl>
              {isObj(asks.by_kind_status) && <Auto v={asks.by_kind_status} depth={2} />}
            </div>
          )}
          {ratified.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 4 }}>
                What people let into real work
              </div>
              {ratified.map((x, i) => (
                <div key={i} className="row" style={{ gap: 6, fontSize: 13, marginBottom: 3 }}>
                  {x.ok ? <Check size={13} className="tick" /> : <X size={13} className="red" />}
                  <span className="num faint">{String(x.day ?? '')}</span>
                  <b style={{ fontWeight: 600 }}>{String(x.key ?? '')}</b>
                  {x.text ? <span className="muted">{String(x.text)}</span> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {Object.keys(rest).length > 0 && <Auto v={rest} />}
    </div>
  );
}

// Render any JSON legibly: scalars as key/value rows, uniform objects as tables.
function Auto({ v, depth = 0 }: { v: unknown; depth?: number }) {
  if (isScalar(v)) return <span className="num">{valueText('', v)}</span>;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="faint">none</span>;
    if (v.every(isScalar)) return <span>{v.map(x => valueText('', x)).join(', ')}</span>;
    if (v.every(isObj)) {
      const cols = [...new Set(v.flatMap(o => Object.keys(o as Obj)))];
      return (
        <table className="table compact">
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.slice(0, 200).map((o, i) => (
              <tr key={i}>
                {cols.map(c => (
                  <td key={c} className={typeof (o as Obj)[c] === 'number' ? 'n' : ''}>
                    {isScalar((o as Obj)[c]) ? valueText(c, (o as Obj)[c]) : <Auto v={(o as Obj)[c]} depth={depth + 1} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(v, null, 1)}</pre>;
  }
  if (isObj(v)) {
    const entries = Object.entries(v);
    // An object whose values are objects of scalars with shared keys: a table, one row per key.
    if (entries.length > 1 && entries.every(([, x]) => isObj(x) && Object.values(x).every(isScalar))) {
      const cols = [...new Set(entries.flatMap(([, x]) => Object.keys(x as Obj)))];
      return (
        <table className="table compact">
          <thead>
            <tr>
              <th />
              {cols.map(c => (
                <th key={c} className="n">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map(([k, x]) => (
              <tr key={k}>
                <td>{k.replace(/_/g, ' ')}</td>
                {cols.map(c => (
                  <td key={c} className="n">
                    {valueText(c, (x as Obj)[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    if (entries.every(([, x]) => isScalar(x) || (Array.isArray(x) && x.every(isScalar)))) return <KV data={v} />;
    if (depth > 3) return <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(v, null, 1)}</pre>;
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {entries.map(([k, x]) =>
          isScalar(x) ? (
            <div key={k} className="row" style={{ gap: 8 }}>
              <span className="muted">{k}</span>
              <span className="num">{valueText(k, x)}</span>
            </div>
          ) : (
            <details key={k} className="json-section" open={depth < 1}>
              <summary>{k}</summary>
              <div style={{ paddingLeft: 12, marginTop: 4 }}>
                <Auto v={x} depth={depth + 1} />
              </div>
            </details>
          )
        )}
      </div>
    );
  }
  return null;
}
