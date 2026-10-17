import { useState } from 'react';
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
    <section aria-label="Execution actions" className="space-y-3 rounded-lg border border-line p-3">
      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-start justify-between gap-3 text-xs ${notice.kind === 'error' ? 'text-danger' : 'text-success'}`}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={onDismissNotice} className="shrink-0 text-faint underline">
            Dismiss
          </button>
        </div>
      )}
      {!operator ? (
        <p className="text-xs text-faint">
          Your role can look at workflow executions but not change them.
        </p>
      ) : actions.length === 0 ? (
        <p className="text-xs text-faint">
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
