import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/form';
import { removeAvailability, removeBody, retryableNodes, retryBody } from '../domain/flowActions';
import type { FlowTree } from '../domain/flowTree';
import type { FlowActionBody, FlowActionName, FlowView } from '../domain/flowWire';

interface Props {
  view: FlowView;
  tree: FlowTree;
  pending: FlowActionName | null;
  onAction: (body: FlowActionBody) => void;
}

/** What can be done to the flow as a whole. Shown to operators only; the server decides all the same. */
export function FlowActionsBar({ view, tree, pending, onAction }: Props) {
  const [removing, setRemoving] = useState(false);
  const [typed, setTyped] = useState('');
  const failed = retryableNodes(tree);
  const removal = removeAvailability(view);
  const busy = pending !== null;

  return (
    <section
      aria-label="Flow actions"
      className="space-y-3 rounded-card border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={failed.length === 0 || busy}
          onClick={() => onAction(retryBody(failed))}
        >
          {pending === 'retry-failed' ? 'Retrying…' : `Retry all failed (${failed.length})`}
        </Button>
        {!removing && (
          <Button
            size="sm"
            variant="danger"
            disabled={!removal.ok || busy}
            onClick={() => setRemoving(true)}
          >
            Remove flow…
          </Button>
        )}
        {!removal.ok && <span className="text-[13px] text-muted">{removal.reason}</span>}
      </div>
      {removing && removal.ok && (
        <form
          aria-label="Confirm removal of the flow"
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed !== view.root) return;
            setRemoving(false);
            setTyped('');
            onAction(removeBody(view));
          }}
        >
          <p className="text-[13px] text-muted">
            This deletes all {view.nodes.length} jobs of the flow, finished ones too, and cannot be
            undone. Type{' '}
            <span translate="no" className="break-all font-mono text-fg">
              {view.root}
            </span>{' '}
            to confirm.
          </p>
          <Input
            name="confirm-flow-root"
            aria-label="Type the root job ID to confirm"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="font-mono text-sm"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="danger" disabled={typed !== view.root || busy}>
              {pending === 'remove' ? 'Removing…' : 'Remove flow'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRemoving(false);
                setTyped('');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
