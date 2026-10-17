import type { OptionalBehaviour } from './harness';

/**
 * Behaviours a transport's broker does not have, and why. The contract suite skips the matching test
 * with the reason in its title, and `docs/transports.md` prints the same text, so the matrix and the
 * code cannot disagree about a gap.
 */
export type ContractTransport = 'memory' | 'postgres-local' | 'pubsub-emulator' | 'sqs-emulator';

export const CONTRACT_SKIPS: Record<
  ContractTransport,
  Partial<Record<OptionalBehaviour, string>>
> = {
  memory: {
    poison: 'the in-process queue has no dead-letter queue: an unhandled bell is redelivered',
    outage: 'there is no network: the queue lives in the process',
  },
  'postgres-local': {
    poison:
      'bells are notifications and store rows, not broker messages: there is no body to be malformed',
    outage:
      'the connection is the store connection; its reconnect is tested against a killed backend in packages/transport-local/test/postgres.fault.test.ts',
  },
  'pubsub-emulator': {},
  'sqs-emulator': {},
};
