import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Disclosure } from '@/components/ui/Disclosure';
import { Field, FieldAction, FormRow, Input } from '@/components/ui/form';

/** Removing a limit asks for the queue's name first: it takes the cap off a live queue. */
export function RemoveLimit({
  queue,
  summary,
  button,
  inputName,
  busy,
  onRemove,
}: {
  queue: string;
  summary: string;
  button: string;
  inputName: string;
  busy: boolean;
  onRemove: () => void;
}) {
  const [typed, setTyped] = useState('');
  return (
    <Disclosure summary={summary} className="mt-5 border-t border-line pt-2">
      <FormRow>
        <div className="min-w-48 flex-1">
          <Field label={`Type ${queue} to confirm`}>
            <Input
              name={inputName}
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        </div>
        <FieldAction>
          <Button disabled={busy || typed !== queue} onClick={onRemove}>
            {button}
          </Button>
        </FieldAction>
      </FormRow>
    </Disclosure>
  );
}

/** Why the form cannot be applied yet, tied to the fields by `errorId`. */
export function FormError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-3 text-[13px] font-semibold text-danger">
      {children}
    </p>
  );
}
