import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Field, Input } from '@/components/ui/form';
import { type AddWebhookBody, WEBHOOK_EVENTS } from '@/lib/bq';
import {
  assertSuccessfulMutationResponse,
  type ServerActionLease,
} from '@/lib/useServerActionGuard';
import { buildWebhookBody, generateWebhookSecret, SECRET_MAX_CHARS } from './model';

export function WebhookForm({
  onAdd,
  onAccepted,
  beginAdd,
  scopeKey,
}: {
  onAdd: (body: AddWebhookBody) => Promise<unknown>;
  onAccepted: () => void;
  beginAdd: () => ServerActionLease | null;
  scopeKey: string;
}) {
  const [url, setUrl] = useState('');
  const [queue, setQueue] = useState('');
  const [secret, setSecret] = useState('');
  // A generated secret is shown once, so it can be copied to the receiver. Stored ones never are.
  const [revealed, setRevealed] = useState(false);
  const [events, setEvents] = useState<string[]>(['job.completed', 'job.failed']);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setBusy(false);
    setErr(null);
    setSecret('');
    setRevealed(false);
  }, [scopeKey]);

  const toggle = (event: string) =>
    setEvents((current) =>
      current.includes(event) ? current.filter((item) => item !== event) : [...current, event]
    );

  const submit = async () => {
    if (busy) return;
    setErr(null);
    const built = buildWebhookBody(url, events, queue, secret);
    if (!built.ok) return setErr(built.msg);
    const lease = beginAdd();
    if (!lease) return;
    setBusy(true);
    try {
      const response = await onAdd(built.body);
      assertSuccessfulMutationResponse(response, 'Add webhook');
      if (!lease.isCurrent()) return;
      setUrl('');
      setSecret('');
      setRevealed(false);
      onAccepted();
    } catch (error) {
      if (lease.isCurrent()) setErr((error as Error).message);
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="md:col-span-1">
          <Field label="URL">
            <Input
              value={url}
              onInput={(event) => setUrl(event.currentTarget.value)}
              name="webhook-url"
              type="url"
              maxLength={2_048}
              autoComplete="url"
              placeholder="https://example.com/hook"
            />
          </Field>
        </div>
        <Field label="Queue (optional)">
          <Input
            value={queue}
            onChange={(event) => setQueue(event.target.value)}
            name="webhook-queue"
            maxLength={256}
            autoComplete="off"
            placeholder="all queues"
          />
        </Field>
        <Field label="Signing secret (optional)" htmlFor="webhook-secret">
          <div className="flex items-center gap-2">
            <Input
              id="webhook-secret"
              type={revealed ? 'text' : 'password'}
              autoComplete="new-password"
              name="webhook-secret"
              maxLength={SECRET_MAX_CHARS}
              value={secret}
              onInput={(event) => {
                setSecret(event.currentTarget.value);
                setRevealed(false);
              }}
              placeholder="16+ characters, never shown again"
            />
            <Button
              size="sm"
              aria-label="Generate a signing secret"
              onClick={() => {
                setSecret(generateWebhookSecret());
                setRevealed(true);
              }}
            >
              Generate
            </Button>
            {revealed && <CopyButton value={secret} />}
          </div>
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {WEBHOOK_EVENTS.map((event) => (
          <button
            key={event}
            type="button"
            aria-pressed={events.includes(event)}
            onClick={() => toggle(event)}
            className={
              events.includes(event)
                ? 'rounded-full bg-selected px-3 py-1 text-xs font-medium text-link'
                : 'rounded-full border border-line px-3 py-1 text-xs font-medium text-muted hover:text-fg'
            }
          >
            {event}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? 'Adding…' : 'Add webhook'}
        </Button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </form>
  );
}
