import { useEffect, useId, useRef, useState } from 'react';
import { type PendingConfirm, useConfirmStore } from '@/components/dashboard/stores/confirmStore';
import { useGlobalModalStore } from '@/components/dashboard/stores/globalModalStore';
import { cn } from '@/lib/cn';
import { usePresence } from '@/lib/usePresence';
import { Button } from './Button';
import { Field, Input } from './form';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

function ConfirmBox({ item, leaving }: { item: PendingConfirm; leaving: boolean }) {
  const answer = useConfirmStore((s) => s.answer);
  const [typed, setTyped] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const ready = item.typedWord === undefined || typed === item.typedWord;

  // A leaving box neither traps nor holds focus: it is already giving both back.
  useEffect(() => {
    if (leaving) return;
    const box = boxRef.current;
    const beneath = useGlobalModalStore.getState().beneath;
    // Focus starts on a control that cannot do harm: Cancel, or the field that unlocks the main button.
    box?.querySelector<HTMLElement>('[data-first]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Alone: whatever lies beneath must not see this key once the shell is handed back to it.
        e.preventDefault();
        e.stopImmediatePropagation();
        answer(item.id, false);
        return;
      }
      if (e.key !== 'Tab' || !box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !box.contains(at))) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (at === last || !box.contains(at))) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Back to the opener, unless the shell went to someone else (sign-in) or the next question is already up.
      const { active } = useGlobalModalStore.getState();
      if ((active === null || active === beneath) && item.opener?.isConnected) item.opener.focus();
    };
  }, [leaving, answer, item]);

  return (
    <div
      inert={leaving || undefined}
      className={cn(
        'fixed inset-0 z-[65] flex items-center justify-center p-5',
        leaving && 'pointer-events-none'
      )}
    >
      {/* The dimmed area is a real button so "click outside to cancel" works for a keyboard and a screen reader too. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Cancel"
        onClick={() => answer(item.id, false)}
        className={cn(
          'fixed inset-0 cursor-default bg-scrim',
          leaving ? 'motion-fade-out' : 'motion-fade'
        )}
      />
      <div
        ref={boxRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'relative flex max-h-full w-full max-w-[560px] flex-col gap-5 overflow-auto rounded-[24px] border border-line-strong bg-surface p-7 shadow-pop',
          leaving ? 'motion-leave' : 'motion-drop'
        )}
      >
        <div className="flex flex-col gap-2">
          <h2 id={titleId} className="m-0 break-words text-lg font-bold leading-snug text-fg">
            {item.question}
          </h2>
          {item.detail && <p className="m-0 break-words text-sm text-muted">{item.detail}</p>}
        </div>
        {item.typedWord !== undefined && (
          <Field label={`Type ${item.typedWord} to confirm`}>
            <Input
              data-first=""
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            data-first={item.typedWord === undefined ? '' : undefined}
            onClick={() => answer(item.id, false)}
          >
            Cancel
          </Button>
          <Button
            variant={item.danger ? 'danger' : 'primary'}
            disabled={!ready}
            onClick={() => answer(item.id, true)}
          >
            {item.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The page's own confirm, which replaces `window.confirm`. Mounted once in AppLayout. It takes the `confirm`
 * owner (above the palette, below sign-in) and shows the question `confirmInPage` was asked, one at a time.
 */
export function ConfirmDialog() {
  const current = useConfirmStore((s) => s.current);
  const owns = useGlobalModalStore((s) => s.active === 'confirm');
  const signIn = useGlobalModalStore((s) => s.active === 'authentication');
  const { mounted, leaving } = usePresence(current !== null && owns);
  // The last question stays on screen while it leaves.
  const [shown, setShown] = useState(current);
  if (current && current !== shown) setShown(current);

  // The shell went to sign-in (or was reset) under an open question: nothing may be confirmed behind it.
  useEffect(() => {
    if (!current || owns) return;
    useConfirmStore.getState().answer(current.id, false);
  }, [current, owns]);

  // Sign-in takes the screen at once, with no 180ms of a question fading over it.
  if (!mounted || !shown || signIn) return null;
  return <ConfirmBox key={shown.id} item={shown} leaving={leaving} />;
}
