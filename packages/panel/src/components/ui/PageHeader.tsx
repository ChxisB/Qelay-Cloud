import type { ReactNode } from 'react';
import { StatusDot } from './StatusBadge';

export function PageHeader({
  title,
  description,
  live,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  live?: boolean;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-start gap-3">
        {back}
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold leading-tight tracking-[-0.01em] text-balance text-fg">
              {title}
            </h1>
            {live && <StatusDot label="Live" tone="green" />}
          </div>
          {description && (
            <p className="mt-1 max-w-[680px] text-sm text-pretty text-muted">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
