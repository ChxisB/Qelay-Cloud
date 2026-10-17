import { afterEach, beforeEach } from 'bun:test';
import { FlowPage } from '../src/features/flows/ui/FlowPage';
import { settle } from './domSetup';
import {
  connectTo,
  disconnect,
  fakeRepository,
  mountFlows,
  stuckFlow,
  unmountAll,
} from './flow.helpers';

export const flush = () => settle(20);

/** Connects before each test and unmounts and disconnects after it; call it once at the top of a test file. */
export function installPageHooks(): void {
  beforeEach(() => connectTo());
  afterEach(() => {
    unmountAll();
    disconnect();
  });
}

export const stuckRepo = (extra: Parameters<typeof fakeRepository>[0] = {}) =>
  fakeRepository({ view: () => stuckFlow(), ...extra });

export async function openStuck(extra: Parameters<typeof fakeRepository>[0] = {}) {
  const repository = stuckRepo(extra);
  const page = mountFlows(<FlowPage repository={repository} />, '/flows?root=root');
  await flush();
  return { repository, ...page };
}
