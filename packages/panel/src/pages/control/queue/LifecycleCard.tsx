import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, FieldAction, FormRow, Input } from '@/components/ui/form';
import { bq } from '@/lib/bq';
import { promoteConfirmation, promoteCountArgs, type RunAction } from './queueActionModel';

/** Pause or resume the queue, and run delayed jobs now. Destructive clean-up is not offered here (see UnavailableNote). */
export function LifecycleCard({
  queue,
  paused,
  busy,
  run,
}: {
  queue: string;
  paused: boolean;
  busy: boolean;
  run: RunAction;
}) {
  const [promoteCount, setPromoteCount] = useState('');
  const promote = promoteCountArgs(promoteCount);

  return (
    <Card className="mb-6">
      <CardHeader
        title="Pause or resume"
        sub={
          paused
            ? 'This queue is paused. Workers are not given new jobs, and new jobs wait until you resume it.'
            : 'This queue is running. Workers pick up jobs as they arrive.'
        }
        action={
          paused ? (
            <Button disabled={busy} onClick={() => run('Resumed', () => bq.resume(queue))}>
              Resume queue
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => run('Paused', () => bq.pause(queue))}>
              Pause queue
            </Button>
          )
        }
      />
      <div className="mt-5 border-t border-line pt-5">
        <h3 className="text-[13px] font-bold text-fg">Run delayed jobs now</h3>
        <p className="mb-3 mt-1 text-[13px] text-muted">
          A delayed job waits for its scheduled time. This starts them straight away instead.
        </p>
        <FormRow>
          <div className="w-44">
            <Field
              label="How many"
              hint="Leave blank for all."
              error={
                promote.valid ? undefined : 'Use a whole number above 0, or leave it blank for all.'
              }
            >
              <Input
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                name="promote-count"
                value={promoteCount}
                onChange={(event) => setPromoteCount(event.target.value)}
                placeholder="All"
              />
            </Field>
          </div>
          <FieldAction>
            <Button
              disabled={busy || !promote.valid}
              onClick={() =>
                run('Delayed jobs started', () => bq.promoteJobs(queue, promote.count), {
                  question: promoteConfirmation(queue, promote.count),
                  confirmLabel: 'Run delayed jobs',
                })
              }
            >
              Run delayed jobs
            </Button>
          </FieldAction>
        </FormRow>
      </div>
    </Card>
  );
}
