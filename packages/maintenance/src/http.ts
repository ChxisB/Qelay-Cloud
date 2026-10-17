import type { Authenticator } from './auth';
import { guarded, noTelemetry } from './telemetry';
import type { Telemetry } from './telemetry';
import type { RunReport } from './tick';

export const TICK_PATH = '/internal/tick';

export interface TickHandlerOptions {
  /** Required: there is no way to build an open endpoint. */
  readonly authenticate: Authenticator;
  /** One invocation of the tick, as `runTicks` runs it. */
  readonly run: () => Promise<RunReport>;
  readonly telemetry?: Telemetry;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

/**
 * `POST /internal/tick` as a fetch-style handler, for `Bun.serve` or any runtime that speaks
 * `Request` and `Response`. A caller that is not authenticated gets a bare 401 and no tick runs.
 * The report is counts and milliseconds: it carries no job id, queue name, payload or error text,
 * and a failure is a 500 that says only that the tick failed (the cause goes to `telemetry`).
 * Overlapping calls are allowed: a tick is safe to run concurrently with itself.
 */
export function createTickHandler(
  options: TickHandlerOptions
): (request: Request) => Promise<Response> {
  const telemetry = guarded(options.telemetry ?? noTelemetry);
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== TICK_PATH) return json(404, { error: 'not found' });
    // Authenticate before anything else, even the method, so a probe learns nothing.
    let allowed = false;
    try {
      allowed = await options.authenticate(request);
    } catch (error) {
      telemetry.error('http', error);
    }
    if (!allowed) return json(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    if (request.method !== 'POST')
      return json(405, { error: 'method not allowed' }, { allow: 'POST' });
    try {
      return json(200, await options.run());
    } catch (error) {
      telemetry.error('http', error);
      return json(500, { error: 'tick failed' });
    }
  };
}
