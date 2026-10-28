import { describe, expect, test } from 'bun:test';
import {
  FLOW_BULK_RETRY_UNAVAILABLE,
  FLOW_COMPLETED_REQUEUE_UNAVAILABLE,
  FLOW_DELETION_UNAVAILABLE,
} from '../src/lib/flowMutationSafety';

describe('flow mutation fail-closed boundary', () => {
  test('publishes a reason for every unavailable destructive surface', () => {
    const versionedReasons = [
      FLOW_DELETION_UNAVAILABLE,
      FLOW_BULK_RETRY_UNAVAILABLE,
      FLOW_COMPLETED_REQUEUE_UNAVAILABLE,
    ];
    for (const reason of versionedReasons) {
      expect(reason).toContain('Qelay');
    }
  });
});
