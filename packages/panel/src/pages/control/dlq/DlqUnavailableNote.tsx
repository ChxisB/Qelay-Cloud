import { Disclosure } from '@/components/ui/Disclosure';
import { FLOW_BULK_RETRY_UNAVAILABLE } from '@/lib/flowMutationSafety';

/** Says once that retrying failed jobs is switched off, for a server that still lists `dlq-retry` as unsupported. */
export function DlqUnavailableNote({ className }: { className?: string }) {
  return (
    <div className={className}>
      <p className="text-[13px] text-muted">
        Retrying failed jobs from here is switched off on this server.
      </p>
      <Disclosure summary="Why?">
        <p className="text-[13px] text-muted">{FLOW_BULK_RETRY_UNAVAILABLE}</p>
      </Disclosure>
    </div>
  );
}
