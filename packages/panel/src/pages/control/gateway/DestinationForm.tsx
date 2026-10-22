import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input, SegmentedControl } from '@/components/ui/form';
import { bq, BqError, type DestinationFull, type WebhookDestination } from '@/lib/bq';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { NAME_MAX } from './connectionPatch';
import {
  addBodyOf,
  addressOf,
  type DestinationField,
  type DestinationFields,
  fieldsOfDestination,
  patchBodyOf,
} from './destinationFields';

const KINDS = ['Webhook address', 'Another queue'] as const;
const KIND_OF: Record<(typeof KINDS)[number], WebhookDestination> = {
  'Webhook address': 'http',
  'Another queue': 'queue',
};

/** The field the server's refusal is about: it names the option, or the code says it (a taken name). */
function fieldOfRefusal(error: unknown): DestinationField | null {
  if (!(error instanceof BqError)) return null;
  if (error.code === 'destination_name_taken') return 'name';
  const option = error.details?.option;
  if (option === 'name') return 'name';
  return option === 'url' || option === 'target' ? 'address' : null;
}

/**
 * Saves a destination, or changes one (its kind is fixed; only the name and the address move). Changing the
 * address says first how many connections it reaches: each of them sends to the new address from the next event.
 */
export function DestinationForm({
  destination,
  refetch,
  onDone,
  onMoving,
}: {
  destination?: DestinationFull;
  refetch: () => Promise<void>;
  onDone: () => void;
  /** Told whether the address typed differs from the saved one, so the card can show its lines as about to move. */
  onMoving?: (moving: boolean) => void;
}) {
  const guard = useServerActionGuard(`webhook-destination:${destination?.id ?? 'new'}`);
  const [fields, setFields] = useState<DestinationFields>(
    destination ? fieldsOfDestination(destination) : { name: '', kind: 'http', address: '' }
  );
  const [refusal, setRefusal] = useState<{ field: DestinationField | null; msg: string } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const toQueue = fields.kind === 'queue';
  const moved = destination !== undefined && fields.address.trim() !== addressOf(destination);
  useEffect(() => {
    onMoving?.(moved);
    return () => onMoving?.(false);
  }, [moved, onMoving]);

  const change = (next: Partial<DestinationFields>) => {
    setFields({ ...fields, ...next });
    setRefusal(null);
  };

  const save = async () => {
    if (busy) return;
    const built = destination ? patchBodyOf(destination, fields) : addBodyOf(fields);
    if (!built.ok) return setRefusal({ field: built.field, msg: built.msg });
    if ('patch' in built && Object.keys(built.patch).length === 0) return onDone();
    const lease = guard.begin([
      'registry-write',
      `webhook-destination:${destination?.id ?? 'new'}`,
    ]);
    if (!lease) return;
    setBusy(true);
    setRefusal(null);
    try {
      if ('patch' in built && destination) await bq.updateDestination(destination.id, built.patch);
      else if ('body' in built) await bq.addDestination(built.body);
      if (!lease.isCurrent()) return;
      await refetch();
      if (lease.isCurrent()) onDone();
    } catch (caught) {
      if (lease.isCurrent()) {
        setRefusal({ field: fieldOfRefusal(caught), msg: (caught as Error).message });
      }
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  const on = (field: DestinationField) => (refusal?.field === field ? refusal.msg : undefined);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="max-w-xl">
        <Field label="Name" hint="How it is listed and chosen." error={on('name')}>
          <Input
            value={fields.name}
            onInput={(event) => change({ name: event.currentTarget.value })}
            maxLength={NAME_MAX}
            autoComplete="off"
            placeholder="Billing receiver"
          />
        </Field>
      </div>
      {!destination && (
        <div>
          <p className="mb-1 text-[13px] font-bold leading-5 text-fg">Kind</p>
          <SegmentedControl
            options={KINDS}
            value={toQueue ? 'Another queue' : 'Webhook address'}
            onChange={(next) => change({ kind: KIND_OF[next], address: '' })}
            label="What the destination is"
            asWritten
          />
        </div>
      )}
      <div className="max-w-xl">
        <Field
          label={toQueue ? 'To queue' : 'URL'}
          hint={
            toQueue
              ? 'Each event adds one job to this queue.'
              : 'Qelay sends a request to this address when an event happens.'
          }
          error={on('address')}
        >
          <Input
            value={fields.address}
            onInput={(event) => change({ address: event.currentTarget.value })}
            type={toQueue ? 'text' : 'url'}
            maxLength={toQueue ? 256 : 2_048}
            autoComplete="off"
            placeholder={toQueue ? 'refunds' : 'https://example.com/hook'}
          />
        </Field>
      </div>
      {moved && (
        <p role="status" className="m-0 text-[13px] text-muted">
          {destination.connections === 0
            ? 'No connection is made from it yet, so nothing else changes.'
            : `Saving changes ${destination.connections} connection${destination.connections === 1 ? '' : 's'}: each sends to the new address from its next event.`}
        </p>
      )}
      {refusal && !refusal.field && (
        <p role="alert" className="m-0 text-[13px] font-bold text-danger">
          {refusal.msg}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Saving…' : destination ? 'Save changes' : 'Add destination'}
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
