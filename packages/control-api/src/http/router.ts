import type { z } from 'zod';
import type { Principal } from '../auth/principal';

/** Who may call a route: anyone, any authenticated principal, or an `operator`. Only `/health` is public. */
export type Access = 'public' | 'read' | 'write';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteContext {
  readonly request: Request;
  readonly url: URL;
  /** Path parameters, percent-decoded. */
  readonly params: Readonly<Record<string, string>>;
  /** Null on a public route. */
  readonly principal: Principal | null;
  readonly requestId: string;
  /** Aborted when the request's time is up. */
  readonly signal: AbortSignal;
  /** The JSON body, read under the size cap and parsed with `schema`. 400 for a body that does not parse or fit. */
  json<T>(schema: z.ZodType<T>): Promise<T>;
  /** The query string parsed with `schema` (use `z.coerce` for numbers). 400 for one that does not fit. */
  query<T>(schema: z.ZodType<T>): T;
  /**
   * Adds an identifier the path does not carry to this request's audit entry, such as a cron's name
   * from its body. Identifiers only, never a payload. A no-op where no audit log is configured.
   */
  audit(detail: string): void;
}

export interface Route {
  readonly method: Method;
  /** For example `/queues/:queue/jobs`. A `:name` segment matches one non-empty segment. */
  readonly path: string;
  readonly access: Access;
  /** A `read` route that only an operator may call (it lists other people's subjects or names jobs). Not audited or rate-limited, unlike `write`. */
  readonly operatorOnly?: true;
  /** Overrides the default body cap, in bytes. */
  readonly maxBodyBytes?: number;
  /** Overrides the default request time, in ms. */
  readonly timeoutMs?: number;
  /** A `Response` is sent as it is; any other value is sent as JSON with status 200; `undefined` is a 204. */
  handle(context: RouteContext): unknown;
}

export type Match =
  | { readonly kind: 'found'; readonly route: Route; readonly params: Record<string, string> }
  | { readonly kind: 'method'; readonly allowed: readonly Method[] }
  | { readonly kind: 'none' };

interface Compiled {
  readonly route: Route;
  readonly segments: readonly string[];
  /** The last segment is `*`: it matches one or more trailing segments. */
  readonly wildcard: boolean;
}

const split = (path: string): string[] => {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed.split('/').slice(1);
};

/**
 * A small router: literal and `:param` segments, a trailing `*`, and methods. A route with more
 * literal segments wins over one with parameters (`/queues/summary` over `/queues/:queue`), and of
 * two with as many parameters the one whose first parameter comes later wins (`/jobs/custom/:id` over
 * `/jobs/:id/logs`). A route ending in `*` matches any longer path and is tried last. Registering the
 * same method and shape twice throws, so a clash is found at startup and not by a caller.
 */
export class Router {
  readonly #routes: Compiled[] = [];

  constructor(routes: readonly Route[]) {
    const seen = new Set<string>();
    for (const route of routes) {
      if (!route.path.startsWith('/'))
        throw new Error(`route path must start with "/": ${route.path}`);
      const segments = split(route.path);
      const wildcard = segments.at(-1) === '*';
      if (segments.slice(0, -1).includes('*')) {
        throw new Error(`"*" may only be the last segment: ${route.path}`);
      }
      const shape = `${route.method} /${segments.map((s) => (s.startsWith(':') ? ':' : s)).join('/')}`;
      if (seen.has(shape)) throw new Error(`route registered twice: ${route.method} ${route.path}`);
      seen.add(shape);
      this.#routes.push({ route, segments, wildcard });
    }
    const params = (c: Compiled) => c.segments.filter((s) => s.startsWith(':')).length;
    const firstParam = (c: Compiled) => c.segments.findIndex((s) => s.startsWith(':'));
    this.#routes.sort(
      (a, b) =>
        Number(a.wildcard) - Number(b.wildcard) ||
        params(a) - params(b) ||
        firstParam(b) - firstParam(a) ||
        (a.wildcard ? b.segments.length - a.segments.length : 0)
    );
  }

  get routes(): readonly Route[] {
    return this.#routes.map((compiled) => compiled.route);
  }

  match(method: string, pathname: string): Match {
    const parts = split(pathname);
    const allowed = new Set<Method>();
    for (const { route, segments, wildcard } of this.#routes) {
      if (wildcard ? parts.length < segments.length : parts.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let fits = true;
      const fixed = wildcard ? segments.length - 1 : segments.length;
      for (let i = 0; i < fixed && fits; i++) {
        const want = segments[i]!;
        const have = parts[i]!;
        if (want.startsWith(':')) {
          const decoded = decode(have);
          if (decoded === null || decoded === '') fits = false;
          else params[want.slice(1)] = decoded;
        } else fits = want === have;
      }
      if (!fits) continue;
      if (route.method === method) return { kind: 'found', route, params };
      allowed.add(route.method);
    }
    return allowed.size === 0 ? { kind: 'none' } : { kind: 'method', allowed: [...allowed] };
  }
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
