// A short confirmation for actions whose card disappears once they succeed
// (an answered question leaves the inbox). Errors stay inline, next to the
// button that caused them; this only says what was recorded.
import { Check, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { openWhy } from '../app/nav';

interface Toast {
  id: number;
  text: string;
  activityId?: bigint;
  tone: 'ok' | 'stop';
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(fn => fn());
}

export function toast(text: string, activityId?: bigint, tone: Toast['tone'] = 'ok'): void {
  const t = { id: next++, text, activityId, tone };
  toasts = [...toasts.slice(-2), t];
  emit();
  setTimeout(() => {
    toasts = toasts.filter(x => x.id !== t.id);
    emit();
  }, 5200);
}

export function Toasts() {
  const list = useSyncExternalStore(
    fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => toasts
  );
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map(t => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.tone === 'ok' ? <Check size={14} /> : <X size={14} />}
          <span>{t.text}</span>
          {t.activityId !== undefined && (
            <button className="link" onClick={() => openWhy(t.activityId!)}>
              #{t.activityId.toString()}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
