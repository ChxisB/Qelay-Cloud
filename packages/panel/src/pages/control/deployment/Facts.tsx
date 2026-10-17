import type { ReactNode } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { formatDateTime } from '@/lib/format';
import { ago, figure, span } from '@/lib/ops/health';
import type { DeploymentView } from '@/lib/ops/types';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="tnum text-right text-sm text-fg">{children}</dd>
    </div>
  );
}

const CHECK = { ok: 'Reachable', failed: 'Failed', unknown: 'Unknown' } as const;
const SCHEMA = {
  current: 'Current',
  behind: 'Behind this build: not migrated yet',
  ahead: 'Ahead of this build: a newer release migrated it',
  unknown: 'Unknown',
} as const;
const TICK = {
  ok: 'Running',
  late: 'Late',
  stale: 'Stalled',
  never: 'Has not run since this server started',
  unknown: 'Unknown: no tick is reporting to this server',
} as const;

function when(at: number | null): string {
  return at === null ? 'never' : `${formatDateTime(at)} (${ago(Date.now() - at)})`;
}

/** The numbers behind the warnings, one card per part of the deployment. */
export function Facts({ deployment }: { deployment: DeploymentView }) {
  const { schema, database, transport, connections, tick, workers, doorbells } = deployment;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Build" />
        <dl className="divide-y divide-line">
          <Row label="Version">{deployment.version}</Row>
          <Row label="Commit">{deployment.commit ?? 'not declared'}</Row>
          <Row label="Mode">{deployment.production ? 'Production' : 'Development'}</Row>
          <Row label="Development token">{deployment.devToken ? 'Enabled' : 'Disabled'}</Row>
        </dl>
      </Card>
      <Card>
        <CardHeader title="Database" />
        <dl className="divide-y divide-line">
          <Row label="State">{CHECK[database.state]}</Row>
          <Row label="Round trip">{span(database.latencyMs)}</Row>
          <Row label="Schema">{SCHEMA[schema.state]}</Row>
          <Row label="Migration">
            {figure(schema.current)} recorded, {schema.expected} expected by this build
          </Row>
        </dl>
      </Card>
      <Card>
        <CardHeader title="Tick" />
        <dl className="divide-y divide-line">
          <Row label="State">{TICK[tick.state]}</Row>
          <Row label="Last success">{when(tick.lastSuccessAt)}</Row>
          <Row label="Last failure">{when(tick.lastFailureAt)}</Row>
          <Row label="Late after">{span(tick.lateAfterMs)}</Row>
          <Row label="Stalled after">{span(tick.staleAfterMs)}</Row>
        </dl>
      </Card>
      <Card>
        <CardHeader title="Doorbells" />
        <dl className="divide-y divide-line">
          <Row label="Transport">
            {transport.name}: {CHECK[transport.state]}
          </Row>
          <Row label="Claimable without a bell">{figure(doorbells.notRung)}</Row>
          <Row label="Oldest of them">{span(doorbells.oldestNotRungAgeMs)}</Row>
          <Row label="Queues scanned">
            {figure(doorbells.queuesScanned)}
            {doorbells.partial ? ' (partial: more have pending jobs)' : ''}
          </Row>
        </dl>
      </Card>
      <Card>
        <CardHeader title="Connections" />
        <dl className="divide-y divide-line">
          <Row label="In use">
            {figure(connections.inUse)} of {figure(connections.maxConnections)}
          </Row>
          <Row label="Declared fleet needs">
            {connections.needed === null
              ? 'not declared'
              : `${figure(connections.needed)} (${connections.mode ?? 'unknown'})`}
          </Row>
        </dl>
      </Card>
      <Card>
        <CardHeader title="Workers" />
        <dl className="divide-y divide-line">
          <Row label="Registered">{figure(workers.total)}</Row>
          <Row label="Active">{figure(workers.active)}</Row>
        </dl>
      </Card>
    </div>
  );
}
