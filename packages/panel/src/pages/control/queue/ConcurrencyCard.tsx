import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, FieldAction, FormRow, Input } from '@/components/ui/form';
import { ReadFirstCard, Value } from '@/components/ui/ReadFirstCard';
import { bq } from '@/lib/bq';
import { FormError, RemoveLimit } from './limitParts';
import { jobsCount } from './limitSentences';
import { concurrencyArgs, type RunAction } from './queueActionModel';

type Last = number | 'removed' | null;

/**
 * How many jobs of this queue may run at once. The server has no way to say what is set (`PUT` and `DELETE`
 * only), so the sentence is what this page last did, and otherwise says that it does not know.
 */
export function ConcurrencyCard({
  queue,
  busy,
  run,
}: {
  queue: string;
  busy: boolean;
  run: RunAction;
}) {
  const [open, setOpen] = useState(false);
  const [concurrency, setConcurrency] = useState('');
  const [last, setLast] = useState<Last>(null);
  const input = concurrencyArgs(concurrency);
  const invalid = !input.valid && concurrency.trim() !== '';
  const done = (next: Last) => () => {
    setLast(next);
    setConcurrency('');
    setOpen(false);
  };
  return (
    <ReadFirstCard
      title="Jobs at the same time"
      sub="Cap how many jobs from this queue may run at once, across all workers. Applying a new cap replaces the current one."
      open={open}
      onOpenChange={setOpen}
      summary={
        last === null ? (
          'This server does not say what cap is set, so it cannot be shown here. Use Edit to set one.'
        ) : last === 'removed' ? (
          'You removed the cap from this page. Workers decide how many jobs run at once.'
        ) : (
          <>
            You set this from this page: at most <Value>{jobsCount(last)}</Value> at once.
          </>
        )
      }
    >
      <FormRow>
        <div className="min-w-40 flex-1">
          <Field label="Most jobs at once">
            <Input
              type="number"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              name="concurrency"
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? 'concurrency-error' : undefined}
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
              placeholder="10"
            />
          </Field>
        </div>
        <FieldAction>
          <Button
            variant="primary"
            disabled={busy || !input.valid}
            onClick={() =>
              run(
                'Concurrency set',
                () => bq.setConcurrency(queue, input.value),
                {
                  question: `Replace the current concurrency policy for "${queue}" with ${input.value} maximum in-flight jobs?`,
                  confirmLabel: 'Apply cap',
                },
                done(input.value)
              )
            }
          >
            Apply cap
          </Button>
        </FieldAction>
      </FormRow>
      {invalid && <FormError id="concurrency-error">Use a whole number above 0.</FormError>}
      <RemoveLimit
        queue={queue}
        summary="Remove the cap"
        button="Remove cap"
        inputName="concurrency-clear-queue"
        busy={busy}
        onRemove={() =>
          run(
            'No concurrency limit ensured',
            () => bq.clearConcurrency(queue),
            {
              question: `Remove the current concurrency policy from queue "${queue}"?`,
              confirmLabel: 'Remove cap',
              danger: true,
            },
            done('removed')
          )
        }
      />
    </ReadFirstCard>
  );
}
