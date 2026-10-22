import { useEffect, useRef } from 'react';

/**
 * For a section that opens and closes from a button: opening moves focus to the first control inside,
 * closing gives it back to the button, so a keyboard user is never left behind. The first render does neither.
 */
export function useRevealFocus(open: boolean) {
  const toggle = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // The last `open` acted on, not a first-run flag: StrictMode runs the effect twice on mount.
  const acted = useRef(open);
  useEffect(() => {
    if (acted.current === open) return;
    acted.current = open;
    if (open) body.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    else toggle.current?.focus();
  }, [open]);
  return { toggle, body };
}
