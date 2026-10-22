import type {
  AddDestinationBody,
  DestinationFull,
  DestinationPatchBody,
  WebhookDestination,
} from '@/lib/bq';
import { isDeliverableUrl, QUEUE_NAME_MSG, validQueue } from '../webhooks/model';
import { NAME_MAX } from './connectionPatch';

/** What the destination form holds, as typed. `address` is a URL for an `http` destination and a queue for a `queue` one. */
export interface DestinationFields {
  name: string;
  kind: WebhookDestination;
  address: string;
}

export type DestinationField = 'name' | 'address';

type Refusal = { ok: false; field: DestinationField; msg: string };

export const addressOf = (destination: DestinationFull): string =>
  destination.kind === 'http' ? destination.url : (destination.target ?? '');

export const fieldsOfDestination = (destination: DestinationFull): DestinationFields => ({
  name: destination.name,
  kind: destination.kind,
  address: addressOf(destination),
});

/** The name and address as the server will judge them; a message names the field it is about. */
function checked(fields: DestinationFields): { name: string; address: string } | Refusal {
  const name = fields.name.trim();
  if (name === '') return { ok: false, field: 'name', msg: 'A destination needs a name.' };
  if (name.length > NAME_MAX) {
    return { ok: false, field: 'name', msg: `A name is at most ${NAME_MAX} characters.` };
  }
  const address = fields.address.trim();
  if (fields.kind === 'http') {
    if (!isDeliverableUrl(address)) {
      return {
        ok: false,
        field: 'address',
        msg: 'The URL must be a valid http:// or https:// address without embedded credentials.',
      };
    }
  } else if (!validQueue(address)) {
    return { ok: false, field: 'address', msg: `A queue name ${QUEUE_NAME_MSG}.` };
  }
  return { name, address };
}

export function addBodyOf(
  fields: DestinationFields
): { ok: true; body: AddDestinationBody } | Refusal {
  const found = checked(fields);
  if ('ok' in found) return found;
  const { name, address } = found;
  return {
    ok: true,
    body:
      fields.kind === 'http'
        ? { name, kind: 'http', url: address }
        : { name, kind: 'queue', target: address },
  };
}

/** Only what changed, so a save never writes over another operator's edit of the other field. */
export function patchBodyOf(
  destination: DestinationFull,
  fields: DestinationFields
): { ok: true; patch: DestinationPatchBody } | Refusal {
  const found = checked({ ...fields, kind: destination.kind });
  if ('ok' in found) return found;
  const patch: DestinationPatchBody = {};
  if (found.name !== destination.name) patch.name = found.name;
  if (found.address !== addressOf(destination)) {
    if (destination.kind === 'http') patch.url = found.address;
    else patch.target = found.address;
  }
  return { ok: true, patch };
}
