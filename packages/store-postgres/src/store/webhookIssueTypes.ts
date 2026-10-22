import type { WebhookIssueKind, WebhookIssueStatus } from '@qelay-cloud/core';

/** One episode of a route failing (`webhookIssues.ts`). */
export interface IssueRecord {
  readonly id: string;
  readonly webhookId: string;
  readonly status: WebhookIssueStatus;
  readonly kind: WebhookIssueKind;
  readonly openedAt: number;
  /** When the status last changed. */
  readonly updatedAt: number;
  /** The operator who last changed the status; null when Qelay did. */
  readonly updatedBy: string | null;
}

export interface IssueQuery {
  readonly status: WebhookIssueStatus;
  /** Only this webhook's. */
  readonly webhook?: string;
  readonly limit?: number;
  /** An issue id: only older issues. */
  readonly before?: string;
}

export interface IssuePage {
  readonly items: readonly IssueRecord[];
  /** Pass as `before` for the next (older) page; null on the last one. */
  readonly next: string | null;
}

export type IssueCounts = Readonly<Record<WebhookIssueStatus, number>>;

export type IssueResult =
  | { readonly outcome: 'updated'; readonly issue: IssueRecord }
  | { readonly outcome: 'not_found' }
  /** A resolved issue is history: the next failure opens a new one. */
  | { readonly outcome: 'resolved' };
