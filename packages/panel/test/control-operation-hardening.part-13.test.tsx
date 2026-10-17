import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useServerActionGuard } from '../src/lib/useServerActionGuard';
import { renderHook } from './domSetup';

beforeEach(() => setConnection('http://server-a.test', 'token-a', 'agent-a'));

afterEach(() => setConnection('/api', '', ''));

describe('persistent mutation leases', () => {
  test('server mutation locks survive remount without reviving across A to B to A', () => {
    const first = renderHook(() => useServerActionGuard('persistent-server-action'));
    const leaseA = first.result.current.begin('save');
    expect(leaseA).not.toBeNull();
    first.unmount();
    const remounted = renderHook(() => useServerActionGuard('persistent-server-action'));
    let leaseB: ReturnType<typeof remounted.result.current.begin> = null;
    let newLeaseA: ReturnType<typeof remounted.result.current.begin> = null;
    let released: ReturnType<typeof remounted.result.current.begin> = null;
    try {
      expect(remounted.result.current.begin('save')).toBeNull();
      act(() => setConnection('http://server-b.test', 'token-b', 'agent-b'));
      leaseB = remounted.result.current.begin('save');
      expect(leaseB).not.toBeNull();

      act(() => setConnection('http://server-a.test', 'token-a', 'agent-a'));
      newLeaseA = remounted.result.current.begin('save');
      expect(newLeaseA).not.toBeNull();
      leaseA?.finish();
      released = remounted.result.current.begin('save');
      expect(released).toBeNull();

      newLeaseA?.finish();
      released = remounted.result.current.begin('save');
      expect(released).not.toBeNull();
    } finally {
      leaseA?.finish();
      leaseB?.finish();
      newLeaseA?.finish();
      released?.finish();
      remounted.unmount();
    }
  });
});

function setConnection(baseUrl: string, token: string, agentToken: string): void {
  useConnectionStore.setState({ baseUrl, token, agentToken, refreshMs: 60_000 });
}
