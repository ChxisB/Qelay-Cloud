/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the qelay HTTP server, e.g. https://queue.example.com. Empty → use the dev proxy at /api. */
  readonly VITE_QELAY_URL?: string;
  /** Origin of the control agent (start/stop/restart). Defaults to http://localhost:6800. */
  readonly VITE_QELAY_AGENT_URL?: string;
  /** `1` builds the in-app Copilot; it is off in every official build. */
  readonly VITE_ENABLE_COPILOT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
