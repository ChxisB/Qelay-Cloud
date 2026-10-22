import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { bq } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { ConnectionFields } from './ConnectionFields';
import {
  type EditField,
  type EditFields,
  fieldsOf,
  patchOf,
  previewOf,
  refusedField,
} from './connectionPatch';

/**
 * Edits what a connection is called and the rules an event goes through. The form shows the connection's own
 * values until something is typed; a save sends only what changed, then shows what the server now holds. A
 * refusal stays here with everything typed. The source queue and the destination are fixed: remove and add.
 */
export function ConnectionEdit({
  route,
  refetch,
}: {
  route: WebhookFull;
  refetch: () => Promise<void>;
}) {
  const guard = useServerActionGuard(`webhook-edit:${route.id}`);
  const [edits, setEdits] = useState<EditFields | null>(null);
  const [refusal, setRefusal] = useState<{ field: EditField | null; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const fields = edits ?? fieldsOf(route);
  const built = patchOf(route, fields);
  const preview = built.ok ? previewOf(route.id, built.patch) : '';
  const errors: Partial<Record<EditField, string>> = {};
  if (!built.ok) errors[built.field] = built.msg;
  if (refusal?.field) errors[refusal.field] = refusal.msg;

  const change = <K extends EditField>(key: K, value: EditFields[K]) => {
    setEdits({ ...fields, [key]: value });
    setRefusal(null);
    setSaved(false);
  };

  const save = async () => {
    if (busy || !built.ok || preview === '') return;
    const lease = guard.begin(['registry-write', `webhook:${route.id}`]);
    if (!lease) return;
    setBusy(true);
    setRefusal(null);
    try {
      assertSuccessfulMutationResponse(
        await bq.updateWebhook(route.id, built.patch),
        'Save connection'
      );
      if (!lease.isCurrent()) return;
      await refetch();
      if (!lease.isCurrent()) return;
      setEdits(null);
      setSaved(true);
    } catch (caught) {
      if (!lease.isCurrent()) return;
      setRefusal({ field: refusedField(caught), msg: (caught as Error).message });
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Connection"
        headingLevel={3}
        sub="Name it and choose what is sent. The source and the destination are fixed; to change one, add a new connection and remove this one."
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <ConnectionFields fields={fields} onChange={change} errors={errors} />
        {preview !== '' && (
          <div>
            <p className="mb-1 text-[13px] font-bold text-fg">What Save sends</p>
            <pre
              aria-label="Request to be sent"
              className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-fg"
            >
              {preview}
            </pre>
          </div>
        )}
        {refusal && !refusal.field && (
          <p role="alert" className="m-0 text-[13px] font-bold text-danger">
            {refusal.msg}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy || !built.ok || preview === ''}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
          {edits && !busy && (
            <Button
              onClick={() => {
                setEdits(null);
                setRefusal(null);
              }}
            >
              Discard changes
            </Button>
          )}
          {saved && (
            <span role="status" className="text-[13px] text-muted">
              Saved.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
