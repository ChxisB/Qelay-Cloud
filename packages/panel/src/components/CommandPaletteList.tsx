import type { RefObject } from 'react';
import { Kbd } from '@/components/ui/Kbd';
import { cn } from '@/lib/cn';

export type Command = {
  id: string;
  group: 'Pages' | 'Actions';
  label: string;
  hint: string;
  run: () => void;
};

const GROUPS = ['Pages', 'Actions'] as const;

/**
 * The palette's results: a listbox of options under group headings, then the key hints. Option
 * ids and `data-idx` follow the flat order of `commands`, which the search field's
 * `aria-activedescendant` and the arrow keys index into.
 */
export function PaletteResults({
  listRef,
  commands,
  active,
  onHover,
  onPick,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  commands: Command[];
  active: number;
  onHover: (index: number) => void;
  onPick: (command: Command) => void;
}) {
  return (
    <>
      <div
        ref={listRef}
        id="command-palette-results"
        role="listbox"
        className="max-h-80 overflow-y-auto overscroll-contain pb-2"
        aria-label="Results"
      >
        {commands.length === 0 && (
          <div role="presentation" className="px-4 py-7 text-center text-sm text-muted">
            <p className="font-bold text-fg">Nothing matches</p>
            <p>Try a page name or an action.</p>
          </div>
        )}
        {GROUPS.map((group) => {
          const rows = commands.flatMap((command, index) =>
            command.group === group ? [{ command, index }] : []
          );
          if (rows.length === 0) return null;
          return (
            <div key={group} role="group" aria-label={group}>
              <p
                aria-hidden="true"
                className="mx-5 mt-2 mb-1 text-[12px] font-bold uppercase tracking-[0.08em] text-faint"
              >
                {group}
              </p>
              {rows.map(({ command, index }) => (
                <button
                  key={command.id}
                  type="button"
                  id={`command-palette-option-${index}`}
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  data-idx={index}
                  onMouseEnter={() => onHover(index)}
                  onClick={() => onPick(command)}
                  className={cn(
                    'mx-2 flex min-h-[46px] w-[calc(100%-1rem)] items-center gap-3 rounded-control px-3 text-left text-sm font-semibold transition-[color,background-color,box-shadow] duration-(--duration-hover) ease-settle',
                    index === active
                      ? 'bg-selected text-fg shadow-[inset_3px_0_0_var(--hl)]'
                      : 'text-fg hover:bg-hover'
                  )}
                >
                  <span className="truncate">{command.label}</span>
                  <span className="ml-auto shrink-0 text-xs font-medium text-faint">
                    {command.hint}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-3 text-xs text-faint">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
        </span>
        <span>
          <Kbd>↵</Kbd> to open
        </span>
        <span>
          {commands.length} {commands.length === 1 ? 'result' : 'results'}
        </span>
      </div>
    </>
  );
}
