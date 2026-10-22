import { type ReactNode, useId } from 'react';
import { Button } from './Button';
import { Card, CardHeader } from './Card';
import { useRevealFocus } from './useRevealFocus';

/**
 * Where a list page makes a new item: a title and one button, and the form only once the button is pressed,
 * so the list is the first thing on the page. The caller owns `open`, so it can close the card when the
 * item was made. While the list is empty (`empty`) the form is simply there, with no button to hide it:
 * a page with nothing on it should show how to start.
 */
export function CreateCard({
  title,
  sub,
  button,
  open,
  onOpenChange,
  empty = false,
  children,
}: {
  title: string;
  sub?: ReactNode;
  /** The button's words while the form is closed, for example "New schedule". */
  button: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The list this card makes items for has none yet. */
  empty?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const { toggle, body } = useRevealFocus(open);
  return (
    <Card className="mb-6">
      <CardHeader
        title={title}
        sub={sub}
        action={
          !empty && (
            <Button
              ref={toggle}
              size="sm"
              variant={open ? 'ghost' : 'primary'}
              aria-expanded={open ? undefined : false}
              aria-controls={open ? undefined : id}
              onClick={() => onOpenChange(!open)}
            >
              {open ? 'Cancel' : button}
            </Button>
          )
        }
      />
      {(open || empty) && (
        <div id={id} ref={body}>
          {children}
        </div>
      )}
    </Card>
  );
}
