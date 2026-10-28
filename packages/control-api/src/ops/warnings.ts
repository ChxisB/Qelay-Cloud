import type { BackupMechanism } from '@qelay-cloud/store-postgres';
import type { DeploymentResponse, DeploymentWarning } from '../opsTypes';
import { spoken } from './tick';

/** Connection use at which the page warns, and at which it calls it critical. */
export const CONNECTIONS_WARN_RATIO = 0.8;
export const CONNECTIONS_CRITICAL_RATIO = 0.95;

type Parts = Pick<
  DeploymentResponse,
  'devToken' | 'schema' | 'database' | 'transport' | 'connections' | 'tick' | 'doorbells'
> & {
  /**
   * What the tick has to do on time. Each count is null when it could not be read, and then says nothing.
   * `tickIntervalMs` is what the deployer declared (the scheduler's period), or null.
   */
  readonly timing: {
    readonly tickIntervalMs: number | null;
    /** Enabled routes that hold their events for a schedule. */
    readonly scheduledRoutes: number | null;
    /** Enabled routes whose delay is shorter than the tick's period. */
    readonly shortDelayRoutes: number | null;
    /** Queues outside their run window now. */
    readonly closedWindows: number | null;
  };
  /** Webhooks failing (alert level 1 to 3) and paused, or null when they could not be read. */
  readonly webhooks: { readonly failing: number; readonly paused: number } | null;
  /** What the operator declared for backups (D18): a mechanism, `undeclared`, or null when it could not be read. */
  readonly backup: BackupMechanism | 'undeclared' | null;
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
      `The ${parts.transport.name} queue service was unreachable the last time it was used. Jobs still run from the database; maintenance tells workers about them when it is back.`
    );
  }
  if (tick.state === 'never') {
    add('tick_never_ran', 'critical', 'No maintenance run has completed yet.');
  } else if (tick.state === 'stale') {
    add(
      'tick_stale',
      'critical',
      `No maintenance run has completed in the last ${spoken(tick.staleAfterMs)}. Delayed jobs, retries and missed worker notifications are not being handled.`
    );
  } else if (tick.state === 'late') {
    add(
      'tick_late',
      'warning',
      `The last maintenance run completed more than ${spoken(tick.lateAfterMs)} ago.`
    );
  } else if (tick.state === 'unknown') {
    add('tick_unknown', 'warning', "Maintenance's state could not be read.");
  }
  // shortcut: sending turned off in the tick's own settings (QCLOUD_WEBHOOK_BATCH=0) is not visible here; only a tick that is not running is.
  const noTick = tick.state === 'never' || tick.state === 'stale';
  const { timing } = parts;
  if (noTick && timing.scheduledRoutes !== null && timing.scheduledRoutes > 0) {
    add(
      'schedule_without_sender',
      'warning',
      `${timing.scheduledRoutes} route(s) hold events for a schedule, and the sender that releases them runs in maintenance, which is not running. Nothing is sent at the scheduled time.`
    );
  }
  if (noTick && timing.closedWindows !== null && timing.closedWindows > 0) {
    add(
      'window_without_tick',
      'warning',
      `${timing.closedWindows} queue(s) are outside their run window, and maintenance, which rings them when it opens, is not running. Their jobs stay waiting after the window opens.`
    );
  }
  if (
    timing.tickIntervalMs !== null &&
    timing.shortDelayRoutes !== null &&
    timing.shortDelayRoutes > 0
  ) {
    add(
      'delay_finer_than_tick',
      'warning',
      `${timing.shortDelayRoutes} route(s) delay events by less than the maintenance period (${spoken(timing.tickIntervalMs)}): they are sent up to one period late. Run maintenance more often, or set a longer delay.`
    );
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
      `Jobs ready to run have waited ${spoken(doorbells.oldestNotRungAgeMs)} for workers to be told: maintenance is behind.`
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
  if (parts.backup === 'undeclared') {
    add(
      'backup_undeclared',
      'warning',
      'No backup mechanism is declared. Say how this database is backed up on the Backups page, even if the answer is your own tooling.'
    );
  } else if (parts.backup === 'none') {
    add('backup_none', 'warning', 'This database is declared as not backed up.');
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
