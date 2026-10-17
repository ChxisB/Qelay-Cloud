/**
 * Reads what the Control API says when a request fails: `{ error: { code, message, details? } }`.
 * The first-generation clients read `error` as a string, so the object showed up as
 * "[object Object]"; both shapes are accepted here (a few fixtures and `{ ok: false, error }`
 * replies still carry a string). One reader, so the wording of a 401, 403, 409 or 501 is
 * the same in every client.
 */
export interface ErrorInfo {
  readonly message: string;
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

const sentence = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function wording(status: number, code: string | undefined, server: string): string {
  if (status === 403) return `You do not have permission to do this. ${sentence(server)}`;
  if (status === 409 && code === 'version_conflict') {
    return 'This job changed since it was loaded, so nothing was changed. Reload it and try again.';
  }
  if (status === 501) return `Not available in this deployment. ${sentence(server)}`;
  return sentence(server);
}

/** `parsed` is the JSON body of the reply (or anything else when it was not JSON). */
export function errorInfoFrom(parsed: unknown, status: number): ErrorInfo {
  const fallback = { message: `HTTP ${status}` };
  if (!isRecord(parsed)) return fallback;
  const { error } = parsed;
  if (typeof error === 'string') return error ? { message: error } : fallback;
  if (!isRecord(error)) return fallback;
  const { code, message, details } = error;
  if (typeof message !== 'string' || !message) return fallback;
  const known = typeof code === 'string' ? code : undefined;
  return {
    message: wording(status, known, message),
    ...(known ? { code: known } : {}),
    ...(isRecord(details) ? { details } : {}),
  };
}

const statusOf = (error: unknown): number | undefined =>
  isRecord(error) && typeof error.status === 'number' ? error.status : undefined;

/** 501: the action is closed in this deployment (`not_supported`); the UI says so neutrally. */
export const isNotSupported = (error: unknown): boolean => statusOf(error) === 501;

/** 409 `version_conflict`: the job changed since it was read; reload and ask again. */
export const isVersionConflict = (error: unknown): boolean =>
  statusOf(error) === 409 && isRecord(error) && error.code === 'version_conflict';

/** 403: the caller's role may not do it. */
export const isForbidden = (error: unknown): boolean => statusOf(error) === 403;
