/**
 * What can happen to one ring. The model harness takes a fault as a command parameter, so a failing
 * sequence shrinks and replays (`test/model/transport.ts`); `FaultyTransport` applies the same four to
 * a real transport at the boundary, so the model and the scenarios speak one vocabulary.
 *
 * - `ok`: the broker takes the bell.
 * - `drop`: the broker says yes and loses it (the case the tick exists for).
 * - `duplicate`: the broker delivers it twice.
 * - `late`: the broker takes it, and the bell turns up after a lag.
 */
export type RingFault = 'ok' | 'drop' | 'duplicate' | 'late';

export const RING_FAULTS: readonly RingFault[] = ['ok', 'drop', 'duplicate', 'late'];
