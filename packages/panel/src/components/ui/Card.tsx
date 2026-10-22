import type { CSSProperties, ElementType, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({
  children,
  className,
  style,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  /** For a card's place in a stagger (`stagger(i)`), nothing else. */
  style?: CSSProperties;
  padded?: boolean;
}) {
  return (
    <div
      style={style}
      className={cn(
        'rounded-card border border-line bg-surface shadow-panel',
        padded && 'p-4',
        className
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  action,
  icon,
  sub,
  headingLevel = 2,
}: {
  title: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  /** One line under the title saying what the card shows. */
  sub?: ReactNode;
  /** Match the card to the surrounding document outline. Page-level cards are h2 by default. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
}) {
  const Heading = `h${headingLevel}` as ElementType;
  const heading = (
    <Heading className="flex items-center gap-2 text-base font-semibold leading-tight text-fg">
      {icon}
      {title}
    </Heading>
  );
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      {sub ? (
        <div>
          {heading}
          <p className="mt-0.5 text-xs text-muted">{sub}</p>
        </div>
      ) : (
        heading
      )}
      {action}
    </div>
  );
}

/** Section title used above tables/blocks on a page. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="text-base font-semibold leading-tight text-fg">{children}</h2>
      {action}
    </div>
  );
}
