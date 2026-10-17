import { ApiError } from '../errors';
import type { Method, Route } from '../http/router';

/**
 * The panel's pages for a Qelay TCP server, an embedded SQLite database, S3 backups and a fleet of
 * servers, and its queue-operations card that talks to a local control agent, have no meaning on a
 * managed queue. Their API prefixes answer 501 `not_supported` naming the capability, the same names
 * `GET /capabilities` lists under `hidden`, so a client that ignores the flag gets a clear refusal
 * and not a 404 that looks like a bug.
 */
const PREFIXES: ReadonlyArray<readonly [prefix: string, capability: string]> = [
  ['/server', 'serverControl'],
  ['/database', 'sqliteDatabase'],
  ['/backup', 's3Backup'],
  ['/fleet', 'fleet'],
  ['/queue-operations', 'queueOperations'],
];

const METHODS: readonly Method[] = ['GET', 'POST', 'PUT', 'DELETE'];

export function unsupportedRoutes(): Route[] {
  return PREFIXES.flatMap(([prefix, capability]) =>
    METHODS.map((method): Route => ({
      method,
      path: `${prefix}/*`,
      // A refused attempt to change a server is still an attempt: it is audited and needs an operator.
      access: method === 'GET' ? 'read' : 'write',
      handle() {
        throw ApiError.notSupported(
          capability,
          `${capability} does not apply to a managed queue: this deployment has no such feature`
        );
      },
    }))
  );
}
