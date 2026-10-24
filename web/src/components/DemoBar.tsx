// The live demo's step bar (only on the demo server, tools/demo/demo.sh up): one
// button per beat, each opening the company, screen and Why panel it needs, and a
// reset back to the prepared morning between judges.
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNav } from '../app/nav';
import { useCharter } from '../stdb/client';

interface Step {
  label: string;
  db: string;
  hash: string;
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
  useEffect(() => {
    if (!info.demo) return;
    fetch('/__charter/demo/steps')
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
  const current = steps.findIndex(s => s.db === info.db && (s.hash === here || here.startsWith(`${s.hash}/`)));
  const open = (s: Step) => {
    if (s.db === info.db) window.location.hash = s.hash;
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
      <button type="button" className="demostep quiet" onClick={() => void reset()} disabled={!!busy} title="Back to the prepared morning (between judges)">
        <RotateCcw size={12} /> {busy || 'Reset'}
      </button>
    </nav>
  );
}
