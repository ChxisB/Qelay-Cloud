import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, FormRow, Input, Select } from '@/components/ui/form';
import { ReadFirstCard, Value } from '@/components/ui/ReadFirstCard';
import { bq } from '@/lib/bq';
import { FormError, RemoveLimit } from './limitParts';
import { everyWindow, jobsCount, plainDuration } from './limitSentences';
import { type RunAction, rateLimitArgs } from './queueActionModel';

type Last = { limit: number; duration: number; ttl?: number } | 'removed' | null;

/**
 * How many jobs this queue starts in a time window. The server has no way to say what is set (`PUT` and
 * `DELETE` only), so the sentence is what this page last did, and otherwise says that it does not know.
 */
export function RateLimitCard({
  queue,
  busy,
  run,
}: {
  queue: string;
  busy: boolean;
  run: RunAction;
}) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState('');
  const [duration, setDuration] = useState('');
  const [ttlMode, setTtlMode] = useState<'permanent' | 'expires'>('permanent');
  const [ttl, setTtl] = useState('');
  const [last, setLast] = useState<Last>(null);
  const rate = rateLimitArgs(
    limit,
    duration,
    ttlMode === 'expires' ? ttl : '',
    ttlMode === 'expires'
  );
  const invalid = !rate.valid && Boolean(limit.trim() || duration.trim() || ttl.trim());
  const field = {
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': invalid ? 'rate-error' : undefined,
  };
  const done = (next: Last) => () => {
    setLast(next);
    setLimit('');
    setDuration('');
    setTtl('');
    setTtlMode('permanent');
    setOpen(false);
  };
  return (
    <ReadFirstCard
      title="Speed limit"
      sub="Cap how many jobs this queue handles in a time window, for example 100 jobs every minute. Applying a new limit replaces the current one."
      open={open}
      onOpenChange={setOpen}
      summary={
        last === null ? (
          'This server does not say what limit is set, so it cannot be shown here. Use Edit to set one.'
        ) : last === 'removed' ? (
          'You removed the limit from this page. Jobs start as fast as workers take them.'
        ) : (
          <>
            You set this from this page: <Value>{jobsCount(last.limit)}</Value>{' '}
            <Value>{everyWindow(last.duration)}</Value>,{' '}
            {last.ttl === undefined ? 'until you remove it' : `for ${plainDuration(last.ttl)}`}.
          </>
        )
      }
    >
      <FormRow>
        <div className="min-w-32 flex-1">
          <Field label="Jobs allowed">
            <Input
              type="number"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              name="rate-limit"
              {...field}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              placeholder="100"
            />
          </Field>
        </div>
        <div className="min-w-40 flex-1">
          <Field label="Per time window (ms)" hint="60000 is one minute.">
            <Input
              type="number"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              name="rate-duration"
              {...field}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
              placeholder="60000"
            />
          </Field>
        </div>
        <div className="min-w-44 flex-1">
          <Field label="How long it lasts">
            <Select
              name="rate-ttl-mode"
              value={ttlMode}
              onChange={(event) => setTtlMode(event.target.value as 'permanent' | 'expires')}
            >
              <option value="permanent">Until I remove it</option>
              <option value="expires">For a set time</option>
            </Select>
          </Field>
        </div>
        {ttlMode === 'expires' && (
          <div className="min-w-40 flex-1">
            <Field label="Lasts for (ms)" hint="Then the limit is lifted.">
              <Input
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                name="rate-ttl"
                {...field}
                value={ttl}
                onChange={(event) => setTtl(event.target.value)}
              />
            </Field>
          </div>
        )}
      </FormRow>
      <Button
        className="mt-4"
        variant="primary"
        disabled={busy || !rate.valid}
        onClick={() =>
          run(
            'Rate limit set',
            () => bq.setRateLimit(queue, rate.limit, rate.duration, rate.ttl),
            {
              question: `Replace the current rate-limit policy for "${queue}" with limit ${rate.limit}, window ${rate.duration}ms${rate.ttl === undefined ? ', permanent' : `, TTL ${rate.ttl}ms`}?`,
              confirmLabel: 'Apply speed limit',
            },
            done({ limit: rate.limit, duration: rate.duration, ttl: rate.ttl })
          )
        }
      >
        Apply speed limit
      </Button>
      {invalid && (
        <FormError id="rate-error">
          {ttlMode === 'expires'
            ? 'Jobs allowed, the time window and how long it lasts are all needed, as whole numbers above 0.'
            : 'Jobs allowed and the time window are both needed, as whole numbers above 0.'}
        </FormError>
      )}
      <RemoveLimit
        queue={queue}
        summary="Remove the speed limit"
        button="Remove speed limit"
        inputName="rate-clear-queue"
        busy={busy}
        onRemove={() =>
          run(
            'No rate limit ensured',
            () => bq.clearRateLimit(queue),
            {
              question: `Remove the current rate-limit policy from queue "${queue}"?`,
              confirmLabel: 'Remove speed limit',
              danger: true,
            },
            done('removed')
          )
        }
      />
    </ReadFirstCard>
  );
}
