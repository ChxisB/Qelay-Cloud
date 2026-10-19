import type { DeploymentResponse, DeploymentWarning } from '../opsTypes';
import { spoken } from './tick';

/** Connection use at which the page warns, and at which it calls it critical. */
export const CONNECTIONS_WARN_RATIO = 0.8;
export const CONNECTIONS_CRITICAL_RATIO = 0.95;

type Parts = Pick<
  DeploymentResponse,
  'devToken' | 'schema' | 'database' | 'transport' | 'connections' | 'tick' | 'doorbells'
> & {
  /** Webhooks failing (alert level 1 to 3) and paused, or null when they could not be read. */
  readonly webhooks: { readonly failing: number; readonly paused: number } | null;
};

/**
 * What an operator should look at first, from the readings alone. Each warning has a stable `code`.
 * A reading that is unknown produces a warning only where not knowing is itself the problem (the
 * tick, the database); it never produces a "healthy" nor a "zero".
 */
export function deploymentWarnings(parts: Parts): DeploymentWarning[] {
  const found: DeploymentWarning[] = [];
  const add = (code: string, severity: DeploymentWarning['severity'], message: string): void => {
    found.push({ code, severity, message });
  };
  const { tick, schema, connections, doorbells } = parts;

  if (parts.database.state === 'failed') {
    add('database_unreachable', 'critical', 'The database did not answer.');
  }
  if (parts.transport.state === 'failed') {
    add(
      'transport_unreachable',
      'critical',
      `The ${parts.transport.name} broker was unreachable the last time it was used. Jobs still run from the database; the tick rings them when the broker is back.`
    );
  }
  if (tick.state === 'never') {
    add('tick_never_ran', 'critical', 'No maintenance tick has completed yet.');
  } else if (tick.state === 'stale') {
    add(
      'tick_stale',
      'critical',
      `No tick has completed in the last ${spoken(tick.staleAfterMs)}. Delayed jobs, retries and lost doorbells are not being handled.`
    );
  } else if (tick.state === 'late') {
    add(
      'tick_late',
      'warning',
      `The last tick completed more than ${spoken(tick.lateAfterMs)} ago.`
    );
  } else if (tick.state === 'unknown') {
    add('tick_unknown', 'warning', "The tick's state could not be read.");
  }
  if (schema.state === 'ahead') {
    add(
      'schema_ahead',
      'warning',
      `The database schema (version ${schema.current}) is newer than this build expects (version ${schema.expected}). Expected during a rolling deploy; otherwise an older build is running.`
    );
  } else if (schema.state === 'behind') {
    add(
      'schema_behind',
      'critical',
      `The database schema (version ${schema.current}) is older than this build expects (version ${schema.expected}). Run the migrations.`
    );
  }
  if (connections.inUse !== null && connections.maxConnections !== null) {
    const ratio = connections.inUse / connections.maxConnections;
    if (ratio >= CONNECTIONS_CRITICAL_RATIO) {
      add(
        'connections_exhausted',
        'critical',
        `${connections.inUse} of ${connections.maxConnections} database connections are in use.`
      );
    } else if (ratio >= CONNECTIONS_WARN_RATIO) {
      add(
        'connections_high',
        'warning',
        `${connections.inUse} of ${connections.maxConnections} database connections are in use.`
      );
    }
  }
  if (
    connections.needed !== null &&
    connections.maxConnections !== null &&
    connections.needed > connections.maxConnections
  ) {
    add(
      'connection_budget_exceeded',
      'critical',
      `The declared fleet needs ${connections.needed} database connections but max_connections is ${connections.maxConnections}.`
    );
  }
  if (doorbells.oldestNotRungAgeMs !== null && doorbells.oldestNotRungAgeMs >= tick.lateAfterMs) {
    add(
      'doorbells_overdue',
      doorbells.oldestNotRungAgeMs >= tick.staleAfterMs ? 'critical' : 'warning',
      `Claimable jobs have waited ${spoken(doorbells.oldestNotRungAgeMs)} for a doorbell: the tick is behind.`
    );
  }
  if (parts.webhooks !== null && parts.webhooks.paused > 0) {
    add(
      'webhook_paused',
      'warning',
      `${parts.webhooks.paused} webhook(s) were paused after repeated failed deliveries. Fix the receiver, then enable them again; deliveries made meanwhile are held for a day.`
    );
  }
  if (parts.webhooks !== null && parts.webhooks.failing > 0) {
    add(
      'webhook_failing',
      'warning',
      `${parts.webhooks.failing} webhook(s) have many failed deliveries in a row and will be paused if it continues.`
    );
  }
  if (parts.devToken) {
    add(
      'dev_token_enabled',
      'warning',
      'The development token is enabled. Use OIDC for anything shared or exposed.'
    );
  }
  return found;
}
