#!/usr/bin/env bun
import { resolve } from 'node:path';
import { PanelConfigError } from '../src/lib/panelConfig';
import { settingsFromEnv } from './config';
import { loadBuild } from './files';
import { createPanelHandler } from './server';

/**
 * Serves the built panel. `QCLOUD_PANEL_DIST` names the build (default `../dist`). Exit 2 for a
 * configuration the panel cannot run with, so a bad rollout fails its startup probe.
 */
try {
  const settings = settingsFromEnv(process.env);
  const dist = resolve(process.env.QCLOUD_PANEL_DIST ?? `${import.meta.dir}/../dist`);
  const handler = createPanelHandler({ build: loadBuild(dist), settings });
  const server = Bun.serve({
    hostname: settings.hostname,
    port: settings.port,
    fetch: handler,
  });
  console.error(
    JSON.stringify({
      level: 'info',
      msg: 'listening',
      port: server.port,
      mount: settings.mount,
      auth: settings.config.auth.mode,
    })
  );
  const stop = () => void server.stop(true).then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (error) {
  if (error instanceof PanelConfigError) {
    console.error(`${error.name}: ${error.message}`);
    process.exit(2);
  }
  throw error;
}
