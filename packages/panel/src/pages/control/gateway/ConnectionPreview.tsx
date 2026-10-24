import { ICON } from '@/components/layout/NavIcon';
import type { WebhookDestination } from '@/lib/bq';
import { displayWebhookUrl } from '../webhooks/model';
import { type ChainEnd, ConnectionChain } from './ConnectionChain';
import type { EditFields } from './connectionPatch';
import { SEND_NOW } from './sendRules';

/** The rules the form can set, in the order a request meets them, with what turns each one on. */
const SETTABLE: ReadonlyArray<[name: string, on: (rules: EditFields) => boolean]> = [
  ['Filter', (rules) => rules.filter.trim() !== ''],
  ['Deduplicate', (rules) => rules.dedupeWindow.trim() !== ''],
  ['Shape', (rules) => rules.shape.trim() !== ''],
  ['Delay', (rules) => rules.delay.trim() !== ''],
  ['Schedule', (rules) => rules.sendMode !== SEND_NOW],
  ['Batch', (rules) => rules.batchOn],
];

/**
 * The new-connection form's side panel: the line the connection will draw, built from what is typed so far and
 * from nothing else (no read, no save). An end that is not chosen yet is a dashed placeholder that says what to
 * choose; the line is solid once both ends exist and dotted until then. A box counts as a rule once it holds text,
 * valid or not: the form says whether it is valid.
 */
export function ConnectionPreview({
  source: sourceId,
  destination,
  address,
  signed,
  rules,
}: {
  /** The chosen source's name; empty before one is chosen. */
  source: string;
  /** Null until a saved destination is picked. */
  destination: WebhookDestination | null;
  /** The address or the target queue, typed or taken from the saved destination. */
  address: string;
  signed: boolean;
  rules: EditFields;
}) {
  const toQueue = destination === 'queue';
  const from = sourceId.trim();
  const to = address.trim();
  const start: ChainEnd =
    from === ''
      ? { kind: 'source', icon: ICON.queues, name: 'Choose the source', missing: true }
      : { kind: 'source', icon: ICON.queues, name: `Source: ${from}`, sub: 'Source' };
  const end: ChainEnd =
    destination === null || to === ''
      ? {
          kind: toQueue ? 'queue' : 'http',
          icon: toQueue ? ICON.queues : ICON.webhooks,
          name:
            destination === null
              ? 'Choose a destination'
              : toQueue
                ? 'Choose the queue to add jobs to'
                : 'Enter the address to send to',
          missing: true,
        }
      : toQueue
        ? { kind: 'queue', icon: ICON.queues, name: `Queue: ${to}`, sub: 'adds a job' }
        : {
            kind: 'http',
            icon: ICON.webhooks,
            name: displayWebhookUrl(to),
            sub: signed ? 'signed' : 'unsigned',
          };
  return (
    <aside
      aria-label="What it will do"
      className="order-first rounded-card border border-line bg-surface-2 p-4 lg:sticky lg:top-4 lg:order-none lg:self-start"
    >
      <h3 className="m-0 text-sm font-bold text-fg">What it will do</h3>
      <p className="m-0 mt-0.5 mb-4 text-[13px] text-muted">Drawn from the form. Not saved.</p>
      <ConnectionChain
        stacked
        source={start}
        destination={end}
        stations={SETTABLE.filter(([name, on]) => on(rules) && !(toQueue && name === 'Batch')).map(
          ([name]) => ({
            name,
            word: 'On',
          })
        )}
        state={start.missing || end.missing ? 'off' : 'active'}
      />
    </aside>
  );
}
