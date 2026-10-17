import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/form';
import { ACTION_HINTS, ACTION_LABELS, actionBody, signalBody } from '../domain/workflowActions';
import type {
  WorkflowActionBody,
  WorkflowActionName,
  WorkflowExecution,
} from '../domain/workflowWire';

interface FormProps {
  /** The run as the operator read it when the form was opened: a run that moved since is refused. */
  execution: Pick<WorkflowExecution, 'id' | 'version'>;
  busy: boolean;
  onSubmit: (body: WorkflowActionBody) => void;
  onCancel: () => void;
}

const areaClass =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Signals an event into the run. The payload is JSON, or empty for a signal with no data. */
export function SignalForm({
  execution,
  awaiting,
  busy,
  onSubmit,
  onCancel,
}: FormProps & { awaiting: string | null }) {
  const [event, setEvent] = useState(awaiting ?? '');
  const [payload, setPayload] = useState('');
  const [problem, setProblem] = useState<{ field: 'event' | 'payload'; text: string } | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const draft = signalBody(execution, event, payload);
    if (!draft.ok) return setProblem({ field: draft.field, text: draft.error });
    setProblem(null);
    onSubmit(draft.body);
  };

  return (
    <form aria-label="Send a signal" className="space-y-2" onSubmit={submit}>
      <p className="text-xs text-muted">{ACTION_HINTS.signal}</p>
      <Field label="Event">
        <Input
          name="signal-event"
          autoComplete="off"
          spellCheck={false}
          value={event}
          aria-invalid={problem?.field === 'event'}
          onChange={(e) => setEvent(e.target.value)}
        />
      </Field>
      <Field label="Payload (JSON, optional)">
        <textarea
          name="signal-payload"
          rows={4}
          spellCheck={false}
          value={payload}
          aria-invalid={problem?.field === 'payload'}
          onChange={(e) => setPayload(e.target.value)}
          className={areaClass}
        />
      </Field>
      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem.text}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy}>
          {busy ? 'Sending…' : ACTION_LABELS.signal}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </div>
    </form>
  );
}

/** An action that cannot be taken back: it runs once the run's id has been typed back. */
export function ConfirmForm({
  action,
  execution,
  busy,
  onSubmit,
  onCancel,
}: FormProps & { action: Exclude<WorkflowActionName, 'signal'> }) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const label = ACTION_LABELS[action];

  return (
    <form
      aria-label={`Confirm: ${label}`}
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (typed === execution.id) onSubmit(actionBody(execution, action, reason));
      }}
    >
      <p className="text-xs text-muted">
        {ACTION_HINTS[action]} This cannot be undone. Type{' '}
        <span translate="no" className="break-all font-mono text-fg">
          {execution.id}
        </span>{' '}
        to confirm.
      </p>
      <Input
        name="confirm-execution-id"
        aria-label="Type the execution id to confirm"
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        className="font-mono"
      />
      {action === 'cancel' && (
        <Field label="Reason (optional, kept with the run)">
          <Input
            name="cancel-reason"
            autoComplete="off"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="danger" disabled={typed !== execution.id || busy}>
          {busy ? 'Working…' : label}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Keep as it is
        </Button>
      </div>
    </form>
  );
}
