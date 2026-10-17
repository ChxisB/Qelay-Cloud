import { randomUUID } from 'node:crypto';
import { createAuditor } from './audit/auditor';
import type { AuditTicket } from './audit/auditor';
import type { Principal } from './auth';
import { createAuthenticator } from './auth';
import { TtlCache } from './cache';
import type { ControlApiOptions, ResolvedConfig } from './config';
import { resolveConfig } from './config';
import type { ControlApiDeps } from './deps';
import { ApiError, errorBody, toApiError } from './errors';
import { checkDeclaredLength, readJson, readQuery } from './http/body';
import { corsHeaders, preflightHeaders } from './http/cors';
import type { RequestLog } from './http/log';
import { describeFailure, principalHash } from './http/log';
import { RateLimiter } from './http/rateLimit';
import type { Route, RouteContext } from './http/router';
import { Router } from './http/router';
import { auditRoutes } from './routes/audit';
import { capabilitiesRoutes } from './routes/capabilities';
import { healthRoutes } from './routes/health';
import { jobsModule } from './routes/jobsModule';
import { opsRoutes } from './routes/ops';
import { statsRoutes } from './routes/stats';

export interface ControlApp {
  readonly config: ResolvedConfig;
  /** Every route served, in the order registered. */
  readonly routes: readonly Route[];
  /** The largest body any route accepts: the cap to give the socket layer. */
  readonly maxBodyBytes: number;
  /** Answers any request. Never throws and never rejects. */
  handle(request: Request): Promise<Response>;
}

type LogDraft = { -readonly [K in keyof RequestLog]?: RequestLog[K] };

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

const requestIdOf = (request: Request): string => {
  const sent = request.headers.get('x-request-id');
  return sent !== null && REQUEST_ID.test(sent) ? sent : randomUUID();
};

async function within<T>(work: Promise<T>, ms: number, onLate: () => ApiError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onLate()), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

const toResponse = (result: unknown): Response =>
  result instanceof Response
    ? result
    : result === undefined
      ? new Response(null, { status: 204 })
      : Response.json(result);

const errorResponse = (error: ApiError): Response =>
  Response.json(errorBody(error), { status: error.status, headers: error.headers });

/**
 * The service as a fetch handler. Every request passes the same steps, in this order: request id,
 * CORS preflight, route match, authentication (before a 404, so an unknown path tells an
 * unauthenticated caller nothing), role, rate limit (writes only), body cap, handler under a time
 * limit. Failures become `{ error: { code, message, details? } }` and never carry a stack, SQL or a
 * payload; the cause is logged by type and code only.
 */
export function createControlApi(
  options: ControlApiOptions,
  deps: ControlApiDeps,
  env: Readonly<Record<string, string | undefined>> = process.env
): ControlApp {
  const config = resolveConfig(options, env);
  const { logger, clock } = config;
  const jobs = deps.jobs === undefined ? null : jobsModule(deps.jobs, { clock, logger });
  const auditLog = deps.audit ?? deps.jobs?.store.audit;
  const auditor = auditLog === undefined ? null : createAuditor(auditLog, logger);
  const dashboard = deps.dashboard ?? jobs?.dashboard;
  const routes = [
    ...healthRoutes(config.version, deps.readiness, clock),
    ...capabilitiesRoutes(deps, config.version),
    ...statsRoutes({ ...deps, ...(dashboard === undefined ? {} : { dashboard }) }),
    ...auditRoutes(auditLog),
    ...opsRoutes({
      deps,
      config,
      clock,
      logger,
      jobs: deps.jobs ?? null,
      cache: new TtlCache(config.deployment.cacheMs, clock),
    }),
    ...(jobs?.routes ?? []),
    ...(deps.routes ?? []),
  ];
  const router = new Router(routes);
  const authenticate = createAuthenticator(config, logger);
  const limiter = config.rateLimit === null ? null : new RateLimiter(config.rateLimit, clock);

  function preflight(origin: string | null): Response {
    if (origin === null || !config.corsOrigins.has(origin)) {
      throw new ApiError(403, 'origin_not_allowed', 'this origin may not call the API');
    }
    return new Response(null, { status: 204, headers: preflightHeaders(origin) });
  }

  async function dispatch(
    request: Request,
    requestId: string,
    origin: string | null,
    log: LogDraft
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return preflight(origin);

    const match = router.match(request.method, url.pathname);
    const route = match.kind === 'found' ? match.route : null;
    log.route = route?.path ?? 'unmatched';

    let principal: Principal | null = null;
    if (route?.access !== 'public') {
      principal = await authenticate(request);
      if (principal === null) {
        throw new ApiError(401, 'unauthorized', 'a valid bearer token is required', undefined, {
          'www-authenticate': 'Bearer',
        });
      }
      log.role = principal.role;
      log.principal = principalHash(principal.subject);
    }
    if (match.kind === 'none') throw ApiError.notFound('no such route');
    if (match.kind === 'method') {
      throw new ApiError(
        405,
        'method_not_allowed',
        'that method is not allowed here',
        {
          allowed: match.allowed,
        },
        { allow: match.allowed.join(', ') }
      );
    }
    const { params } = match;
    const target = match.route;

    const who = principal === null ? null : { principal, route: target, params, requestId };
    let ticket: AuditTicket | null = null;
    if (target.operatorOnly === true && principal?.role !== 'operator') {
      throw new ApiError(403, 'forbidden', 'this route needs the operator role');
    }
    if (target.access === 'write') {
      if (principal?.role !== 'operator') {
        await auditor?.refused(who!, 403, 'forbidden');
        throw new ApiError(403, 'forbidden', 'this action needs the operator role');
      }
      const taken = limiter?.take(`${principal.source}:${principal.subject}`);
      if (taken !== undefined && !taken.ok) {
        await auditor?.refused(who!, 429, 'rate_limited');
        throw new ApiError(
          429,
          'rate_limited',
          'too many changes; slow down',
          { retryAfterSec: taken.retryAfterSec },
          { 'retry-after': String(taken.retryAfterSec) }
        );
      }
      if (auditor !== null) ticket = await auditor.begin(who!);
    }

    try {
      const bodyLimit = target.maxBodyBytes ?? config.maxBodyBytes;
      checkDeclaredLength(request, bodyLimit);
      const controller = new AbortController();
      const context: RouteContext = {
        request,
        url,
        params,
        principal,
        requestId,
        signal: controller.signal,
        json: (schema) => readJson(request, bodyLimit, schema),
        query: (schema) => readQuery(url, schema),
        audit: (detail) => ticket?.note(detail),
      };
      const result = await within(
        Promise.resolve().then(() => target.handle(context)),
        target.timeoutMs ?? config.requestTimeoutMs,
        () => {
          controller.abort();
          return new ApiError(
            504,
            'timeout',
            target.access === 'write'
              ? 'the request took too long; whether it changed anything is unknown'
              : 'the request took too long'
          );
        }
      );
      const response = toResponse(result);
      await ticket?.finish(response.status);
      return response;
    } catch (error) {
      const failure = toApiError(error, requestId);
      await ticket?.finish(failure.status, failure.code);
      throw error;
    }
  }

  async function handle(request: Request): Promise<Response> {
    const started = performance.now();
    const requestId = requestIdOf(request);
    const origin = request.headers.get('origin');
    const log: LogDraft = {};
    let response: Response;
    try {
      response = await dispatch(request, requestId, origin, log);
    } catch (error) {
      const failure = toApiError(error, requestId);
      if (failure.status >= 500) {
        logger.error('request failed', {
          requestId,
          route: log.route ?? 'unmatched',
          code: failure.code,
          ...describeFailure(error),
        });
      }
      log.errorCode = failure.code;
      response = errorResponse(failure);
    }
    const headers = new Headers(response.headers);
    headers.set('x-request-id', requestId);
    headers.set('x-content-type-options', 'nosniff');
    if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
    for (const [name, value] of Object.entries(corsHeaders(origin, config.corsOrigins) ?? {})) {
      if (!headers.has(name)) headers.set(name, value);
    }
    const final = new Response(response.body, { status: response.status, headers });
    logger.request({
      requestId,
      method: request.method,
      route: log.route ?? 'unmatched',
      status: final.status,
      durationMs: Math.round(performance.now() - started),
      ...(log.role === undefined ? {} : { role: log.role }),
      ...(log.principal === undefined ? {} : { principal: log.principal }),
      ...(log.errorCode === undefined ? {} : { errorCode: log.errorCode }),
    });
    return final;
  }

  return {
    config,
    routes: router.routes,
    maxBodyBytes: Math.max(config.maxBodyBytes, ...routes.map((route) => route.maxBodyBytes ?? 0)),
    handle,
  };
}
