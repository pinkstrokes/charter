// Earned autonomy, rule by rule: how often each rule of each skill version has
// been checked, how often it was wrong, the 95% bound on its error rate against
// what the team tolerates, and the inspection level that follows (module
// reliability.ts, whose functions and thresholds this page imports).
import { Check } from 'lucide-react';
import { useMemo } from 'react';
import type { Activity, RuleStat } from '../module_bindings/types';
import { SAMPLE_RATE, TOLERABLE, lower95, upper95 } from '@module/reliability';
import { Empty, StatusChip } from '../components/ui';
import { openWhy } from '../app/nav';
import { day, pct } from '../lib/format';
import { parseArr, parseObj } from '../lib/json';
import { DOMAIN_LABEL, DOMAIN_NAMES, parseProgram, ruleText } from '../lib/rules';
import { useRows } from '../stdb/store';

const STATE_ORDER = ['suspended', 'tightened', 'probation', 'normal', 'reduced'];

export function Autonomy() {
  const stats = useRows('ruleStat');
  const skills = useRows('skill');
  const activity = useRows('activity');
  const transitions = useMemo(() => {
    const m = new Map<string, Activity[]>();
    for (const a of activity) {
      if (a.kind !== 'reliability') continue;
      const rule = String(parseObj(a.params).rule ?? '');
      const list = m.get(rule) ?? [];
      list.push(a);
      m.set(rule, list);
    }
    for (const list of m.values()) list.sort((x, y) => (x.id < y.id ? -1 : 1));
    return m;
  }, [activity]);
  const byDomain = useMemo(() => {
    const m = new Map<string, RuleStat[]>();
    for (const s of stats) m.set(s.domain, [...(m.get(s.domain) ?? []), s]);
    for (const list of m.values())
      list.sort((a, b) => {
        const va = Number(a.skillKey.split('@')[1]?.split('+')[0] ?? 0);
        const vb = Number(b.skillKey.split('@')[1]?.split('+')[0] ?? 0);
        return vb - va || a.ruleIndex - b.ruleIndex;
      });
    return m;
  }, [stats]);
  const counts = STATE_ORDER.map(s => [s, stats.filter(x => x.state === s).length] as const).filter(([, n]) => n > 0);
  return (
    <div className="stack">
      <section className="sheet sheet-pad">
        <div className="row" style={{ gap: 14, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <div style={{ flex: 1, maxWidth: '80ch' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Autonomy is earned rule by rule</div>
            <div className="muted" style={{ fontSize: 13 }}>
              A person checks a share of what each rule decides alone: {pct(SAMPLE_RATE.probation, 0)} on probation, {pct(SAMPLE_RATE.normal, 0)} after 20 checks, {pct(SAMPLE_RATE.reduced, 0)} once 40 checks put its 95% error bound under what the team tolerates. One mistake tightens it to {pct(SAMPLE_RATE.tightened, 0)}; a rule shown to be worse than tolerable is suspended and a person takes every case. Escalations carry no risk, so their false alarms are counted as cost, apart.
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {counts.map(([s, n]) => (
              <span key={s} className="row" style={{ gap: 4 }}>
                <StatusChip status={s} />
                <b className="num">{n}</b>
              </span>
            ))}
          </div>
        </div>
      </section>
      {stats.length === 0 && (
        <div className="sheet">
          <Empty title="No rule has decided anything yet">Each rule's record starts with its first decision.</Empty>
        </div>
      )}
      {DOMAIN_NAMES.filter(d => byDomain.has(d)).map(d => (
        <section key={d} className="sheet" aria-label={DOMAIN_LABEL[d]}>
          <div className="sheet-pad" style={{ paddingBottom: 6 }}>
            <div className="section-head">
              <h2 className="section-title">{DOMAIN_LABEL[d]}</h2>
              <span className="aside">tolerable error {pct((TOLERABLE as Record<string, number>)[d] ?? 0.05, 0)}</span>
            </div>
          </div>
          <table className="table" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '31%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '11%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Inspection</th>
                <th className="n">Decided</th>
                <th className="n">Checked</th>
                <th className="n" title="Autonomous decisions later found wrong: what autonomy is earned on">Wrong (risk)</th>
                <th>Error rate, 95% bounds</th>
                <th className="n" title="Escalations a person found unnecessary: cost, not risk">False alarms (cost)</th>
                <th>Last 20 checks</th>
              </tr>
            </thead>
            <tbody>
              {byDomain.get(d)!.map(s => (
                <RuleRow key={s.key} s={s} program={parseProgram(skills.find(k => k.key === s.skillKey.split('+')[0])?.program ?? '')} transitions={transitions.get(s.key) ?? []} tolerable={(TOLERABLE as Record<string, number>)[d] ?? 0.05} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function RuleRow({ s, program, transitions, tolerable }: { s: RuleStat; program: ReturnType<typeof parseProgram>; transitions: Activity[]; tolerable: number }) {
  const hi = upper95(s.errors, s.checked);
  const lo = lower95(s.errors, s.checked);
  const recent = parseArr<number>(s.recent);
  const earned = s.checked > 0 && hi <= tolerable;
  // Scale: the tolerable rate sits at the middle of the bar.
  const x = (v: number) => `${Math.min(100, (v / tolerable) * 50)}%`;
  return (
    <tr>
      <td>
        <div className="mono" style={{ fontSize: 12 }}>
          {s.skillKey}#{s.ruleIndex}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {ruleText(program, s.ruleIndex)}
        </div>
        {transitions.length > 0 && (
          <div className="row" style={{ gap: 4, marginTop: 3, fontSize: 11 }}>
            {transitions.map(t => {
              const p = parseObj(t.params);
              return (
                <button key={t.id.toString()} className="btn small quiet" style={{ height: 20, padding: '0 5px', fontSize: 11 }} onClick={() => openWhy(t.id)} title={`#${t.id}`}>
                  {day(t.at)}: {String(p.from)} to {String(p.to)}
                </button>
              );
            })}
          </div>
        )}
      </td>
      <td>
        <StatusChip status={s.state} />
        <div className="faint num" style={{ fontSize: 11, marginTop: 2 }}>
          {pct(s.sampleRate, 0)} checked
        </div>
      </td>
      <td className="n">{s.decisions}</td>
      <td className="n">{s.checked}</td>
      <td className="n" style={{ fontWeight: s.errors ? 600 : 400 }}>
        {s.errors}
      </td>
      <td style={{ minWidth: 170 }}>
        <div className="num" style={{ fontSize: 12 }}>
          {s.checked ? `${pct(s.errors / s.checked)}, ${pct(lo)} to ${pct(hi)}` : 'not checked yet'}
          {earned && <Check size={12} className="tick" style={{ marginLeft: 4, verticalAlign: -1 }} />}
        </div>
        <div style={{ position: 'relative', height: 8, marginTop: 3, background: 'var(--rule)', borderRadius: 4 }} title={`95% bounds ${pct(lo)} to ${pct(hi)}; tolerable ${pct(tolerable, 0)}`}>
          {s.checked > 0 && <span style={{ position: 'absolute', left: x(lo), width: `calc(${x(hi)} - ${x(lo)})`, top: 1, bottom: 1, borderRadius: 3, background: earned ? 'var(--tick)' : 'var(--taro)', opacity: 0.85 }} />}
          <span style={{ position: 'absolute', left: '50%', top: -3, bottom: -3, width: 1.5, background: 'var(--ink-2)' }} />
        </div>
      </td>
      <td className="n">
        {s.alarmsChecked ? (
          <span title={`${s.falseAlarms} of ${s.alarmsChecked} checked escalations were unnecessary`}>
            {s.falseAlarms} of {s.alarmsChecked}
          </span>
        ) : (
          <span className="faint">—</span>
        )}
      </td>
      <td>
        <span className="row" style={{ gap: 2, flexWrap: 'nowrap' }} aria-label={`${recent.filter(v => v === 1).length} wrong in the last ${recent.length} checks`}>
          {recent.length === 0 && <span className="faint" style={{ fontSize: 12 }}>none</span>}
          {recent.map((v, i) => (
            <span key={i} style={{ width: 7, height: 12, borderRadius: 2, background: v ? 'var(--ink)' : 'transparent', border: `1px solid ${v ? 'var(--ink)' : 'var(--rule-strong)'}` }} />
          ))}
        </span>
      </td>
    </tr>
  );
}
