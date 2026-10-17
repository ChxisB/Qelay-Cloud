import type { Clock } from '@qelay-cloud/core';
import { STRICT_URL_POLICY } from '@qelay-cloud/core';
import { TtlCache } from '../cache';
import type { DashboardReader, JobsDeps } from '../deps';
import type { Logger } from '../http/log';
import type { Route } from '../http/router';
import type { JobsContext } from '../jobs/context';
import { producerFor } from '../jobs/context';
import { createDashboardReader } from '../jobs/dashboardReader';
import type { JobsConfig } from '../jobs/limits';
import { resolveJobsConfig } from '../jobs/limits';
import { addJobRoutes } from './addJob';
import { cronRoutes } from './crons';
import { dlqRoutes } from './dlq';
import { eventRoutes } from './events';
import { flowRoutes } from './flows';
import { jobActionRoutes } from './jobActions';
import { jobReadRoutes } from './jobs';
import { metricsRoutes } from './metrics';
import { queueConfigRoutes } from './queueConfig';
import { queueActionRoutes } from './queueOps';
import { queueReadRoutes } from './queues';
import { serverStatusRoutes } from './serverStatus';
import { unsupportedRoutes } from './unsupported';
import { webhookRoutes } from './webhooks';
import { workerRoutes } from './workers';
import { workflowRoutes } from './workflows';

export interface JobsModule {
  readonly routes: Route[];
  readonly dashboard: DashboardReader;
  readonly config: JobsConfig;
}

/**
 * The jobs and queues routes of one store: the dashboard reads, the queue and job lists, the job
 * inspector, the operator actions and add job, plus the 501s of the panel pages that do not apply.
 * Everything shares one `JobsContext`, so one cache and one set of producers per store. The DLQ,
 * queue settings, crons, workers, live events and metrics of task 32 are in the same module, and
 * so are the webhooks of task 52.
 */
export function jobsModule(
  deps: JobsDeps,
  env: { readonly clock: Clock; readonly logger: Logger }
): JobsModule {
  const config = resolveJobsConfig(deps.options);
  const ctx: JobsContext = {
    store: deps.store,
    transport: deps.transport,
    config,
    clock: env.clock,
    logger: env.logger,
    cache: new TtlCache(config.summaryCacheMs, env.clock),
    producer: producerFor(deps.store, deps.transport, env.logger),
  };
  const dashboard = createDashboardReader(ctx, env.clock.now());
  return {
    config,
    dashboard,
    routes: [
      ...queueReadRoutes(ctx),
      ...queueActionRoutes(ctx),
      ...jobReadRoutes(ctx),
      ...jobActionRoutes(ctx),
      ...addJobRoutes(ctx),
      ...dlqRoutes(ctx),
      ...queueConfigRoutes(ctx),
      ...cronRoutes(ctx),
      ...webhookRoutes(ctx, deps.webhookUrlPolicy ?? STRICT_URL_POLICY),
      ...workerRoutes(ctx),
      ...eventRoutes(ctx),
      ...flowRoutes(ctx),
      ...workflowRoutes(ctx),
      ...metricsRoutes(ctx, dashboard),
      ...serverStatusRoutes(ctx),
      ...unsupportedRoutes(),
    ],
  };
}
