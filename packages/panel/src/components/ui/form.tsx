import {
  cloneElement,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from 'react';
import { cn } from '@/lib/cn';

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-[13px] font-bold leading-5 text-fg">
      {children}
    </label>
  );
}

/**
 * A row of fields and the buttons that act on them. Fields stay top-aligned so a hint or an error under one
 * field never pushes its neighbours; wrap a button in `FieldAction` so it sits level with the controls.
 */
export function FormRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-start gap-3', className)}>{children}</div>;
}

/** Holds a button (or two) level with the control of the `Field`s next to it: a 20px label line plus the 8px gap. */
export function FieldAction({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mt-7 flex min-h-8 flex-wrap items-center gap-2', className)}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor: explicitHtmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  /** Validation message under the control. Marks a single Input/Select invalid and describes it. */
  error?: ReactNode;
  /** Required when `children` is a compound control rather than one Input/Select. */
  htmlFor?: string;
  children: ReactNode;
}) {
  const autoId = useId();
  const hintId = `${autoId}-hint`;
  const errorId = `${autoId}-error`;
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined;
  // Wire label→control (htmlFor/id) when there's a single element child — the
  // common case. An explicit id is respected; multi-node children (e.g. the
  // env-vars editor) keep the visual label only, as before.
  let control: ReactNode = children;
  let htmlFor = explicitHtmlFor;
  if (!explicitHtmlFor && isValidElement(children)) {
    const el = children as ReactElement<{
      id?: string;
      'aria-invalid'?: boolean;
      'aria-describedby'?: string;
    }>;
    // Do not point a <label> at a layout wrapper (`<div>`, `<span>`, …). Compound
    // fields must provide htmlFor explicitly so the label targets the actual
    // input instead of a non-labellable element.
    const labellableControl =
      (typeof el.type === 'string' && ['input', 'select', 'textarea'].includes(el.type)) ||
      el.type === Input ||
      el.type === Select ||
      el.type === Textarea;
    if (labellableControl) {
      htmlFor = el.props.id ?? autoId;
      control = cloneElement(el, {
        id: htmlFor,
        'aria-invalid': error ? true : el.props['aria-invalid'],
        'aria-describedby':
          [el.props['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined,
      });
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {control}
      {hint && (
        <p id={hintId} className="text-[12px] leading-relaxed text-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-[12px] font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// A compact field, 32px so it lines up with the 32px buttons beside it: 1px field-line border on the card colour.
// index.css pins form controls to 16px below `sm`, so a phone does not zoom the page when the field takes focus.
const controlClass =
  'min-h-8 rounded-control border border-line-strong bg-surface px-2.5 text-[13px] text-fg ' +
  'placeholder:text-faint transition-colors aria-invalid:border-bad focus-visible:border-ring ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-55';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(controlClass, 'w-full', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(controlClass, 'w-full py-2', className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className={cn(controlClass, 'w-full cursor-pointer pr-8', className)} {...props}>
      {children}
    </select>
  );
}

/** On/off switch. The button is the 36x24 target; the track and thumb are drawn inside it. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-9 shrink-0 rounded-full',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0 top-0.5 h-5 w-9 rounded-full transition-colors duration-(--duration-hover) ease-settle',
          checked ? 'bg-ok' : 'bg-line-strong'
        )}
      />
      {/* The thumb slides by transform, with the small overshoot the Motion board gives a switch. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-0.5 top-1 size-4 rounded-full transition-[transform,background-color] duration-(--duration-press) ease-pop',
          checked ? 'translate-x-4 bg-on-ok' : 'translate-x-0 bg-fg'
        )}
      />
    </button>
  );
}

/** Segmented control (filter tabs like All / Waiting / Active / …). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  label = 'View options',
  format,
  asWritten,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  /** Accessible name for this mutually exclusive group. */
  label?: string;
  /** Visible text for an option when it should differ from its value, e.g. to append a count. */
  format?: (option: T) => ReactNode;
  /** Keep the text exactly as `format` writes it, instead of capitalising every word. */
  asWritten?: boolean;
}) {
  return (
    <fieldset className="m-0 inline-flex min-w-0 overflow-hidden rounded-segment border border-line-strong bg-surface p-0">
      <legend className="sr-only">{label}</legend>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          disabled={disabled}
          onClick={() => onChange(opt)}
          className={cn(
            'min-h-[38px] min-w-11 px-4 text-sm transition-colors duration-(--duration-hover) ease-settle',
            !asWritten && 'capitalize',
            'focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring',
            value === opt
              ? 'bg-segment-active font-bold text-fg'
              : 'font-bold text-muted hover:bg-hover',
            disabled && 'cursor-not-allowed opacity-50'
          )}
        >
          {format ? format(opt) : opt}
        </button>
      ))}
    </fieldset>
  );
}
