import type { AuditApi, AuditIntent } from '@qelay-cloud/store-postgres';
import type { Principal } from '../auth/principal';
import { ApiError } from '../errors';
import type { Logger } from '../http/log';
import type { Route } from '../http/router';

/** What an operator mutation is, as the audit entry will say it. */
export interface AuditSubject {
  readonly principal: Principal;
  readonly route: Route;
  readonly params: Readonly<Record<string, string>>;
  readonly requestId: string;
}

/** One accepted operation's entry, from the write before it runs to the answer. */
export interface AuditTicket {
  /** Adds an identifier the path does not carry (a cron's name, from the body). Never a payload. */
  note(detail: string): void;
  /** Closes the entry with the answer. Never throws: the operation already ran. */
  finish(status: number, code?: string): Promise<void>;
}

export interface Auditor {
  /** Records a request that was refused before it ran (role, rate limit). Never throws. */
  refused(subject: AuditSubject, status: number, code: string): Promise<void>;
  /**
   * Writes the entry as `pending` and returns its ticket. When the log cannot take it this throws
   * 503 `audit_unavailable`, and the operation does not run: a change that cannot be recorded is
   * not made.
   */
  begin(subject: AuditSubject): Promise<AuditTicket>;
}

/** The path parameters as `name=value` pairs: identifiers only, never the query or the body. */
function targetOf(params: Readonly<Record<string, string>>, details: readonly string[]): string {
  return [...Object.entries(params).map(([name, value]) => `${name}=${value}`), ...details].join(
    ' '
  );
}

const intentOf = (subject: AuditSubject, details: readonly string[] = []): AuditIntent => ({
  subject: subject.principal.subject,
  role: subject.principal.role,
  source: subject.principal.source,
  requestId: subject.requestId,
  action: `${subject.route.method} ${subject.route.path}`,
  target: targetOf(subject.params, details),
});

export function createAuditor(log: AuditApi, logger: Logger): Auditor {
  return {
    async refused(subject, status, code) {
      try {
        await log.record(intentOf(subject), { outcome: 'rejected', status, reason: code });
      } catch {
        // The refusal is already the answer; the entry is lost, and the access log has the request.
        logger.warn('audit entry of a refused request was not written', {
          requestId: subject.requestId,
          code,
        });
      }
    },

    async begin(subject) {
      const details: string[] = [];
      let id: number;
      try {
        id = await log.begin(intentOf(subject));
      } catch {
        logger.error('audit log unavailable; the change was refused', {
          requestId: subject.requestId,
        });
        throw new ApiError(
          503,
          'audit_unavailable',
          'the change was not made because it could not be recorded'
        );
      }
      return {
        note: (detail) => {
          if (details.length < 4) details.push(detail);
        },
        async finish(status, code) {
          const outcome = status < 400 ? 'success' : status < 500 ? 'rejected' : 'failed';
          try {
            // The target is written again with what the handler added: the first write could not know it.
            await log.finish(id, {
              outcome,
              status,
              ...(code === undefined ? {} : { reason: code }),
              ...(details.length === 0 ? {} : { target: targetOf(subject.params, details) }),
            });
          } catch {
            // The entry stays `pending`: the intent is on record, the outcome is not.
            logger.warn('audit entry was not closed', { requestId: subject.requestId, status });
          }
        },
      };
    },
  };
}
