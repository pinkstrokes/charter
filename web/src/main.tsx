import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-serif/latin-400-italic.css';
import '@fontsource/ibm-plex-serif/latin-500-italic.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { initTheme } from './app/theme';
import { charter } from './stdb/client';
import { act } from './stdb/actions';
import { store } from './stdb/store';

initTheme();
void charter.start();

// Generated bindings that no longer match the published module fail while
// decoding rows. Say so plainly instead of leaving a half-empty page.
function schemaDrift(message: string): boolean {
  if (!/Tried to read \d+ byte|out of bounds|Invalid (tag|variant)|unknown table/i.test(message)) return false;
  store.setStatus({ state: 'error', error: `this page's bindings do not match the module running on ${charter.info.db}. Run npm run generate in web/ and reload.` });
  return true;
}
window.addEventListener('error', e => {
  if (schemaDrift(String(e.message ?? e.error ?? ''))) e.preventDefault();
});
window.addEventListener('unhandledrejection', e => {
  if (schemaDrift(String((e.reason as Error)?.message ?? e.reason ?? ''))) e.preventDefault();
});

// Handles for poking at the live connection from the devtools console during development.
if (import.meta.env.DEV) Object.assign(window, { __charter: { charter, store, act } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
