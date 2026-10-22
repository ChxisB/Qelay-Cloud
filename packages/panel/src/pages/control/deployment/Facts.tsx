import type { ReactNode } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Meter } from '@/components/ui/charts/HBars';
import { StatusPill, type StateRole } from '@/components/ui/StatusBadge';
import { Wash } from '@/components/ui/Wash';
import { formatDateTime } from '@/lib/format';
import { ago, figure, span } from '@/lib/ops/health';
import type { DeploymentView } from '@/lib/ops/types';

/** `steady` is for an age or a timing that moves on every poll: it updates without the wash. */
function Row({
  label,
  children,
  steady,
}: {
  label: string;
  children: ReactNode;
  steady?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="tnum text-right text-[13px] font-semibold text-fg">
        {typeof children === 'string' ? <Wash value={children} steady={steady} /> : children}
      </dd>
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
  never: 'Never ran',
  unknown: 'Unknown',
} as const;
const TICK_NOTE = {
  never: 'Has not run since this server started',
  unknown: 'Unknown: no maintenance run is reporting to this server',
} as const;

// A state is a pill (glyph and word) so it never rests on colour.
const CHECK_STATE: Record<keyof typeof CHECK, StateRole> = {
  ok: 'completed',
  failed: 'failed',
  unknown: 'waiting',
};
const TICK_STATE: Record<keyof typeof TICK, StateRole> = {
  ok: 'completed',
  late: 'delayed',
  stale: 'failed',
  never: 'failed',
  unknown: 'waiting',
};

// The date washes if it changes; "12s ago" moves on every poll and updates without the wash.
function when(at: number | null): ReactNode {
  return at === null ? (
    'never'
  ) : (
    <>
      <Wash value={formatDateTime(at)} /> ({ago(Date.now() - at)})
    </>
  );
}

/** The numbers behind the warnings, one card per part of the deployment. */
export function Facts({ deployment }: { deployment: DeploymentView }) {
  const { schema, database, transport, connections, tick, workers, doorbells } = deployment;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Build" sub="What this server is running." />
        <dl className="divide-y divide-line">
          <Row label="Version">{deployment.version}</Row>
          <Row label="Commit">{deployment.commit ?? 'not declared'}</Row>
          <Row label="Mode">{deployment.production ? 'Production' : 'Development'}</Row>
          <Row label="Development token">{deployment.devToken ? 'Enabled' : 'Disabled'}</Row>
        </dl>
      </Card>
      <Card>
        <CardHeader
          title="Database"
          sub="Whether it answers and whether its schema fits this build."
        />
        <dl className="divide-y divide-line">
          <Row label="State">
            <StatusPill state={CHECK_STATE[database.state]}>{CHECK[database.state]}</StatusPill>
          </Row>
          <Row label="Response time" steady>
            {span(database.latencyMs)}
          </Row>
          <Row label="Schema">{SCHEMA[schema.state]}</Row>
          <Row label="Migration">
            {`${figure(schema.current)} recorded, ${schema.expected} expected by this build`}
          </Row>
        </dl>
      </Card>
      <Card>
        <CardHeader
          title="Maintenance"
          sub="The background job that repairs stuck work and tells workers about ready jobs."
        />
        <dl className="divide-y divide-line">
          <Row label="State">
            <StatusPill state={TICK_STATE[tick.state]}>{TICK[tick.state]}</StatusPill>
            {(tick.state === 'never' || tick.state === 'unknown') && (
              <span className="mt-1 block text-[13px] font-normal text-muted">
                {TICK_NOTE[tick.state]}
              </span>
            )}
          </Row>
          <Row label="Last success">{when(tick.lastSuccessAt)}</Row>
          <Row label="Last failure">{when(tick.lastFailureAt)}</Row>
          <Row label="Late after">{span(tick.lateAfterMs)}</Row>
          <Row label="Stalled after">{span(tick.staleAfterMs)}</Row>
        </dl>
      </Card>
      <Card>
        <CardHeader
          title="Worker notifications"
          sub="Jobs that are ready to run but workers have not been told about yet."
        />
        <dl className="divide-y divide-line">
          <Row label="Queue service">
            {transport.name}:{' '}
            <StatusPill state={CHECK_STATE[transport.state]}>{CHECK[transport.state]}</StatusPill>
          </Row>
          <Row label="Ready but not notified">{figure(doorbells.notRung)}</Row>
          <Row label="Oldest of them" steady>
            {span(doorbells.oldestNotRungAgeMs)}
          </Row>
          <Row label="Queues scanned">
            {`${figure(doorbells.queuesScanned)}${doorbells.partial ? ' (partial: more have pending jobs)' : ''}`}
          </Row>
        </dl>
      </Card>
      <Card>
        <CardHeader title="Connections" sub="Database connections in use." />
        <dl className="divide-y divide-line">
          <Row label="In use">
            {`${figure(connections.inUse)} of ${figure(connections.maxConnections)}`}
          </Row>
        </dl>
        {/* A list holds only term and value groups, so the bar sits between two lists. */}
        {connections.inUse !== null && connections.maxConnections ? (
          <div className="border-t border-line py-3">
            <Meter
              value={connections.inUse}
              max={connections.maxConnections}
              tone="active"
              label="Connections in use"
            />
          </div>
        ) : null}
        <dl className="border-t border-line">
          <Row label="Declared fleet needs">
            {connections.needed === null
              ? 'not declared'
              : `${figure(connections.needed)} (${connections.mode ?? 'unknown'})`}
          </Row>
        </dl>
      </Card>
      <Card>
        <CardHeader title="Workers" sub="Processes registered to claim jobs." />
        <dl className="divide-y divide-line">
          <Row label="Registered">{figure(workers.total)}</Row>
          <Row label="Active">{figure(workers.active)}</Row>
        </dl>
      </Card>
    </div>
  );
}
