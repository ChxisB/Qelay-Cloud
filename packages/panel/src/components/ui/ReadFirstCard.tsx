import { type ReactNode, useId } from 'react';
import { Button } from './Button';
import { Card, CardHeader } from './Card';
import { useRevealFocus } from './useRevealFocus';

/** A value inside a summary sentence: bold, so the eye finds the number before it reads the words. */
export function Value({ children }: { children: ReactNode }) {
  return <strong className="font-bold text-fg">{children}</strong>;
}

/**
 * A card that says what is set before it shows a field: the summary sentence, and one Edit button that opens
 * the fields. The fields are not in the page until then, so a settings page reads as a list of facts.
 * The caller owns `open`, so it can close the card when a save worked.
 */
export function ReadFirstCard({
  title,
  sub,
  summary,
  facts,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  sub?: ReactNode;
  /** What is set now, as a sentence. Put the numbers in `<Value>`. */
  summary: ReactNode;
  /** Settings the server fixes, shown below the sentence whether or not the card is open. */
  facts?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The fields and their one main action. */
  children: ReactNode;
}) {
  const id = useId();
  const { toggle, body } = useRevealFocus(open);
  const name = title.toLowerCase();
  return (
    <Card>
      <CardHeader
        title={title}
        sub={sub}
        action={
          <Button
            ref={toggle}
            size="sm"
            variant={open ? 'ghost' : 'default'}
            aria-label={open ? `Cancel editing ${name}` : `Edit ${name}`}
            aria-expanded={open ? undefined : false}
            aria-controls={open ? undefined : id}
            onClick={() => onOpenChange(!open)}
          >
            {open ? 'Cancel' : 'Edit'}
          </Button>
        }
      />
      <p aria-live="polite" className="text-[13px] leading-6 text-muted">
        {summary}
      </p>
      {open && (
        <div id={id} ref={body} className="mt-5 border-t border-line pt-5">
          {children}
        </div>
      )}
      {facts && <div className="mt-5 border-t border-line pt-4">{facts}</div>}
    </Card>
  );
}
