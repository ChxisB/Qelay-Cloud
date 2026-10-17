import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'default' | 'ghost' | 'primary' | 'danger';
export type ButtonSize = 'sm' | 'md';
type Variant = ButtonVariant;
type Size = ButtonSize;

// Measurements follow the design's components board: 36px tall, 10px radius, 13px / 600.
// Danger is an outline, never a fill. Disabled keeps the variant's colours and drops to .4.
const variants: Record<Variant, string> = {
  default: 'border border-line-strong bg-transparent text-fg hover:bg-surface-2 light:bg-surface',
  ghost: 'border border-transparent text-muted hover:bg-surface-2 hover:text-fg',
  primary: 'border border-transparent bg-primary text-primary-fg hover:opacity-90',
  danger: 'border border-danger/45 text-danger hover:bg-danger/10 light:border-danger/40',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-[13px] gap-2',
};

/** Class list shared by `Button` and `LinkButton`, so a link can look exactly like a button. */
export function buttonClass(variant: Variant = 'default', size: Size = 'md', className?: string) {
  return cn(
    'inline-flex items-center justify-center rounded-control font-semibold transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:cursor-not-allowed disabled:opacity-40',
    variants[variant],
    sizes[size],
    className
  );
}

export function Button({
  children,
  variant = 'default',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}) {
  return (
    <button type="button" className={buttonClass(variant, size, className)} {...props}>
      {children}
    </button>
  );
}

/** Square icon-only button for row actions. */
export function IconButton({
  children,
  className,
  variant = 'ghost',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-control transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-40',
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
