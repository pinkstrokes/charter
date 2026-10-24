import { ShieldCheck } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { Activity } from '../module_bindings/types';
import { useActivityDesc } from '../app/data';
import { openWhy, useNav } from '../app/nav';
import { commandLabel, day } from '../lib/format';
import { parseArr, parseObj } from '../lib/json';
import { spokenWords, summarize } from '../lib/summary';
import { store } from '../stdb/store';
import { ActorTag, OutcomeChip } from './ui';
import { ChainBadge } from './Chain';

type Filter = 'all' | 'stopped' | 'people' | 'seats' | 'asks';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'stopped', label: 'Stopped' },
  { key: 'people', label: 'People' },
  { key: 'seats', label: 'Seats' },
  { key: 'asks', label: 'Asks' },
];

function passes(a: Activity, f: Filter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'stopped':
      return a.outcome === 'denied' || a.outcome === 'rejected';
    case 'people':
      return a.principal.startsWith('controller:') || a.principal.startsWith('consultant:');
    case 'seats':
      return a.principal.startsWith('seat:');
    case 'asks':
      return a.kind === 'ask' || a.command === 'answer_ask';
  }
}

export function Feed({ title = 'Activity', filterRows, compact }: { title?: string; filterRows?: (a: Activity) => boolean; compact?: boolean }) {
  const all = useActivityDesc();
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(150);
  const nav = useNav();
  const rows = useMemo(() => all.filter(a => (!filterRows || filterRows(a)) && passes(a, filter)), [all, filter, filterRows]);
  // Runs of routine rows (same actor, same command, same outcome, same day) fold into one line.
  const items = useMemo(() => {
    const out: ({ kind: 'row'; a: Activity } | { kind: 'group'; key: string; rows: Activity[] })[] = [];
    let i = 0;
    while (i < rows.length) {
      const a = rows[i];
      let j = i + 1;
      const routine = a.outcome !== 'denied' && a.outcome !== 'rejected' && a.kind !== 'ask';
      while (routine && j < rows.length && rows[j].principal === a.principal && rows[j].command === a.command && rows[j].outcome === a.outcome && rows[j].at === a.at) j++;
      if (j - i >= 3) out.push({ kind: 'group', key: `${a.id}-${rows[j - 1].id}`, rows: rows.slice(i, j) });
      else for (let k = i; k < j; k++) out.push({ kind: 'row', a: rows[k] });
      i = j;
    }
    return out;
  }, [rows]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const stoppedCount = useMemo(() => all.filter(a => a.outcome === 'denied' || a.outcome === 'rejected').length, [all]);
  return (
    <section className="sheet feed" aria-label={title} style={{ maxHeight: compact ? 420 : 'calc(100vh - var(--header-h) - 34px)' }}>
      <div className="feed-head">
        <h2 className="section-title">{title}</h2>
        <ChainBadge />
        <div className="feed-filters" role="group" aria-label="Filter activity">
          {FILTERS.map(f => (
            <button key={f.key} className="feed-filter" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {f.key === 'stopped' && stoppedCount > 0 ? ` ${stoppedCount}` : ''}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <b>{filter === 'stopped' ? 'Nothing stopped yet' : 'No activity yet'}</b>
          {filter === 'stopped' ? 'Denied and rejected attempts land here, on the record, with the rule that stopped them.' : 'Every command, allowed or not, is written here as it happens.'}
        </div>
      ) : (
        <ol className="feed-list">
          {items.slice(0, limit).map(it =>
            it.kind === 'row' ? (
              <FeedRow key={it.a.id.toString()} a={it.a} selected={nav.why === it.a.id} />
            ) : openGroups.has(it.key) ? (
              it.rows.map(a => <FeedRow key={a.id.toString()} a={a} selected={nav.why === a.id} />)
            ) : (
              <FeedGroup key={it.key} rows={it.rows} onOpen={() => setOpenGroups(g => new Set(g).add(it.key))} />
            )
          )}
          {items.length > limit && (
            <li className="feed-more">
              <button className="btn small quiet" onClick={() => setLimit(l => l + 300)}>
                Show older ({items.length - limit} more)
              </button>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

const FeedRow = memo(function FeedRow({ a, selected }: { a: Activity; selected: boolean }) {
  const stopped = a.outcome === 'denied' || a.outcome === 'rejected';
  const live = store.liveActivity.get(a.id);
  const fresh = live !== undefined && Date.now() - live < 2500;
  const reasons = stopped ? parseArr<string>(a.reasons) : [];
  const words = spokenWords(a);
  return (
    <li
      className={`feed-row ${stopped ? 'stopped' : ''} ${selected ? 'selected' : ''} ${fresh ? 'fresh' : ''}`}
      onClick={() => openWhy(a.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openWhy(a.id);
        }
      }}
      tabIndex={0}
      aria-label={`${commandLabel(a.kind, a.command)}, ${a.outcome}, number ${a.id}`}
    >
      <div className="feed-id">
        <b>#{a.id.toString()}</b>
        {day(a.at)}
      </div>
      <div className="feed-main">
        <div className="feed-line">
          <span className="feed-cmd">{commandLabel(a.kind, a.command)}</span>
          <span className="feed-sum">{summarize(a)}</span>
        </div>
        <div className="feed-who">
          <ActorTag principal={a.principal} role={a.role} />
          {stopped && reasons[0] && <span className="feed-reason">{reasons[0]}</span>}
          {!stopped && words && <span className="feed-quote">“{words.text}”</span>}
        </div>
      </div>
      <div>
        <OutcomeChip outcome={a.outcome} />
      </div>
    </li>
  );
});

// A run of identical routine actions, folded; click to see each one.
function FeedGroup({ rows, onOpen }: { rows: Activity[]; onOpen: () => void }) {
  const a = rows[0];
  const subjects = [
    ...new Set(
      rows
        .map(r => {
          const p = parseObj(r.params);
          return String(p.entity ?? p.entityCode ?? p.store ?? p.id ?? p.receiptId ?? '');
        })
        .filter(Boolean)
    ),
  ];
  return (
    <li className="feed-row" onClick={onOpen} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onOpen()} tabIndex={0} aria-label={`${rows.length} ${commandLabel(a.kind, a.command)} rows, folded`}>
      <div className="feed-id">
        <b>×{rows.length}</b>
        {day(a.at)}
      </div>
      <div className="feed-main">
        <div className="feed-line">
          <span className="feed-cmd">{commandLabel(a.kind, a.command)}</span>
          <span className="feed-sum">
            {subjects.length ? `${subjects.slice(0, 6).join(', ')}${subjects.length > 6 ? ` and ${subjects.length - 6} more` : ''}` : summarize(a)}
            {a.command === 'hold_collection' ? `: ${parseArr<string>(a.reasons)[0] ?? ''}` : ''}
          </span>
        </div>
        <div className="feed-who">
          <ActorTag principal={a.principal} role={a.role} />
          <span className="faint">#{rows[rows.length - 1].id.toString()} to #{a.id.toString()}, folded</span>
        </div>
      </div>
      <div>
        <OutcomeChip outcome={a.outcome} />
      </div>
    </li>
  );
}

export function NothingStopped() {
  return (
    <span className="row muted">
      <ShieldCheck size={14} /> nothing stopped
    </span>
  );
}
