import type { PostgresStore, PostgresStoreOptions } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import type { JobsDeps, JobsOptions } from '../src';
import type { Harness } from './support';
import { DEV_TOKEN, harness } from './support';

/** What one call answered: the status, the parsed body (null for a 204) and the headers. */
export interface Answer<T = Record<string, any>> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export interface JobsApi {
  readonly api: Harness;
  call<T = Record<string, any>>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<Answer<T>>;
  /** The same as `call` with a viewer's token. */
  asViewer<T = Record<string, any>>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Answer<T>>;
}

export interface JobsFixture {
  readonly t: TestStore;
  readonly store: PostgresStore;
  readonly transport: MemoryTransport;
  /** Empties every table, rewinds the clock and replaces the transport, so one test never sees the last one's. */
  reset(): Promise<void>;
  /** A fresh Control API over this store (and so a fresh cache and fresh rate baselines). */
  api(options?: JobsOptions, jobs?: Partial<JobsDeps>): JobsApi;
  drop(): Promise<void>;
}

/** A migrated schema with a store on it and a way to build the Control API over that store. */
export async function openJobsFixture(
  storeOptions: Partial<PostgresStoreOptions> = {}
): Promise<JobsFixture> {
  const t = await openTestStore(storeOptions);
  let transport = new MemoryTransport({ clock: t.clock });

  const jobsApi = (
    options: JobsOptions = { summaryCacheMs: 0 },
    extra: Partial<JobsDeps> = {}
  ): JobsApi => {
    const build = (role: 'operator' | 'viewer'): Harness =>
      harness(
        { devToken: { token: DEV_TOKEN, role }, rateLimit: false },
        { jobs: { store: t.store, transport, options, ...extra } },
        t.clock
      );
    const api = build('operator');
    const viewer = build('viewer');
    const run = async <T>(
      target: Harness,
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>
    ): Promise<Answer<T>> => {
      const response = await target.call(method, path, {
        ...(body === undefined ? {} : { body }),
        ...(headers === undefined ? {} : { headers }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text === '' ? null : JSON.parse(text)) as T,
        headers: response.headers,
      };
    };
    return {
      api,
      call: (method, path, body, headers) => run(api, method, path, body, headers),
      asViewer: (method, path, body) => run(viewer, method, path, body),
    };
  };

  return {
    t,
    store: t.store,
    get transport() {
      return transport;
    },
    async reset() {
      await resetTables(t);
      transport = new MemoryTransport({ clock: t.clock });
    },
    api: jobsApi,
    drop: () => t.drop(),
  };
}
