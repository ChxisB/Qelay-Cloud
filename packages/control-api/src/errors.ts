import { QcloudError } from '@qelay-cloud/core';
import {
  BatchTooLargeError,
  DestinationInUseError,
  DestinationLimitError,
  DestinationNameTakenError,
  GroupFullError,
  PayloadTooComplexError,
  PayloadTooLargeError,
  RouteChainError,
  RouteCycleError,
  WebhookDisabledError,
  WebhookKeyError,
  WebhookLimitError,
} from '@qelay-cloud/store-postgres';
import type { ErrorBody } from './types';

type Details = Readonly<Record<string, unknown>>;

/**
 * An error that is safe to show a caller: its code, message and details are chosen by this package,
 * never copied from a driver or a cause. Handlers throw it for what they know; everything else goes
 * through `toApiError`, which keeps the cause out of the response.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Details,
    readonly headers: Readonly<Record<string, string>> = {}
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** A Qelay behaviour this service does not have: 501, and the capability the panel can hide a page by. */
  static notSupported(capability: string, message: string): ApiError {
    return new ApiError(501, 'not_supported', message, { capability });
  }

  static invalid(message: string, details?: Details): ApiError {
    return new ApiError(400, 'invalid_request', message, details);
  }

  static notFound(message: string, details?: Details): ApiError {
    return new ApiError(404, 'not_found', message, details);
  }
}

export const errorBody = (error: ApiError): ErrorBody => ({
  error: {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  },
});

/** Maps a failure to what the caller may see. A cause, a stack and SQL text never reach this value. */
export function toApiError(error: unknown, requestId: string): ApiError {
  if (error instanceof ApiError) return error;
  // These three are store errors a caller caused, so they are answered before the generic 503.
  if (error instanceof PayloadTooLargeError) {
    return new ApiError(413, 'payload_too_large', 'a job payload is over the size limit', {
      maxBytes: error.limit,
      index: error.index,
    });
  }
  if (error instanceof PayloadTooComplexError) {
    return new ApiError(
      413,
      'payload_too_large',
      'a job payload has too many values or nests too deep',
      {
        kind: error.kind,
        limit: error.limit,
        index: error.index,
      }
    );
  }
  if (error instanceof BatchTooLargeError) {
    return new ApiError(400, 'batch_too_large', 'too many jobs in one request', {
      maxJobs: error.limit,
    });
  }
  if (error instanceof GroupFullError) {
    return new ApiError(409, 'group_full', 'the job group is at its maximum size', {
      queue: error.queue,
      groupId: error.groupId,
      maxSize: error.maxSize,
      index: error.index,
    });
  }
  // Store errors of webhooks that a caller caused. Each message is written here, none from the error.
  if (error instanceof WebhookLimitError) {
    return new ApiError(409, 'webhook_limit', 'the namespace has the most webhooks it may', {
      limit: error.limit,
    });
  }
  if (error instanceof WebhookKeyError) {
    return new ApiError(
      409,
      'webhook_key_missing',
      'a signing secret needs QCLOUD_WEBHOOK_KEY, and this deployment has none; register the webhook without a secret or configure the key'
    );
  }
  if (error instanceof DestinationLimitError) {
    return new ApiError(
      409,
      'destination_limit',
      'the namespace has the most destinations it may',
      {
        limit: error.limit,
      }
    );
  }
  if (error instanceof DestinationNameTakenError) {
    return new ApiError(409, 'destination_name_taken', 'a destination already has that name');
  }
  if (error instanceof DestinationInUseError) {
    return new ApiError(
      409,
      'destination_in_use',
      'connections are made from the destination; delete or move them first',
      { connections: error.connections }
    );
  }
  if (error instanceof RouteCycleError) {
    return new ApiError(
      409,
      'route_cycle',
      'the route would make a loop: a queue would end up adding jobs to itself'
    );
  }
  if (error instanceof RouteChainError) {
    return new ApiError(
      409,
      'route_chain_too_long',
      'the route would make a chain of routes longer than the most allowed',
      { limit: error.limit }
    );
  }
  if (error instanceof WebhookDisabledError) {
    return new ApiError(409, 'webhook_disabled', 'the webhook is disabled; enable it first');
  }
  if (error instanceof QcloudError) {
    // Each message below is written here: the typed errors carry a `cause` that can hold SQL.
    switch (error.code) {
      case 'JOB_NOT_FOUND':
        return new ApiError(404, 'job_not_found', 'job not found', field(error, 'jobId'));
      case 'JOB_STATE': {
        const state = (error as { state?: string | null }).state ?? null;
        if (state === null) {
          return new ApiError(404, 'job_not_found', 'job not found', field(error, 'jobId'));
        }
        return new ApiError(409, 'job_state', `the job is ${state}, so the action does not apply`, {
          ...field(error, 'jobId'),
          state,
        });
      }
      case 'JOB_VERSION': {
        const stale = error as { jobId?: string; expected?: number; actual?: number };
        return new ApiError(
          409,
          'version_conflict',
          'the job changed since it was read, so nothing was changed',
          { jobId: stale.jobId, expectedVersion: stale.expected, actualVersion: stale.actual }
        );
      }
      case 'LEASE_LOST':
        return new ApiError(409, 'lease_lost', 'the lease on the job is no longer held');
      case 'QUEUE_PAUSED':
        return new ApiError(409, 'queue_paused', 'the queue is paused', field(error, 'queue'));
      case 'ILLEGAL_TRANSITION':
        return new ApiError(409, 'illegal_transition', 'the job cannot make that transition');
      case 'FLOW_PROTECTED':
        return new ApiError(
          409,
          'flow_protected',
          'a live flow parent still waits on it, so nothing was changed'
        );
      case 'FLOW_INVALID':
        return new ApiError(400, 'flow_invalid', error.message);
      case 'UNSUPPORTED_OPTION':
        return new ApiError(400, 'unsupported_option', error.message, field(error, 'option'));
      case 'TRANSPORT_ERROR':
        return new ApiError(502, 'transport_error', 'the message transport failed');
      case 'STORE_ERROR':
        return new ApiError(503, 'store_error', 'the database failed');
      case 'STORE_OVERLOADED':
        return new ApiError(
          503,
          'store_overloaded',
          'the API is busy; nothing was changed, try again shortly'
        );
      case 'OPERATION_DEADLINE':
        return new ApiError(
          504,
          'operation_deadline',
          'the database did not answer in time; whether the change was applied is unknown'
        );
      case 'OUTCOME_UNKNOWN':
        return new ApiError(
          504,
          'outcome_unknown',
          'the result of the change was not confirmed; read the job before trying again'
        );
    }
  }
  return new ApiError(500, 'internal_error', 'internal error', { requestId });
}

/** One own, string-valued field of a typed error, as a details object. */
function field(error: QcloudError, name: string): Details | undefined {
  const value = (error as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' ? { [name]: value } : undefined;
}
