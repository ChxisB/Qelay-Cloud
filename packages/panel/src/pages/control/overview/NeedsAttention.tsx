import { IconDlq } from '@/components/ui/icons';
import { LinkButton } from '@/components/ui/LinkButton';
import type { Attention } from './attention';

export function NeedsAttention({ attention }: { attention: Attention }) {
  return (
    <section
      aria-label="Needs attention"
      className="flex flex-wrap items-center gap-x-5 gap-y-4 rounded-card border border-danger/40 bg-surface px-5 py-[18px]"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-state-failed-bg text-danger">
        <IconDlq className="size-5" />
      </div>
      <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
        <div className="eyebrow text-muted">Needs attention</div>
        <div className="text-base font-semibold tracking-[-0.01em] text-fg">
          {attention.headline}
        </div>
        <div className="text-[13px] text-muted">{attention.detail}</div>
      </div>
      <LinkButton to={attention.reviewTo} variant="primary">
        {attention.reviewLabel}
      </LinkButton>
    </section>
  );
}
