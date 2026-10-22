import { useState } from 'react';
import { Connector, INPUT_REACH } from '@/components/ui/nodegraph/Connector';
import { nodeIcon } from '@/components/ui/nodegraph/nodeIcons';
import { NodeTile } from '@/components/ui/nodegraph/NodeTile';
import { StatusGlyph, StatusBadge, type StateRole } from '@/components/ui/StatusBadge';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { stagger } from '@/lib/stagger';
import { useChangeFlash } from '@/lib/useChangeFlash';
import { useFirstLoad } from '@/lib/useFirstLoad';
import {
  CHAIN_GAP,
  CHAIN_NODE_WIDTH,
  CHAIN_TILE,
  isRollingBack,
  type NodeMark,
  nodeMark,
  recordedFor,
  returnPath,
  RETURN_DEPTH,
} from '../domain/definitionChain';
import { describeNode, isLiveState } from '../domain/workflowDisplay';
import type { WorkflowDetail } from '../domain/workflowWire';
import { NodeDetail } from './NodeDetail';

const MARK: Record<NodeMark, { role: StateRole; word: string }> = {
  done: { role: 'completed', word: 'Done' },
  current: { role: 'active', word: 'The run is here' },
  ahead: { role: 'waiting', word: 'Not reached' },
};

const ROLLBACK = {
  compensating:
    'This run is rolling back. It undoes the steps it has done, from the node it is at back to the first.',
  'compensation-stuck':
    'The rollback is stuck at this node. An operator has to retry it or abandon it.',
} as const;

/**
 * The shape of the workflow this run follows, read from the definition a worker announced: a chain of
 * nodes, the run's place marked, a dashed line back while it rolls back. A node opens its detail below. The
 * panel holds no definition of its own, so a run whose definition no worker announced shows none.
 */
export function DefinitionGraph({
  definition,
  currentNodeIndex,
  state,
  steps,
}: {
  definition: WorkflowDetail['definition'];
  currentNodeIndex: number;
  state: string;
  /** The first page of the run's recorded steps. */
  steps: WorkflowDetail['steps'];
}) {
  const [picked, setPicked] = useState<number | null>(null);
  // The nodes of the first load arrive in order; a poll that moves the run on only marks the node it reached.
  const firstLoad = useFirstLoad(definition !== null);
  if (!definition) {
    return (
      <p className="text-xs text-muted">
        No definition is recorded for this run. No worker announced the version it was started with.
      </p>
    );
  }
  const { graph } = definition;
  const open = picked ?? (isLiveState(state) ? currentNodeIndex : null);
  const node = open === null ? undefined : graph[open];
  const back = isRollingBack(state) ? returnPath(currentNodeIndex) : null;
  return (
    <div className="space-y-4">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
        <div className="flex gap-1">
          <dt className="text-muted">Version</dt>
          <dd translate="no" className="font-mono">
            {definition.hash.slice(0, 12)}
            {definition.revision ? ` · ${definition.revision}` : ''}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted">Last announced</dt>
          <dd>{formatDateTime(definition.lastSeenAt)}</dd>
        </div>
        <div>{definition.served ? <StatusBadge status="active" /> : null}</div>
      </dl>
      {!definition.served && (
        <p role="note" className="text-xs font-semibold text-warning">
          No worker serves this version now. A run on it cannot move until a worker that does is
          started.
        </p>
      )}
      {isRollingBack(state) && (
        <p role="note" className="text-[13px] leading-6 font-semibold text-fg">
          {ROLLBACK[state as keyof typeof ROLLBACK]}
        </p>
      )}
      <div className="node-canvas overflow-x-auto rounded-card border border-line p-6">
        <div className="md:w-max">
          <ol
            aria-label="Nodes of the workflow"
            className="flex flex-col items-center md:flex-row md:items-start"
          >
            {graph.map((item, index) => (
              <Cell
                key={index}
                index={index}
                firstLoad={firstLoad}
                node={item}
                mark={nodeMark(index, currentNodeIndex, state)}
                selected={open === index}
                first={index === 0}
                last={index === graph.length - 1}
                onPick={() => setPicked(index)}
              />
            ))}
          </ol>
          {back && (
            <svg
              aria-hidden="true"
              focusable="false"
              width={back.width}
              height={RETURN_DEPTH + 2}
              className="mt-1 hidden md:block"
            >
              <path
                d={back.line}
                fill="none"
                strokeWidth={2}
                strokeDasharray="6 5"
                className={state === 'compensation-stuck' ? 'stroke-danger' : 'stroke-warning'}
              />
              <path
                d={back.head}
                fill="none"
                strokeWidth={2}
                className={state === 'compensation-stuck' ? 'stroke-danger' : 'stroke-warning'}
              />
            </svg>
          )}
        </div>
      </div>
      {node && open !== null ? (
        <NodeDetail
          index={open}
          node={node}
          recorded={recordedFor(graph, open, steps.items)}
          moreSteps={steps.hasMore}
        />
      ) : (
        <p className="text-sm text-muted">
          Choose a node to see what it does and what it recorded.
        </p>
      )}
    </div>
  );
}

function Cell({
  index,
  firstLoad,
  node,
  mark,
  selected,
  first,
  last,
  onPick,
}: {
  index: number;
  firstLoad: boolean;
  node: Record<string, unknown>;
  mark: NodeMark | null;
  selected: boolean;
  first: boolean;
  last: boolean;
  onPick: () => void;
}) {
  const { kind, steps } = describeNode(node);
  const more = steps.length - 1;
  const reach = CHAIN_NODE_WIDTH - CHAIN_TILE + CHAIN_GAP;
  // Read once, at mount: dropping the class later would cut the rise short.
  const [place] = useState(firstLoad ? index : undefined);
  const flash = useChangeFlash(mark);
  return (
    <li
      aria-current={mark === 'current' ? 'step' : undefined}
      className={cn(
        'relative flex flex-col items-center md:items-start',
        place !== undefined && 'motion-arrive'
      )}
      style={{
        width: last ? CHAIN_NODE_WIDTH : CHAIN_NODE_WIDTH + CHAIN_GAP,
        ...(place === undefined ? {} : stagger(place)),
      }}
    >
      <NodeTile
        tile={CHAIN_TILE}
        width={CHAIN_NODE_WIDTH}
        icon={nodeIcon(kind)}
        trigger={first}
        output={!last}
        selected={selected}
        aria-pressed={selected}
        onClick={onPick}
        badge={mark && <StatusGlyph state={MARK[mark].role} small />}
        title={
          <>
            <span className="tnum text-faint">{index + 1}</span>{' '}
            <span className="capitalize">{kind}</span>
          </>
        }
        sub={
          mark && (
            <span key={flash} className={flash > 0 ? 'motion-flash' : undefined}>
              {MARK[mark].word}
            </span>
          )
        }
        note={
          steps[0] !== undefined && (
            <span translate="no" className="flex min-w-0 justify-center gap-1 font-mono">
              <span className="truncate">{steps[0]}</span>
              {more > 0 && (
                <span className="shrink-0">
                  +{more}
                  <span className="sr-only"> more</span>
                </span>
              )}
            </span>
          )
        }
      />
      {!last && (
        <>
          <span
            aria-hidden="true"
            className={cn('h-5 w-px bg-faint md:hidden', place !== undefined && 'motion-draw-y')}
          />
          <svg
            aria-hidden="true"
            focusable="false"
            width={reach}
            height={10}
            className="pointer-events-none absolute hidden md:block"
            style={{ left: (CHAIN_NODE_WIDTH + CHAIN_TILE) / 2, top: CHAIN_TILE / 2 - 5 }}
          >
            <Connector
              x1={0}
              y1={5}
              x2={reach - INPUT_REACH}
              y2={5}
              index={flash > 0 ? undefined : place}
              pulse={flash}
            />
          </svg>
        </>
      )}
    </li>
  );
}
