import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { IconSearch } from './icons';

// The viewer is a terminal: dark in both themes, on the `log-*` tokens.
export type LogLevel = 'info' | 'error' | 'warn' | 'ok' | 'cmd' | 'dim';

const TEXT: Record<LogLevel, string> = {
  info: 'text-log-fg',
  error: 'text-log-err',
  warn: 'text-log-warn',
  ok: 'text-log-ok',
  cmd: 'text-log-cmd',
  dim: 'text-log-dim',
};

// Error and warning also carry a word, so the level is not told by colour alone.
const BADGE: Partial<Record<LogLevel, string>> = { error: 'ERROR', warn: 'WARN' };

export function LogBox({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-[20px] border border-line-strong bg-log-bg text-log-fg',
        className
      )}
      {...props}
    />
  );
}

/** Toolbar row above the lines: search, level chips, actions. */
export function LogBar({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2.5 border-b border-log-line bg-log-bar px-4 py-3',
        className
      )}
      {...props}
    />
  );
}

export function LogSearch({ className, ...props }: ComponentProps<'input'>) {
  return (
    <label className="flex min-h-8 max-w-[340px] min-w-0 flex-[1_1_240px] items-center gap-2.5 rounded-control border border-line-strong bg-log-bg pr-3 pl-4 text-log-faint focus-within:border-ring focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
      <IconSearch className="size-4 shrink-0" />
      <input
        type="search"
        className={cn(
          'min-w-0 flex-1 bg-transparent text-[13px] text-log-fg outline-none placeholder:text-log-faint',
          className
        )}
        {...props}
      />
    </label>
  );
}

/** Level filter: a pill with an optional count. `pressed` fills it in the action colours. */
export function LogChip({
  pressed,
  count,
  className,
  children,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-pressed'> & { pressed: boolean; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex min-h-8 items-center gap-2 rounded-full border px-4 text-[13px] font-bold transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        pressed
          ? 'border-transparent bg-log-on text-log-on-fg'
          : 'border-log-fg/25 text-log-fg hover:bg-log-fg/10',
        className
      )}
      {...props}
    >
      {children}
      {count !== undefined && <span className="font-mono text-xs font-medium">{count}</span>}
    </button>
  );
}

/** Highlight for a search hit inside a line. */
export function Hit({ children }: { children: ReactNode }) {
  return <mark className="rounded-[3px] bg-log-warn text-log-bar">{children}</mark>;
}

export function LogLine({
  n,
  time,
  queue,
  job,
  level = 'info',
  wrap = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  n?: number;
  time?: string;
  queue?: ReactNode;
  job?: ReactNode;
  level?: LogLevel;
  wrap?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex min-h-5 pr-4 hover:bg-log-fg/5',
        level === 'error' && 'bg-log-err/13',
        className
      )}
      {...props}
    >
      {n !== undefined && (
        <span className="w-[60px] flex-none pr-4 text-right text-log-faint select-none">{n}</span>
      )}
      {time && <span className="w-[84px] flex-none text-log-faint select-none">{time}</span>}
      {queue && <span className="w-28 flex-none truncate pr-3 text-log-dim">{queue}</span>}
      {job && <span className="w-24 flex-none truncate pr-3 text-log-dim">{job}</span>}
      <span
        className={cn(
          'min-w-0 flex-1',
          TEXT[level],
          wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'
        )}
      >
        {BADGE[level] && <b className="mr-3 text-[12px] font-bold tracking-wide">{BADGE[level]}</b>}
        {children}
      </span>
    </div>
  );
}

/** Scrolling body for `LogLine`s. */
export function LogScroll({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'max-h-[640px] min-w-0 flex-1 overflow-auto pb-2 font-mono text-[13px] leading-5',
        className
      )}
      {...props}
    />
  );
}

export function LogFoot({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-wrap justify-between gap-2 border-t border-log-line bg-log-bar px-4 py-2.5 text-xs text-log-dim',
        className
      )}
      {...props}
    />
  );
}

/** The short version for a card: a few lines, no controls. */
export function MiniLog({
  lines,
  label,
}: {
  lines: Array<{ time?: string; level?: LogLevel; text: string }>;
  label: string;
}) {
  return (
    <div
      role="log"
      aria-label={label}
      className="overflow-hidden rounded-control bg-log-bg py-3 font-mono text-[12px] leading-5 text-log-fg"
    >
      {lines.map((line, i) => (
        // A card shows a fixed excerpt that never reorders: position is the key.
        // oxlint-disable-next-line react/no-array-index-key -- positional, static excerpt
        <div key={i} className={cn('flex gap-3 px-3.5 whitespace-pre', TEXT[line.level ?? 'info'])}>
          {line.time && <span className="flex-none text-log-faint">{line.time}</span>}
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  );
}
