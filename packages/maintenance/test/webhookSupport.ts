import type { ClaimedDelivery } from '@qelay-cloud/store-postgres';
import type { PostRequest, PostResult } from '../src/webhookHttp';
import type { Resolver, SendDeps } from '../src/webhookSend';

export const SECRET = 'whsec_0123456789abcdef0123456789abcdef';
export const NOW = 1_800_000_000_000;

export const PUBLIC_ADDRESS = '93.184.216.34';

export function delivery(overrides: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    deliveryId: '41',
    webhookId: 'wh_1',
    url: 'https://hooks.example.com/in?x=1',
    attempt: 1,
    event: 'job.completed',
    queue: 'emails',
    jobId: 'j-1',
    occurredAt: NOW - 1_000,
    state: 'completed',
    error: null,
    progress: null,
    secret: SECRET,
    secretUnreadable: false,
    ...overrides,
  };
}

export interface Script {
  readonly calls: PostRequest[];
  readonly lookups: string[];
  deps(overrides?: Partial<SendDeps>): SendDeps;
}

/**
 * A resolver and a post that remember what they were asked, and answer from the given functions. By
 * default a name resolves to one public address and every post answers 200.
 */
export function script(
  options: {
    resolve?: Resolver;
    post?: (request: PostRequest, call: number) => PostResult | Promise<PostResult>;
  } = {}
): Script {
  const calls: PostRequest[] = [];
  const lookups: string[] = [];
  return {
    calls,
    lookups,
    deps: (overrides = {}) => ({
      urlPolicy: { allowHttp: false, allowPrivate: false },
      resolve: async (host) => {
        lookups.push(host);
        return options.resolve ? options.resolve(host) : [PUBLIC_ADDRESS];
      },
      post: async (request) => {
        calls.push(request);
        return options.post ? options.post(request, calls.length) : { kind: 'status', status: 200 };
      },
      timeoutMs: 2_000,
      now: () => NOW,
      ...overrides,
    }),
  };
}
