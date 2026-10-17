import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { LinkButton } from '@/components/ui/LinkButton';
import { PageHeader } from '@/components/ui/PageHeader';
import { api } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { usePolledData } from '@/lib/usePolledData';
import { Facts } from './deployment/Facts';
import { WarningList } from './deployment/WarningList';

/**
 * Is this deployment healthy, and if not, what is wrong? Read-only: the server reports what it
 * measured and never a connection string, token or any other secret.
 */
export function Deployment() {
  const { data, error, loading, refetch } = usePolledData(() => api.deployment(), []);

  if (loading && !data && !error) return <LoadingState label="Loading deployment…" />;
  if (error && !data) {
    return (
      <div>
        <PageHeader title="Deployment" description="The deployment report is unavailable." />
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Deployment"
        description={`Whether the database, the transport and the tick are healthy. Read ${formatRelativeTime(data.timestamp)}.`}
        actions={
          <LinkButton to="/transport" variant="ghost">
            Transport
          </LinkButton>
        }
      />
      {error && (
        <OfflineBanner
          message="Connection lost — showing the last successful reading."
          onRetry={refetch}
        />
      )}
      <WarningList warnings={data.warnings} />
      <Facts deployment={data} />
    </div>
  );
}
