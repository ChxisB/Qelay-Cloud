import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BannerTone = 'problem' | 'warn' | 'info' | 'ok';

// A 16% tint of the state colour (the same backgrounds as the pills), so ink text clears 4.5:1.
const tones: Record<BannerTone, string> = {
  problem: 'bg-danger-tint',
  warn: 'bg-state-waiting-bg',
  info: 'bg-state-active-bg',
  ok: 'bg-state-completed-bg',
};

/**
 * The design's banner: a title, one sentence and an optional action. A problem is announced
 * assertively (`role="alert"`), everything else politely (`role="status"`). The title is
 * the word that names the tone, so colour never carries it alone.
 */
export function Banner({
  tone = 'problem',
  title,
  action,
  children,
}: {
  tone?: BannerTone;
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      role={tone === 'problem' ? 'alert' : 'status'}
      className={cn(
        'motion-arrive flex flex-wrap items-center gap-4 rounded-card border border-line px-4 py-[18px]',
        tones[tone]
      )}
    >
      <div className="min-w-0 flex-[1_1_320px]">
        <strong className="block font-bold text-fg">{title}</strong>
        {children && <span className="text-muted">{children}</span>}
      </div>
      {action}
    </div>
  );
}
