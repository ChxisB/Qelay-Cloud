import { batchId, buildBatchBody } from '@qelay-cloud/core';
import type { BatchEvent } from '@qelay-cloud/core';
import type { AttemptOutcome, ClaimedDelivery } from '@qelay-cloud/store-postgres';
import { deliveryPayload } from './webhookPayload';
import type { SendDeps } from './webhookSend';
import { sendDelivery } from './webhookSend';

/**
 * Sending in batches (DESIGN.md D15). A claim hands out the deliveries of a batch route marked `batched`; the ones of one
 * route go out as ONE request, `{ batchId, count, events }` (`buildBatchBody`), signed and checked like any other
 * (`sendDelivery`). Its answer is every member's answer: a 2xx delivers all of them, anything else fails all of them, and
 * each outcome carries the batch id so the store keeps them together for the retry.
 */

/** The claimed deliveries as the requests that carry them: a batch route's go together, anything else goes alone. */
export function unitsOf(claimed: readonly ClaimedDelivery[]): ClaimedDelivery[][] {
  const units: ClaimedDelivery[][] = [];
  const batches = new Map<string, ClaimedDelivery[]>();
  for (const delivery of claimed) {
    if (delivery.batched !== true) {
      units.push([delivery]);
      continue;
    }
    let unit = batches.get(delivery.webhookId);
    if (unit === undefined) {
      unit = [];
      batches.set(delivery.webhookId, unit);
      units.push(unit);
    }
    unit.push(delivery);
  }
  return units;
}

/** Sends one unit of `unitsOf`. Never rejects; one outcome for each delivery in it. */
export async function sendUnit(
  unit: readonly ClaimedDelivery[],
  deps: SendDeps
): Promise<AttemptOutcome[]> {
  const [first] = unit;
  if (first === undefined) return [];
  return first.batched === true ? sendBatch(unit, deps) : [await sendDelivery(first, deps)];
}

const failure = (member: ClaimedDelivery, error: string, startedAt: number): AttemptOutcome => ({
  deliveryId: member.deliveryId,
  webhookId: member.webhookId,
  attempt: member.attempt,
  ok: false,
  statusCode: null,
  error,
  response: null,
  startedAt,
  durationMs: 0,
});

async function sendBatch(
  members: readonly ClaimedDelivery[],
  deps: SendDeps
): Promise<AttemptOutcome[]> {
  const startedAt = deps.now();
  try {
    // A member whose payload cannot be made fails alone; it is not in the envelope or in the batch id.
    const outcomes: AttemptOutcome[] = [];
    const sent: ClaimedDelivery[] = [];
    const events: BatchEvent[] = [];
    for (const member of members) {
      const made = deliveryPayload(member);
      if (!made.ok) {
        outcomes.push(failure(member, made.reason, startedAt));
        continue;
      }
      const { payload } = made;
      sent.push(member);
      events.push({
        id: member.deliveryId,
        receivedAt: member.occurredAt,
        body: payload.bytes ?? payload.text,
        contentType: payload.contentType ?? null,
      });
    }
    if (sent.length === 0) return outcomes;
    const id = await batchId(events.map((event) => event.id));
    const text = await buildBatchBody(events);
    const answer = await sendDelivery(sent[0]!, deps, {
      id,
      attempt: Math.max(...sent.map((member) => member.attempt)),
      payload: { text, signed: text, testDocument: false },
    });
    return [
      ...outcomes,
      ...sent.map((member) => ({
        ...answer,
        deliveryId: member.deliveryId,
        attempt: member.attempt,
        batchId: id,
      })),
    ];
  } catch {
    // Nothing of the error is recorded: it could carry a path or an address.
    return members.map((member) => failure(member, 'the attempt could not be made', startedAt));
  }
}
