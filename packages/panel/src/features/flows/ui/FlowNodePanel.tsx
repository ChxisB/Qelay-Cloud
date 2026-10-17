import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDateTime } from '@/lib/format';
import {
  promoteAvailability,
  promoteBody,
  retryAvailability,
  retryBody,
} from '../domain/flowActions';
import { flowStateStyle } from '../domain/flowConstants';
import type { FlowTree } from '../domain/flowTree';
import type { FlowActionBody, FlowNode, FlowView } from '../domain/flowWire';

const CHILD_LIST_LIMIT = 10;

const MODE_TEXT: Record<string, string> = {
  fail: 'fails the parent',
  continue: 'parent continues',
  ignore: 'failure ignored',
  remove: 'removed on completion',
};

interface Props {
  view: FlowView;
  tree: FlowTree;
  node: FlowNode;
  canOperate: boolean;
  pending: boolean;
  onSelect: (id: string) => void;
  onAction: (body: FlowActionBody) => void;
}

/** The facts about the selected job, and what an operator can do about it. */
export function FlowNodePanel({
  view,
  tree,
  node,
  canOperate,
  pending,
  onSelect,
  onAction,
}: Props) {
  const children = tree.children.get(node.id) ?? [];
  const failures = view.failures.filter((failure) => failure.parentId === node.id);
  return (
    <aside aria-label="Selected job" aria-live="polite">
      <Card className="space-y-3 text-sm">
        <div>
          <div className="text-xs text-faint">Job</div>
          <div translate="no" className="break-all font-mono text-xs text-fg">
            {node.id}
          </div>
        </div>
        <Fact label="State">
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${flowStateStyle(node.state)}`}
          >
            {node.removed ? 'removed on completion' : node.state}
          </span>
        </Fact>
        <Fact label="Queue">{node.queue}</Fact>
        <Fact label="Attempts">{node.attempts}</Fact>
        <Fact label="Created">{formatDateTime(node.createdAt)}</Fact>
        {node.completedAt !== null && (
          <Fact label="Finished">{formatDateTime(node.completedAt)}</Fact>
        )}
        {node.mode && <Fact label="If it fails">{MODE_TEXT[node.mode] ?? node.mode}</Fact>}
        {node.blocking && (
          <p className="text-xs text-danger">
            It failed and holds its parent back until it is retried or released.
          </p>
        )}
        {node.parentId && (
          <Fact label="Parent">
            <button
              type="button"
              translate="no"
              onClick={() => onSelect(node.parentId as string)}
              disabled={!tree.byId.has(node.parentId)}
              className="break-all font-mono text-xs underline decoration-dotted enabled:hover:text-fg"
            >
              {node.parentId}
            </button>
          </Fact>
        )}
        <ChildList nodes={children} onSelect={onSelect} />
        {node.error && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface-2 p-2 text-xs text-danger">
            {node.error}
          </pre>
        )}
        {failures.map((failure) => (
          <p key={failure.childId} className="break-words text-xs text-warning">
            <span translate="no" className="font-mono">
              {failure.childId}
            </span>{' '}
            failed and the parent {failure.mode === 'ignore' ? 'ignores' : 'continues past'} it:{' '}
            {failure.error}
          </p>
        ))}
        <NodeActions
          key={node.id}
          tree={tree}
          node={node}
          canOperate={canOperate}
          pending={pending}
          onAction={onAction}
        />
        <Link
          to={`/job?id=${encodeURIComponent(node.id)}`}
          className="inline-block rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
        >
          Open in Job Inspector
        </Link>
      </Card>
    </aside>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2">
      <span className="shrink-0 text-xs text-faint">{label}</span>
      <span className="min-w-0 break-all text-right text-fg">{children}</span>
    </div>
  );
}

function ChildList({
  nodes,
  onSelect,
}: {
  nodes: readonly FlowNode[];
  onSelect: (id: string) => void;
}) {
  if (nodes.length === 0) return null;
  const shown = nodes.slice(0, CHILD_LIST_LIMIT);
  return (
    <div>
      <div className="mb-1 text-xs text-faint">
        {nodes.length} {nodes.length === 1 ? 'child' : 'children'}
      </div>
      <ul className="space-y-1">
        {shown.map((child) => (
          <li key={child.id}>
            <button
              type="button"
              translate="no"
              onClick={() => onSelect(child.id)}
              className="flex w-full items-center gap-2 text-left text-xs hover:text-fg"
            >
              <span
                className={`rounded-full border px-1.5 text-[10px] ${flowStateStyle(child.state)}`}
              >
                {child.removed ? 'removed' : child.state}
              </span>
              <span className="break-all font-mono">{child.id}</span>
            </button>
          </li>
        ))}
      </ul>
      {nodes.length > shown.length && (
        <p className="mt-1 text-xs text-faint">
          and {nodes.length - shown.length} more in the tree
        </p>
      )}
    </div>
  );
}

function NodeActions({
  tree,
  node,
  canOperate,
  pending,
  onAction,
}: Pick<Props, 'tree' | 'node' | 'canOperate' | 'pending' | 'onAction'>) {
  const [confirming, setConfirming] = useState(false);
  const retry = retryAvailability(tree, node);
  const promote = promoteAvailability(tree, node);
  const isParent = node.state === 'waiting-children';
  if (!canOperate || (node.state !== 'failed' && !isParent)) return null;
  const why =
    node.state === 'failed' ? (retry.ok ? null : retry.reason) : promote.ok ? null : promote.reason;

  return (
    <div className="space-y-2 border-t border-line pt-3">
      {node.state === 'failed' && (
        <Button
          size="sm"
          variant="primary"
          disabled={!retry.ok || pending}
          onClick={() => onAction(retryBody([node]))}
        >
          Retry this job
        </Button>
      )}
      {isParent && !confirming && (
        <Button size="sm" disabled={!promote.ok || pending} onClick={() => setConfirming(true)}>
          Release this parent
        </Button>
      )}
      {isParent && confirming && (
        <div role="group" aria-label="Confirm release" className="space-y-2 text-xs text-muted">
          <p>
            The parent runs now. Its failed children stay failed and its processor reads them as
            ignored.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                onAction(promoteBody(tree, node));
              }}
            >
              Release parent
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {why && <p className="text-xs text-faint">{why}</p>}
    </div>
  );
}
