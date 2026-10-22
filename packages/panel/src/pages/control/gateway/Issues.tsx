import { useSearchParams } from 'react-router-dom';
import { Banner } from '@/components/ui/Banner';
import { EmptyState, ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { LinkTabs } from '@/components/ui/LinkTabs';
import { bq, BqError, WEBHOOK_ISSUE_STATUSES, type WebhookIssueStatus } from '@/lib/bq';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { usePolledData } from '@/lib/usePolledData';
import { useRowArrivals } from '@/lib/useRowArrivals';
import { DerivedIssues } from './DerivedIssues';
import { GatewayPage } from './GatewayPage';
import { IssueCard, STATUS_WORDS } from './IssueCard';
import { useIssueActions } from './useIssueActions';
import { useRouteActions } from './useRouteActions';

const ISSUES = '/events-gateway/issues';
/** One page is the most the API sends; past it the list says so. */
const PAGE = 200;

const NOTHING: Record<WebhookIssueStatus, { title: string; hint: string }> = {
  open: {
    title: 'No open issues',
    hint: 'Every connection is delivering. A connection shows up here when its events keep failing, and stays until it recovers or you resolve it.',
  },
  acknowledged: {
    title: 'Nothing acknowledged',
    hint: 'An issue you acknowledge moves here, so the team knows someone is looking at it.',
  },
  resolved: {
    title: 'Nothing resolved yet',
    hint: 'An issue resolves itself when the connection delivers again, and you can resolve one by hand. The next failure opens a new issue.',
  },
  ignored: {
    title: 'Nothing ignored',
    hint: 'An issue you ignore moves here and stays out of the open list until you reopen it.',
  },
};

/** A server from before issues answers the route with a not-found or not-allowed; every other failure is a failure. */
const predatesIssues = (error: Error | null) =>
  error instanceof BqError && (error.status === 404 || error.status === 405);

/**
 * What needs a person: one issue per connection whose deliveries are failing, in four tabs by status. A server
 * that keeps no issues gets the list worked out from the connections' own failure counts instead.
 */
export function Issues() {
  const [params] = useSearchParams();
  const status = WEBHOOK_ISSUE_STATUSES.find((name) => name === params.get('status')) ?? 'open';
  const canOperate = useCanOperate();
  const read = usePolledData(() => bq.webhookIssues({ status, limit: PAGE }), [status]);
  const routes = usePolledData(() => bq.webhooks(), []);
  const refetchBoth = async () => {
    await Promise.all([read.refetch(), routes.refetch()]);
  };
  const { pending, error: actionError, setStatus } = useIssueActions(refetchBoth);
  const { actErr, optimistic, toggleEnabled } = useRouteActions(refetchBoth);
  const list = routes.data?.data?.webhooks ?? [];
  const legacy = !read.data && predatesIssues(read.error);
  const failed = legacy ? routes : read;
  const page = read.data;
  const problem = actionError ?? actErr;
  const arrival = useRowArrivals(status, page?.issues.map((issue) => issue.id) ?? [], !!page);

  return (
    <GatewayPage
      current={ISSUES}
      live={legacy ? !!routes.data && !routes.error : !!page && !read.error}
    >
      {!legacy && page && (
        <LinkTabs
          label="Issue status"
          tabs={WEBHOOK_ISSUE_STATUSES.map((name) => ({
            to: name === 'open' ? ISSUES : `${ISSUES}?status=${name}`,
            label: `${STATUS_WORDS[name]} ${page.counts[name]}`,
            current: name === status,
          }))}
        />
      )}
      {failed.error && failed.data && (
        <OfflineBanner
          message="Issue refresh failed — showing the last successful list."
          onRetry={failed.refetch}
        />
      )}
      {problem && (
        <div className="mb-6">
          <Banner tone="problem" title="The change did not go through">
            {problem}
          </Banner>
        </div>
      )}
      {failed.error && !failed.data ? (
        <ErrorState error={failed.error} onRetry={failed.refetch} />
      ) : failed.loading && !failed.data ? (
        <LoadingState label="Loading issues…" />
      ) : legacy ? (
        <DerivedIssues
          routes={list}
          optimistic={optimistic}
          onResume={(id) => toggleEnabled(id, true)}
        />
      ) : page && page.issues.length === 0 ? (
        <EmptyState title={NOTHING[status].title} hint={NOTHING[status].hint} />
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {page?.issues.map((issue, index) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                route={list.find((route) => route.id === issue.webhookId) ?? null}
                canOperate={canOperate}
                busy={pending === issue.id}
                arrive={arrival(issue.id, index)}
                onSet={(next) => void setStatus(issue.id, next)}
                onResume={() => toggleEnabled(issue.webhookId, true)}
              />
            ))}
          </ul>
          {page?.next && (
            <p className="mt-3 text-[13px] text-muted">
              Showing the newest {PAGE}. Resolve or ignore some to see older ones.
            </p>
          )}
        </>
      )}
    </GatewayPage>
  );
}
