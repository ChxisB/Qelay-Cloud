import { Disclosure } from '@/components/ui/Disclosure';
import { FLOW_BULK_RETRY_UNAVAILABLE } from '@/lib/flowMutationSafety';

/** Says once that retrying and purging failed jobs is switched off here; the exact reason is one click away. */
export function DlqUnavailableNote({ className }: { className?: string }) {
  return (
    <div className={className}>
      <p className="text-[13px] text-muted">
        Retrying and purging failed jobs from here is switched off on this server.
      </p>
      <Disclosure summary="Why?">
        <p className="text-[13px] text-muted">{FLOW_BULK_RETRY_UNAVAILABLE}</p>
      </Disclosure>
    </div>
  );
}
