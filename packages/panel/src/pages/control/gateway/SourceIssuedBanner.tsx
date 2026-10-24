import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import type { Issued } from './sourceModel';

const Copyable = ({ label, value }: { label: string; value: string }) => (
  <span className="mt-2 flex flex-wrap items-center gap-1.5">
    <span className="text-xs">{label}</span>
    <code className="break-all rounded-md bg-surface px-2 py-1 font-mono text-xs text-fg">
      {value}
    </code>
    <CopyButton value={value} />
  </span>
);

/**
 * The address and the secret of a source, which the server shows once and keeps no copy of. They stay in this
 * component's state: not in the address bar, in storage or in a toast. The page waits for Done.
 */
export function SourceIssuedBanner({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  return (
    <Banner
      tone="info"
      title={`Copy the details of "${issued.name}" now`}
      action={<Button onClick={onDone}>Done</Button>}
    >
      They are shown once. Put the address in the sender before you leave this page.
      {issued.path && (
        <>
          <Copyable label="Path" value={issued.path} />
          <span className="mt-1 block text-xs">
            Post to your ingest address followed by this path.
          </span>
        </>
      )}
      {issued.secret && <Copyable label="Secret" value={issued.secret} />}
    </Banner>
  );
}
