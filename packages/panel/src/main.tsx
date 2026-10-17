// Latin + latin-ext subsets only (see fonts.css) — the fontsource index
// imports pull cyrillic/greek/vietnamese woff2 the UI never renders.
import './fonts.css';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ConfigErrorScreen, SignInScreen } from './components/AuthScreens';
import { initTheme } from './components/dashboard/stores/themeStore';
import { useAuthStore } from './lib/auth/authStore';
import { bootPanel } from './lib/bootPanel';
import { bootDashboard } from './lib/demo/boot';
import { isDemo } from './lib/demo/isDemo';
import { resolveRouterBasename, runtimeConfigValue } from './lib/runtimeConfig';

initTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');
const root = createRoot(rootEl);

/** The app, unless an OpenID Connect sign-in owns the page and is not in a usable state. */
function Shell() {
  const managed = useAuthStore((s) => s.managed);
  const status = useAuthStore((s) => s.status);
  if (managed && status !== 'ready') return <SignInScreen />;
  return (
    <BrowserRouter
      basename={resolveRouterBasename(
        runtimeConfigValue('__QELAY_BASE_PATH__'),
        import.meta.env.BASE_URL
      )}
    >
      <App />
    </BrowserRouter>
  );
}

function render() {
  root.render(
    <StrictMode>
      <Shell />
    </StrictMode>
  );
}

// In demo mode, install the fetch/SSE shim BEFORE the first render so no request
// escapes to a (non-existent) server. The install module and its fixture load
// lazily, so they never weigh on the normal bundle. Outside demo mode the deployment's
// config.json is read, and an OpenID Connect sign-in completes, before the first render.
void bootDashboard({
  root: rootEl,
  demo: isDemo(),
  loadDemo: () => import('./lib/demo/install'),
  render: () => {
    void bootPanel({
      demo: isDemo(),
      pageUrl: document.baseURI,
      location: () => ({ pathname: window.location.pathname, search: window.location.search }),
    })
      .then((outcome) => {
        if (outcome === 'render') render();
      })
      .catch((error: unknown) => {
        root.render(
          <ConfigErrorScreen
            message={error instanceof Error ? error.message : 'The panel could not start.'}
          />
        );
      });
  },
});
