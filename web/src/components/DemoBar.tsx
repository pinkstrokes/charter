// The live demo's step bar (on the demo server, tools/demo/demo.sh up, and in the
// sandbox build): one button per beat, each opening the company, screen and Why panel
// it needs, and, at the demo table only, a reset back to the prepared morning between
// judges (the sandbox is rebuilt by tools/play/reset.sh instead).
import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Activity, Decision } from '../module_bindings/types';
import { useNav } from '../app/nav';
import { parseObj } from '../lib/json';
import { charterApi, isPlay } from '../stdb/api';
import { useCharter } from '../stdb/client';
import { useRows, useStatus } from '../stdb/store';

type Find = 'right_alone' | 'moment' | 'pushback';

interface Step {
  label: string;
  db: string;
  hash: string;
  find?: Find; // the sandbox: the row this beat opens, looked up in the live tables
}

// The sandbox is rebuilt now and then, and its row ids change with every rebuild, so a beat
// that opens a Why panel finds its row the way tools/play/prepare.ts did, in the live tables,
// rather than trusting the id written at the last rebuild.
function findRows(activity: Activity[], decisions: Decision[]): Record<Find, bigint | null> {
  let moment: bigint | null = null;
  let rightAlone: bigint | null = null;
  let hold: bigint | null = null;
  for (const a of activity) {
    // The question that undid an earlier guess (B-15061).
    if (a.command === 'misapplied' && a.kind === 'ask' && (moment === null || a.id < moment)) moment = a.id;
    // The first notice the kernel refused because the customer's own money covered it (C16).
    if (a.command === 'send_notice' && a.kind === 'denied' && a.reasons.includes('C16:') && (rightAlone === null || a.id < rightAlone)) rightAlone = a.id;
  }
  // The latest collections hold inside the grace period, for "This was wrong".
  for (const d of decisions) {
    if (d.domain !== 'pre_chase' || d.outcome !== 'hold' || d.shadow) continue;
    const f = parseObj(d.features);
    const days = Number(f.days_past_due ?? 0);
    if (days > 0 && days <= Number(f.grace_days ?? 0) && (hold === null || d.id > hold)) hold = d.id;
  }
  let pushback: bigint | null = null;
  if (hold !== null)
    for (const a of activity) if (a.kind === 'decision' && a.used.includes(`"decision:${hold}"`) && (pushback === null || a.id > pushback)) pushback = a.id;
  return { right_alone: rightAlone, moment, pushback };
}

function urlFor(s: Step): string {
  const u = new URL(window.location.href);
  u.searchParams.set('db', s.db);
  u.hash = s.hash;
  return u.toString();
}

export function DemoBar() {
  const info = useCharter();
  const nav = useNav();
  const [steps, setSteps] = useState<Step[]>([]);
  const [persona, setPersona] = useState('');
  const [busy, setBusy] = useState('');
  const status = useStatus();
  const activity = useRows('activity');
  const decisions = useRows('decision');
  const found = useMemo(() => (isPlay && status.ready ? findRows(activity, decisions) : null), [activity, decisions, status.ready]);
  // A beat's hash with the row found live, when this page is on that beat's company.
  const live = (s: Step) => {
    const id = s.find && s.db === info.db ? found?.[s.find] : null;
    return id ? s.hash.replace(/why=\d+/, `why=${id.toString()}`) : s.hash;
  };
  // Arriving from the other company on a beat's id from the last rebuild: open the row found live instead.
  useEffect(() => {
    if (!found) return;
    const s = steps.find(x => x.find && x.db === info.db && window.location.hash === x.hash);
    if (s && live(s) !== s.hash) window.location.replace(`${window.location.pathname}${window.location.search}${live(s)}`);
  }, [found, steps, info.db]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!info.demo) return;
    fetch(charterApi('steps'))
      .then(r => r.json())
      .then((b: { steps: Step[]; persona?: string }) => {
        setSteps(b.steps ?? []);
        setPersona(b.persona ?? '');
      })
      .catch(() => setSteps([]));
  }, [info.demo]);
  // ?bar=0 hides it (the video is recorded on the demo server without the presenter's bar).
  if (!info.demo || !steps.length || new URLSearchParams(window.location.search).get('bar') === '0') return null;
  const here = `#/${nav.screen}${nav.sub ? `/${nav.sub}` : ''}${nav.why !== null ? `?why=${nav.why.toString()}` : ''}`;
  const current = steps.findIndex(s => s.db === info.db && (live(s) === here || s.hash === here || here.startsWith(`${s.hash}/`)));
  const open = (s: Step) => {
    if (s.db === info.db) window.location.hash = live(s);
    else window.location.assign(urlFor(s));
  };
  const reset = async () => {
    if (!window.confirm('Reset the demo to the prepared morning? Everything done since is undone.')) return;
    setBusy('Resetting…');
    try {
      const r = await fetch('/__charter/demo/reset', { method: 'POST' });
      const b = (await r.json()) as { ok: boolean; output: string };
      if (!b.ok) throw new Error(b.output);
      // Every table starts as the same controller, whoever the last one switched to.
      if (persona) {
        for (const db of new Set(steps.map(s => s.db))) {
          try {
            localStorage.setItem(`charter.persona.${db}`, persona);
          } catch {
            /* storage unavailable: each company opens on its first persona */
          }
        }
      }
      window.location.assign(urlFor(steps[0]));
    } catch (e) {
      setBusy('');
      window.alert(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <nav className="demobar" aria-label="Demo steps">
      {steps.map((s, i) => (
        <button key={s.label} type="button" className="demostep" aria-current={i === current ? 'step' : undefined} onClick={() => open(s)}>
          <span className="demostep-n">{i + 1}</span>
          {s.label}
        </button>
      ))}
      {!isPlay && (
        <button type="button" className="demostep quiet" onClick={() => void reset()} disabled={!!busy} title="Back to the prepared morning (between judges)">
          <RotateCcw size={12} /> {busy || 'Reset'}
        </button>
      )}
    </nav>
  );
}
