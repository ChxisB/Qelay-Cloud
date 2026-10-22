import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Tag } from '@/components/ui/Tag';
import type { DestinationFull } from '@/lib/bq';
import { cn } from '@/lib/cn';
import { stagger } from '@/lib/stagger';
import { useChangeFlash } from '@/lib/useChangeFlash';
import { usePresence } from '@/lib/usePresence';
import { addressOf } from './destinationFields';
import { DestinationForm } from './DestinationForm';
import { DestinationLines } from './DestinationLines';

/**
 * One saved destination: its name, address and how many connections run into it, with the lines of those
 * connections beside the words. `arrive` is where the card rises as it mounts (read once). The edit form opens
 * and closes with the card; while the address in it differs from the saved one the lines are dashed.
 */
export function DestinationCard({
  destination,
  canOperate,
  editing,
  busy,
  arrive,
  onEdit,
  onRemove,
  refetch,
  onDone,
}: {
  destination: DestinationFull;
  canOperate: boolean;
  editing: boolean;
  busy: boolean;
  arrive: number | undefined;
  onEdit: () => void;
  onRemove: () => void;
  refetch: () => Promise<void>;
  onDone: () => void;
}) {
  const [place] = useState(arrive);
  const [moving, setMoving] = useState(false);
  const form = usePresence(editing);
  const flash = useChangeFlash(addressOf(destination));
  const used = destination.connections;
  return (
    <li
      className={place === undefined ? undefined : 'motion-arrive'}
      style={place === undefined ? undefined : stagger(place)}
    >
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 flex flex-wrap items-center gap-2 text-sm font-bold text-fg">
              {destination.name}
              <Tag>{destination.kind === 'http' ? 'Webhook address' : 'Queue'}</Tag>
            </p>
            <p className="m-0 mt-1 break-words font-mono text-[13px] text-muted">
              {addressOf(destination)}
              {destination.urlRedacted ? ' (address hidden for read-only access)' : ''}
            </p>
            <p className="m-0 mt-1 text-[13px] text-muted">
              {used === 0
                ? 'No connection is made from it yet.'
                : `${used} connection${used === 1 ? ' is' : 's are'} made from it.`}
            </p>
          </div>
          <DestinationLines count={used} moving={moving && editing} flash={flash} />
          {canOperate && !editing && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={onEdit}>
                Edit
              </Button>
              <Button size="sm" disabled={busy} onClick={onRemove}>
                Remove
              </Button>
            </div>
          )}
        </div>
        {form.mounted && (
          <div
            inert={form.leaving || undefined}
            className={cn(
              'mt-4 border-t border-line pt-4',
              form.leaving ? 'motion-leave' : 'motion-arrive'
            )}
          >
            <DestinationForm
              destination={destination}
              refetch={refetch}
              onDone={onDone}
              onMoving={setMoving}
            />
          </div>
        )}
      </Card>
    </li>
  );
}
