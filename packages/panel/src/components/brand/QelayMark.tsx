import { useId } from 'react';

// Native size of the mark's viewBox. The sidebar draws it at 34 wide.
const VIEW_W = 204;
const VIEW_H = 152;

export type QelayMarkProps = {
  /** Rendered width in px; the height follows the mark's 204:152 ratio. */
  size?: number;
  className?: string;
  /** Accessible name. Ignored when `decorative`. */
  title?: string;
  /** `gradient` is the brand mark; `mono` takes the surrounding text colour. */
  variant?: 'gradient' | 'mono';
  /** Hide from assistive tech when a visible "Qelay" label sits next to it. */
  decorative?: boolean;
};

/**
 * The Qelay mark: a "Q" ring open on the left, a tail, and two input lines
 * feeding in from the left, ending in a dot. The gradient id is unique per instance because `<defs>` ids
 * are page-global and two marks on one page must not share `url(#…)`.
 */
export function QelayMark({
  size = 34,
  className,
  title = 'Qelay mark',
  variant = 'gradient',
  decorative = false,
}: QelayMarkProps) {
  const gradientId = `qelay-g-${useId().replace(/[^\w-]/g, '')}`;
  const paint = variant === 'mono' ? 'currentColor' : `url(#${gradientId})`;
  return (
    <svg
      width={size}
      height={Math.round((size * VIEW_H) / VIEW_W)}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative || undefined}
      focusable="false"
      className={className}
      style={{ display: 'block' }}
    >
      {variant === 'gradient' && (
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="14"
            y1="8"
            x2="190"
            y2="144"
          >
            <stop offset="0" stopColor="#FF7A00" />
            <stop offset="0.5" stopColor="#FF3D61" />
            <stop offset="1" stopColor="#7A3DFF" />
          </linearGradient>
        </defs>
      )}
      <g fill="none" stroke={paint} strokeLinecap="round">
        <path d="M87 47.3A50 50 0 1 1 87 104.7" strokeWidth="36" />
        <path d="M162 110L186 134" strokeWidth="26" />
        <path d="M48 68H84" strokeWidth="16" />
        <path d="M34 92H86" strokeWidth="16" />
      </g>
      <circle cx="14" cy="68" r="8" fill={paint} />
    </svg>
  );
}
