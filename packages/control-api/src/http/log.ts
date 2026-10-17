import { createHash } from 'node:crypto';

/**
 * One line per request. The record holds the route pattern, never the path (a path carries queue
 * names and job ids), and never a query, a header, a body or an error message from a driver.
 */
export interface RequestLog {
  readonly requestId: string;
  readonly method: string;
  /** The pattern that matched, for example `/queues/:queue/jobs`, or `unmatched`. */
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  /** Absent when the request was not authenticated. */
  readonly role?: string;
  /** A short hash of the principal, so one caller's requests can be followed without naming them. */
  readonly principal?: string;
  /** The API error code, or `internal_error` for a failure that was not one. */
  readonly errorCode?: string;
}

export interface Logger {
  request(record: RequestLog): void;
  /** A failure outside the request path, or a cause that must reach the operator but not the caller. */
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** JSON lines on stdout (stderr for errors), the shape Cloud Logging and CloudWatch both parse. */
export function jsonLogger(
  write: (line: string, level: 'info' | 'warn' | 'error') => void = (line, level) => {
    (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
  }
): Logger {
  const emit = (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>) => {
    write(JSON.stringify({ time: new Date().toISOString(), level, ...fields }), level);
  };
  return {
    request: (record) => emit('info', { msg: 'request', ...record }),
    warn: (msg, fields) => emit('warn', { msg, ...fields }),
    error: (msg, fields) => emit('error', { msg, ...fields }),
  };
}

export const silentLogger: Logger = { request() {}, error() {}, warn() {} };

/** First 12 hex digits of the SHA-256 of a principal's subject. */
export const principalHash = (subject: string): string =>
  createHash('sha256').update(subject).digest('hex').slice(0, 12);

/**
 * What may be logged about an unexpected failure: its type and, for a database error, the SQLSTATE or
 * system code. The message is left out because a driver puts query text in it.
 */
export function describeFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const code = (error as { code?: unknown }).code;
  return {
    errorType: error.name,
    ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}),
  };
}
