import { testDatabaseUrl } from '../../../test/support/db';
import { TcpProxy } from '../../../test/support/tcpProxy';

/** A fault-injecting proxy in front of the test database, and a URL that goes through it. */
export interface FaultProxy {
  readonly proxy: TcpProxy;
  readonly url: string;
  stop(): Promise<void>;
}

export async function startFaultProxy(): Promise<FaultProxy> {
  const target = new URL(testDatabaseUrl());
  const proxy = await TcpProxy.start({
    targetHost: target.hostname,
    targetPort: Number(target.port || 5432),
  });
  const through = new URL(target);
  through.hostname = '127.0.0.1';
  through.port = String(proxy.port);
  return { proxy, url: through.toString(), stop: () => proxy.stop() };
}

export interface Outcome {
  readonly result: 'ok' | 'error' | 'hung';
  readonly ms: number;
  readonly code: string | null;
}

/**
 * What a call does, within `capMs`: it settles, fails (with the error's `code`) or is still
 * pending. A call that never settles is the failure mode under test, so it must not hang the test.
 */
export async function outcome(run: () => Promise<unknown>, capMs: number): Promise<Outcome> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run().then(() => 'ok' as const),
      new Promise<'hung'>((resolve) => {
        timer = setTimeout(() => resolve('hung'), capMs);
      }),
    ]);
    return { result, ms: performance.now() - started, code: null };
  } catch (error) {
    const code = (error as { code?: string }).code ?? String(error);
    return { result: 'error', ms: performance.now() - started, code };
  } finally {
    clearTimeout(timer);
  }
}
