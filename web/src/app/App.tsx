import { Moon, RefreshCw, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { day, ROLE_LABEL, weekday } from '../lib/format';
import { charter, useCharter } from '../stdb/client';
import { useRows, useStatus } from '../stdb/store';
import { useConfig, useOpenAskCount } from './data';
import { closeWhy, go, SCREENS, useNav, type Screen } from './nav';
import { effectiveDark, toggleTheme, useTheme } from './theme';
import { Floor } from '../screens/Floor';
import { Inbox } from '../screens/Inbox';
import { Knowledge } from '../screens/Knowledge';
import { Ledger } from '../screens/Ledger';
import { Security } from '../screens/Security';
import { Proof } from '../screens/Proof';
import { Payables } from '../screens/Payables';
import { World } from '../screens/World';
import { isPublic } from '../stdb/api';
import { Why } from '../screens/Why';
import { Toasts } from '../components/Toast';

const TITLES: Record<Screen, string> = {
  floor: 'Floor',
  inbox: 'Inbox',
  knowledge: 'Knowledge',
  ledger: 'Ledger',
  payables: 'Payables',
  world: 'World',
  security: 'Security',
  proof: 'Proof',
};

export function App() {
  const nav = useNav();
  const status = useStatus();
  useShortcuts();
  // Each screen starts at the top; the Why drawer keeps its own scroll.
  useEffect(() => {
    document.getElementById('main')?.scrollTo({ top: 0 });
  }, [nav.screen, nav.sub]);
  // Nothing renders from the tables until the first snapshot lands, so an empty
  // cache is never mistaken for an empty company.
  const ready = status.ready;
  return (
    <div className="shell">
      <Header screen={nav.screen} />
      <main className="page" id="main">
        <Connection />
        {ready && nav.screen === 'floor' && <Floor />}
        {ready && nav.screen === 'inbox' && <Inbox />}
        {ready && nav.screen === 'knowledge' && <Knowledge />}
        {ready && nav.screen === 'ledger' && <Ledger />}
        {ready && nav.screen === 'payables' && <Payables />}
        {ready && nav.screen === 'world' && !isPublic && <World />}
        {ready && nav.screen === 'security' && <Security />}
        {nav.screen === 'proof' && <Proof />}
      </main>
      {ready && nav.why !== null && <Why id={nav.why} />}
      <Toasts />
    </div>
  );
}

function Header({ screen }: { screen: Screen }) {
  const cfg = useConfig();
  const status = useStatus();
  const askCount = useOpenAskCount();
  useTheme();
  const dark = effectiveDark();
  return (
    <header className="header">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="7" fill="var(--taro)" />
          <path d="M8 11h16M8 16h16M8 21h10" stroke="var(--sheet)" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="23" cy="21" r="2.6" fill="var(--sheet)" />
        </svg>
        <div>
          <div className="brand-name">Charter</div>
          <div className="brand-co">{cfg?.companyName || 'connecting…'}</div>
        </div>
      </div>
      <CompanySwitcher />
      <nav className="nav" aria-label="Screens">
        {/* The public page has no world feeder, so no World screen. */}
        {SCREENS.filter(s => s !== 'world' || !isPublic).map(s => (
          <button key={s} className="nav-item" aria-current={screen === s ? 'page' : undefined} onClick={() => go(s)}>
            {TITLES[s]}
            {s === 'inbox' && <span className={`count ${askCount ? '' : 'zero'}`}>{askCount}</span>}
          </button>
        ))}
      </nav>
      <div className="header-right">
        <div className="bizdate" title="The organisation's business date">
          <b>{cfg ? day(cfg.simDate, true) : '—'}</b>
          <span>{cfg ? `${weekday(cfg.simDate)}${cfg.autopilot ? ', autopilot' : ''}` : ' '}</span>
        </div>
        <span className={`conn-dot ${status.state === 'live' ? 'live' : status.state === 'error' ? 'error' : ''}`} title={status.state === 'live' ? `Live on ${charter.info.db}` : status.error || status.state} />
        <button className="icon-btn" onClick={toggleTheme} aria-label={dark ? 'Use light theme' : 'Use dark theme'} title={dark ? 'Light theme' : 'Dark theme'}>
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <PersonaSwitcher />
      </div>
    </header>
  );
}

// On the public page: the companies a visitor can look at, one database each.
function CompanySwitcher() {
  const info = useCharter();
  if (info.companies.length < 2) return null;
  const open = (db: string) => {
    const u = new URL(window.location.href);
    u.searchParams.set('db', db);
    window.location.assign(u.toString());
  };
  return (
    <div className="companies" role="group" aria-label="Company">
      {info.companies.map(c => (
        <button key={c.db} type="button" className="btn small option" aria-pressed={c.db === info.db} onClick={() => open(c.db)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

function PersonaSwitcher() {
  const info = useCharter();
  if (!info.personas.length) return null;
  return (
    <div className="personas" role="group" aria-label="Act as">
      {info.personas.map((p, i) => {
        const r = p.persona.role;
        const pressed = info.active === p.persona.key;
        return (
          <button
            key={p.persona.key}
            className="persona"
            aria-pressed={pressed}
            onClick={() => charter.setActive(p.persona.key)}
            title={`${p.persona.name}: ${ROLE_LABEL[r] ?? r}${p.identity ? `\nidentity ${p.identity.slice(0, 18)}…` : ''}\nshortcut ${i + 1}${p.error ? `\n${p.error}` : ''}`}
          >
            <span className={`avatar ${r}`}>{r === 'outsider' ? '?' : p.persona.name.charAt(0)}</span>
            <span>
              <span className="persona-name">{p.persona.name}</span>
              {pressed && <span className="persona-role">{r === 'outsider' ? 'anyone' : r}</span>}
            </span>
            {p.state !== 'live' && <span className="state off" aria-label={p.state} />}
          </button>
        );
      })}
    </div>
  );
}

function Connection() {
  const status = useStatus();
  const info = useCharter();
  const principals = useRows('principal');
  // Personas whose identity the server no longer recognises (the company was reseeded).
  const unbound = status.ready
    ? info.personas.filter(p => p.persona.role !== 'outsider' && !principals.some(x => x.identity.toHexString().replace(/^0x/, '') === p.persona.identity.replace(/^0x/, '')))
    : [];
  const err = info.error || (status.state === 'error' ? status.error : '');
  if (err)
    return (
      <div className="page-inner" style={{ paddingBottom: 0 }}>
        <div className="banner error" role="alert">
          <div>
            <b>Cannot show {info.db || 'the database'}.</b> {err}
            <div className="muted" style={{ marginTop: 4 }}>
              Start SpacetimeDB locally (spacetime start) and check the database name; add ?db=charter-a to the address to switch.
            </div>
          </div>
          {info.managed && (
            <button className="btn small" onClick={() => void charter.rebind()}>
              <RefreshCw size={13} /> Rebind personas
            </button>
          )}
        </div>
      </div>
    );
  if (info.warning && status.ready)
    return (
      <div className="page-inner" style={{ paddingBottom: 0 }}>
        <div className="banner" role="status">
          <div style={{ flex: 1 }}>
            <b>Read-only.</b> <span className="muted">{info.warning}</span>
          </div>
          <button className="btn small" onClick={() => window.location.reload()}>
            <RefreshCw size={13} /> Reload identities
          </button>
        </div>
      </div>
    );
  if (unbound.length)
    return (
      <div className="page-inner" style={{ paddingBottom: 0 }}>
        <div className="banner" role="status">
          <div style={{ flex: 1 }}>
            <b>{unbound.map(p => p.persona.name).join(', ')} {unbound.length === 1 ? 'is' : 'are'} not bound in {info.db}.</b>{' '}
            <span className="muted">The company was probably reseeded; the kernel will refuse their actions until they are bound again.</span>
          </div>
          {info.managed ? (
            <button className="btn small" onClick={() => void charter.rebind()}>
              <RefreshCw size={13} /> Rebind personas
            </button>
          ) : (
            <button className="btn small" onClick={() => window.location.reload()}>
              <RefreshCw size={13} /> Reload identities
            </button>
          )}
        </div>
      </div>
    );
  if (!status.ready)
    return (
      <div className="page-inner">
        <div className="empty">
          <b>Opening the books…</b>
          {info.db ? `subscribing to ${info.db}` : 'finding the database'}
        </div>
      </div>
    );
  return null;
}

function useShortcuts() {
  const nav = useNav();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' && nav.why !== null) {
        closeWhy();
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= 9) {
        const p = charter.info.personas[n - 1];
        if (p) charter.setActive(p.persona.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav.why]);
}
