import { useState } from 'react';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import type { WorkflowNotice } from '../application/workflowMessages';
import {
  ACTION_HINTS,
  ACTION_LABELS,
  actionBody,
  DESTRUCTIVE_ACTIONS,
  offeredActions,
} from '../domain/workflowActions';
import type {
  WorkflowActionBody,
  WorkflowActionName,
  WorkflowExecution,
} from '../domain/workflowWire';
import { ConfirmForm, SignalForm } from './ActionForms';

interface Props {
  execution: WorkflowExecution;
  pending: WorkflowActionName | null;
  notice: WorkflowNotice | null;
  /** Resolves true when the server took the action. */
  onAction: (body: WorkflowActionBody) => Promise<boolean>;
  onDismissNotice: () => void;
}

/** A form open for one action, at the version the run had when it was opened. */
interface Armed {
  action: WorkflowActionName;
  version: number;
}

/**
 * What can be done to the run now. The server says which actions apply (`execution.actions`) and
 * refuses the rest; the buttons are only for operators. Each action names the version the operator
 * read, so a run that moved since is refused and not acted on.
 */
export function ExecutionActions({ execution, pending, notice, onAction, onDismissNotice }: Props) {
  const operator = useCanOperate();
  const [armed, setArmed] = useState<Armed | null>(null);
  const actions = offeredActions(execution);
  const busy = pending !== null;
  const open = armed && actions.includes(armed.action) ? armed : null;

  const run = async (body: WorkflowActionBody) => {
    if (await onAction(body)) setArmed(null);
  };
  // A form acts on the version it was opened at, whatever the page has read since.
  const frozen = open ? { id: execution.id, version: open.version } : execution;

  return (
    <section
      aria-label="Execution actions"
      className="space-y-3 rounded-card border border-line bg-surface p-4"
    >
      {notice && (
        <Banner
          tone={notice.kind === 'error' ? 'problem' : 'ok'}
          title={notice.kind === 'error' ? 'Action failed' : 'Action done'}
          action={
            <Button size="sm" variant="ghost" onClick={onDismissNotice}>
              Dismiss
            </Button>
          }
        >
          {' '}
          {notice.text}
        </Banner>
      )}
      {!operator ? (
        <p className="text-[13px] text-muted">
          Your role can look at workflow executions but not change them.
        </p>
      ) : actions.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nothing can be done to this run in its state ({execution.state}).
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={DESTRUCTIVE_ACTIONS.has(action) ? 'danger' : 'default'}
              title={ACTION_HINTS[action]}
              disabled={busy}
              aria-expanded={open?.action === action}
              onClick={() => {
                if (action === 'signal' || DESTRUCTIVE_ACTIONS.has(action)) {
                  setArmed({ action, version: execution.version });
                } else
                  void run(actionBody(execution, action as Exclude<WorkflowActionName, 'signal'>));
              }}
            >
              {pending === action ? 'Working…' : ACTION_LABELS[action]}
              {action === 'signal' || DESTRUCTIVE_ACTIONS.has(action) ? '…' : ''}
            </Button>
          ))}
        </div>
      )}
      {operator && open?.action === 'signal' && (
        <SignalForm
          execution={frozen}
          awaiting={execution.wait?.event ?? null}
          busy={busy}
          onSubmit={(body) => void run(body)}
          onCancel={() => setArmed(null)}
        />
      )}
      {operator && open && open.action !== 'signal' && DESTRUCTIVE_ACTIONS.has(open.action) && (
        <ConfirmForm
          action={open.action as Exclude<WorkflowActionName, 'signal'>}
          execution={frozen}
          busy={busy}
          onSubmit={(body) => void run(body)}
          onCancel={() => setArmed(null)}
        />
      )}
    </section>
  );
}
