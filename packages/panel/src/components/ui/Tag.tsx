import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type TagTone = 'neutral' | 'gcp' | 'aws';

// Border in the glyph shade, text in the contrast-tested state shade (aqua for GCP, amber for AWS).
const tones: Record<TagTone, string> = {
  neutral: 'border-line-strong text-fg',
  gcp: 'border-active/60 text-state-active-fg',
  aws: 'border-warn/60 text-state-waiting-fg',
};

/** Small outlined label, for example the transport a queue runs on. */
export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: TagTone }) {
  return (
    <span
      className={cn(
        'inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-bold',
        tones[tone]
      )}
    >
      {children}
    </span>
  );
}
