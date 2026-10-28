import { useId, useState } from 'react';
import type { ConfirmOptions } from '@/components/dashboard/stores/confirmStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Disclosure } from '@/components/ui/Disclosure';
import { Input, Toggle } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import type { JobFull } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import {
  FLOW_COMPLETED_REQUEUE_UNAVAILABLE,
  FLOW_DELETION_UNAVAILABLE,
} from '@/lib/flowMutationSafety';
import { actionGates } from '@/lib/jobActions';
import { PROMOTE_THIS_JOB } from '../jobsPro/promoteConfirm';

type Act = (label: string, fn: () => Promise<unknown>, confirm?: ConfirmOptions) => void;

const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

type JobNumberKind = 'delay' | 'progress' | 'priority';

export function parseJobActionNumber(
  raw: string,
  kind: JobNumberKind
): { ok: true; value: number } | { ok: false; msg: string } {
  if (!raw.trim()) return { ok: false, msg: 'A value is required' };
  const value = Number(raw);
  if (!Number.isFinite(value)) return { ok: false, msg: 'Value must be a finite number' };
  if (kind === 'progress') {
    return value >= 0 && value <= 100
      ? { ok: true, value }
      : { ok: false, msg: 'Progress must be between 0 and 100' };
  }
  if (!Number.isSafeInteger(value)) {
    return { ok: false, msg: 'Value must be a whole, safe integer' };
  }
  if (kind === 'priority') {
    return value >= -1_000_000 && value <= 1_000_000
      ? { ok: true, value }
      : { ok: false, msg: 'Priority must be between -1000000 and 1000000' };
  }
  return value >= 0 && value <= MAX_DELAY_MS
    ? { ok: true, value }
    : { ok: false, msg: `Delay must be between 0 and ${MAX_DELAY_MS} ms` };
}

export function parseFailureStack(
  text: string
): { ok: true; stack?: string[] } | { ok: false; msg: string } {
  const stack = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (stack.length > 100) return { ok: false, msg: 'Stack trace is limited to 100 frames' };
  if (stack.some((line) => line.length > 16_384)) {
    return { ok: false, msg: 'Each stack frame must be 16384 characters or fewer' };
  }
  if (stack.reduce((total, line) => total + line.length, 0) > 256 * 1024) {
    return { ok: false, msg: 'Stack trace must be 256 KB or smaller' };
  }
  return { ok: true, ...(stack.length ? { stack } : {}) };
}

const SWITCHED_OFF: Record<string, string> = {
  failed:
    'Retry a failed job from the Dead letter queue page. Cancelling and deleting it from here is switched off on this server.',
  completed:
    'Running this job again, cancelling it and deleting it from here is switched off on this server.',
  active: "This job is running now, so apart from its progress it can't be changed from here.",
};

const ACTIVE_REASON =
  'Active-job state changes are unavailable: Qelay cannot stop the worker that is already processing this job, so retrying, delaying, discarding or failing it here could run side effects twice.';

/** Says once what is switched off for this job; the exact reasons are behind "Why?". */
function UnavailableNote({ state }: { state?: string }) {
  const reason =
    state === 'completed'
      ? FLOW_COMPLETED_REQUEUE_UNAVAILABLE
      : state === 'active'
        ? ACTIVE_REASON
        : null;
  return (
    <div role="note">
      <p className="text-[13px] text-muted">
        {(state && SWITCHED_OFF[state]) ??
          'Cancelling and deleting jobs from here is switched off on this server.'}
      </p>
      <Disclosure summary="Why?">
        <div className="flex flex-col gap-2 text-[13px] text-muted">
          {reason && <p>{reason}</p>}
          <p>Cancel/delete/discard: {FLOW_DELETION_UNAVAILABLE}</p>
        </div>
      </Disclosure>
    </div>
  );
}

/**
 * State-gated action rail for a single job. Reads the shared actionGates() so it
 * never drifts from JobsPro on what's legal, and routes every mutation through
 * the parent's act() (which handles the status line + reload). Active jobs only
 * expose progress: state-changing controls cannot cancel the running worker in
 * Qelay and could otherwise create duplicate processing side effects.
 */
export function JobActionsPanel({ job, busy, act }: { job: JobFull; busy: boolean; act: Act }) {
  const canOperate = useCanOperate();
  const gates = actionGates(job.state);

  if (!canOperate) {
    return (
      <Card>
        <CardHeader title="Actions" />
        <p role="note" className="text-[13px] text-muted">
          Your role can look at jobs but not change them.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title="Actions" />
      <div className="flex flex-col gap-3">
        {gates.promote && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              act('Promote', () => bq.promoteJob(job.id, job.version), PROMOTE_THIS_JOB)
            }
          >
            Promote (run now)
          </Button>
        )}
        {job.state === 'active' && (
          <InlineNumber
            label="Set progress (0–100)"
            cta="Progress"
            kind="progress"
            disabled={busy}
            onSubmit={(n) => act('Progress', () => bq.setJobProgress(job.id, n))}
          />
        )}
        {gates.setPriority && (
          <PriorityAction
            disabled={busy}
            onSubmit={(priority, lifo) =>
              act('Priority', () => bq.changePriority(job.id, priority, lifo, job.version))
            }
          />
        )}
        {gates.setDelay && (
          <InlineNumber
            label="Set delay (ms)"
            cta="Delay"
            kind="delay"
            disabled={busy}
            onSubmit={(n) => act('Delay', () => bq.changeDelay(job.id, n, job.version))}
          />
        )}
        <UnavailableNote state={job.state} />
      </div>
    </Card>
  );
}

function InlineNumber({
  label,
  cta,
  kind,
  disabled,
  onSubmit,
}: {
  label: string;
  cta: string;
  kind: Exclude<JobNumberKind, 'priority'>;
  disabled: boolean;
  onSubmit: (n: number) => void;
}) {
  const [v, setV] = useState('');
  const errorId = useId();
  const parsed = parseJobActionNumber(v, kind);
  const invalid = !parsed.ok && v.trim() !== '';
  return (
    // A real <form> so Enter in the field submits, same as clicking the button.
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && parsed.ok) onSubmit(parsed.value);
      }}
    >
      <Input
        type="number"
        min={0}
        max={kind === 'progress' ? 100 : MAX_DELAY_MS}
        step={kind === 'progress' ? 'any' : 1}
        name={kind === 'progress' ? 'job-progress' : 'job-delay'}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={label}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        className="min-w-32 flex-1"
      />
      <Button type="submit" size="sm" disabled={disabled || !parsed.ok}>
        {cta}
      </Button>
      {!parsed.ok && v.trim() && (
        <span id={errorId} role="alert" className="w-full text-[13px] font-semibold text-danger">
          {parsed.msg}
        </span>
      )}
    </form>
  );
}

function PriorityAction({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (priority: number, lifo: boolean) => void;
}) {
  const [v, setV] = useState('');
  const [lifo, setLifo] = useState(false);
  const errorId = useId();
  const parsed = parseJobActionNumber(v, 'priority');
  const invalid = !parsed.ok && v.trim() !== '';
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && parsed.ok) onSubmit(parsed.value, lifo);
      }}
    >
      <Input
        type="number"
        min={-1_000_000}
        max={1_000_000}
        step={1}
        name="job-priority"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Set priority"
        aria-label="Set priority"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        className="min-w-32 flex-1"
      />
      <div className="flex items-center gap-1.5">
        <Toggle checked={lifo} onChange={setLifo} label="Place first among equal priorities" />
        <span className="text-[13px] text-muted">LIFO</span>
      </div>
      <Button type="submit" size="sm" disabled={disabled || !parsed.ok}>
        Set
      </Button>
      {!parsed.ok && v.trim() && (
        <span id={errorId} role="alert" className="w-full text-[13px] font-semibold text-danger">
          {parsed.msg}
        </span>
      )}
    </form>
  );
}
