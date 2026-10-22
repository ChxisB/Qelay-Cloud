import type { ReactNode } from 'react';
import { Banner } from '@/components/ui/Banner';
import { CopyButton } from '@/components/ui/CopyButton';

/**
 * A signing secret the server showed once. The caller keeps it in state only: not in the address, in
 * storage or in a toast.
 */
export function SecretBanner({
  secret,
  title,
  action,
  children,
}: {
  secret: string;
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <Banner tone="info" title={title} action={action}>
      {children}
      <span className="mt-2 flex items-center gap-1.5">
        <code className="break-all rounded-md bg-surface px-2 py-1 font-mono text-xs text-fg">
          {secret}
        </code>
        <CopyButton value={secret} />
      </span>
    </Banner>
  );
}
