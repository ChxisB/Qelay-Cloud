import type { WebhookIssueKind, WebhookIssueStatus } from '@qelay-cloud/core';
import { WEBHOOK_ISSUE_STATUSES, webhookPausedBy } from '@qelay-cloud/core';
import type { IssueRecord, WebhookRecord } from '@qelay-cloud/store-postgres';
import { MAX_ISSUE_PAGE } from '@qelay-cloud/store-postgres';
import { z } from 'zod';
import type { Role } from '../types';

/**
 * Issues as the Issues screen reads them (`docs/event-gateway.md`): one record of a route whose deliveries
 * are failing. The store keeps the status; the route's name and streak are joined in from the webhook list,
 * which is bounded, so one request is one page of issues and one read of the routes.
 */

/** `GET /webhooks/issues`: one status (default `open`), optionally one route, newest first. */
export const issuesQuery = z.object({
  status: z.enum(WEBHOOK_ISSUE_STATUSES).optional(),
  webhook: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ISSUE_PAGE).optional(),
  before: z
    .string()
    .regex(/^[1-9]\d{0,15}$/u)
    .optional(),
});

/** `PUT /webhooks/issues/:id`: what the operator sets it to. Any of the four is a request; the store refuses a resolved one. */
export const issueBody = z.strictObject({ status: z.enum(WEBHOOK_ISSUE_STATUSES) });

export interface IssueWire {
  readonly id: string;
  readonly webhookId: string;
  /** The route's name, or null when it has none (or is gone, which the cascade makes brief). */
  readonly webhookName: string | null;
  readonly status: WebhookIssueStatus;
  readonly kind: WebhookIssueKind;
  readonly openedAt: number;
  /** When the status last changed. */
  readonly updatedAt: number;
  /** The operator who last changed the status; null when Qelay did, and for a caller who may not read subjects. */
  readonly updatedBy: string | null;
  /** The route's streak now, and how far it is toward the auto-pause (0 to 4). */
  readonly consecutiveFailures: number;
  readonly alertLevel: number;
  readonly pausedBy: 'operator' | 'failures' | null;
}

/** An operator's subject is for operators (the audit trail is the same), so a viewer gets null. */
export function toIssueWire(
  issue: IssueRecord,
  route: WebhookRecord | undefined,
  role: Role
): IssueWire {
  return {
    id: issue.id,
    webhookId: issue.webhookId,
    webhookName: route?.name ?? null,
    status: issue.status,
    kind: issue.kind,
    openedAt: issue.openedAt,
    updatedAt: issue.updatedAt,
    updatedBy: role === 'operator' ? issue.updatedBy : null,
    consecutiveFailures: route?.consecutiveFailures ?? 0,
    alertLevel: route?.alertLevel ?? 0,
    pausedBy: route ? webhookPausedBy(route) : null,
  };
}
