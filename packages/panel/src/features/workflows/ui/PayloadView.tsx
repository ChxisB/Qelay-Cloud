import type { ReactNode } from 'react';
import { containsTruncation, hasValue, printValue } from '../domain/workflowDisplay';

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="mt-0.5 break-words text-muted">{value}</dd>
    </div>
  );
}

/**
 * A payload as the server sent it. A value cut at the server's size limit says so beside it: the
 * panel never passes a marker off as the value.
 */
export function PayloadView({
  value,
  truncated,
  empty = 'None',
  label,
}: {
  value: unknown;
  truncated?: boolean | undefined;
  empty?: string;
  label?: string;
}) {
  if (!hasValue(value)) return <p className="text-xs text-faint">{empty}</p>;
  const cut = truncated === true || containsTruncation(value);
  return (
    <div className="space-y-1">
      {cut && (
        <p role="note" className="text-xs text-warning">
          Part of this value is cut at the server's size limit.
        </p>
      )}
      <pre
        aria-label={label}
        className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-5 text-muted"
      >
        {printValue(value)}
      </pre>
    </div>
  );
}
