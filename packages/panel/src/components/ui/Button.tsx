import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'default' | 'ghost' | 'primary' | 'danger';
export type ButtonSize = 'sm' | 'md';
type Variant = ButtonVariant;
type Size = ButtonSize;

// Compact console buttons: a 6px radius, 32px tall (28px small), 1px field-line border, 13px / 600.
// Danger is an outline, never a fill. Disabled (or aria-disabled, which stays focusable) keeps the variant's colours and drops to .5.
const variants: Record<Variant, string> = {
  default: 'border-line-strong bg-transparent text-fg hover:bg-hover',
  ghost: 'border-transparent text-fg hover:bg-hover',
  primary: 'border-transparent bg-primary text-primary-fg hover:brightness-105',
  danger: 'border-danger text-danger hover:bg-danger-tint',
};

const sizes: Record<Size, string> = {
  sm: 'min-h-7 px-2.5 text-xs gap-1.5',
  md: 'min-h-8 px-3 text-sm gap-1.5',
};

// Hover washes the colour over --duration-hover; a press sinks by a hair over --duration-press (the Motion board).
const PRESS =
  'transition-[color,background-color,border-color,transform] duration-(--duration-hover) ease-settle ' +
  'enabled:active:scale-[0.97] enabled:active:duration-(--duration-press)';

const focusAndDisabled =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

/** Class list shared by `Button` and `LinkButton`, so a link can look exactly like a button. */
export function buttonClass(variant: Variant = 'default', size: Size = 'md', className?: string) {
  return cn(
    'inline-flex items-center justify-center whitespace-nowrap rounded-control border font-semibold leading-none',
    PRESS,
    focusAndDisabled,
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
}: ComponentProps<'button'> & {
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

// An icon button is a square on the card colour, bordered by default.
const iconVariants: Record<Variant, string> = {
  ...variants,
  default: 'border-line-strong bg-surface text-fg hover:bg-hover',
};

/** Class list for a round icon control, shared by `IconButton` and an icon-only link. */
export function iconButtonClass(
  variant: Variant = 'default',
  size: Size = 'md',
  className?: string
) {
  return cn(
    'inline-flex shrink-0 items-center justify-center rounded-control border',
    PRESS,
    size === 'sm' ? 'size-7' : 'size-8',
    focusAndDisabled,
    iconVariants[variant],
    className
  );
}

/** Icon-only button for row actions: 32px, or 28px with `size="sm"` for dense rows. */
export function IconButton({
  children,
  className,
  variant = 'default',
  size = 'md',
  ...props
}: ComponentProps<'button'> & {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}) {
  return (
    <button type="button" className={iconButtonClass(variant, size, className)} {...props}>
      {children}
    </button>
  );
}
