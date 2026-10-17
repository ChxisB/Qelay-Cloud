import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { type ButtonSize, type ButtonVariant, buttonClass } from './Button';

/** A router link that looks like a `Button`: for actions that navigate rather than mutate. */
export function LinkButton({
  children,
  variant = 'default',
  size = 'md',
  className,
  ...props
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; children: ReactNode }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}
