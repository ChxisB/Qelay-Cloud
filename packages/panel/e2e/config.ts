export const E2E_BASE_PATH = '/e2e/dashboard';
export const E2E_VIEWER_BASE_PATH = '/e2e/viewer';
export const E2E_LOOPBACK_HOST = '127.0.0.1';
export const E2E_DASHBOARD_PORT = 49380;
export const E2E_CONTROL_PORT = 49381;
/** The Control API an operator signs in to. The panel reaches it through its own `/api`. */
export const E2E_API_PORT = 49382;
/** A second Control API over the same database whose only credential is a viewer's. */
export const E2E_VIEWER_API_PORT = 49385;

export const E2E_ORIGIN = `http://${E2E_LOOPBACK_HOST}:${E2E_DASHBOARD_PORT}`;
export const E2E_APP_URL = `${E2E_ORIGIN}${E2E_BASE_PATH}`;
export const E2E_VIEWER_URL = `${E2E_ORIGIN}${E2E_VIEWER_BASE_PATH}`;
export const E2E_CONTROL_URL = `http://${E2E_LOOPBACK_HOST}:${E2E_CONTROL_PORT}`;

// Test-only values bound exclusively to disposable loopback listeners. The Control API refuses a
// development token shorter than 24 characters.
export const E2E_SERVER_TOKEN = 'browser-e2e-server-token';
export const E2E_VIEWER_TOKEN = 'browser-e2e-viewer-token-0123';
export const E2E_CONTROL_TOKEN = 'browser-e2e-control-token';
export const E2E_SEED_QUEUE = 'browser-e2e-seed';
/** The name of the worker `POST /worker/start` runs, as the Workers page lists it. */
export const E2E_WORKER_NAME = 'e2e-worker';
/** What the Control API reports as its version, and the Diagnostics page shows. */
export const E2E_VERSION = '1.0.0-e2e';

/**
 * The e2e tick is fast and its thresholds are small, so the Dashboard strip can be seen to go
 * amber and red in seconds. The panel polls every 3 s, which is why late and stale are further
 * apart than one poll.
 */
export const E2E_TICK_INTERVAL_MS = 1_000;
export const E2E_TICK_LATE_AFTER_MS = 4_000;
export const E2E_TICK_STALE_AFTER_MS = 9_000;
