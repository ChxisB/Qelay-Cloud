import { type ReactNode, useId } from 'react';
import { BqError } from '@/lib/bq';

export type StepNumber = 1 | 2 | 3 | 4;

/** One numbered step of the form: a rail with the number, then the step's title and fields. */
export function Step({
  n,
  title,
  children,
}: {
  n: StepNumber;
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <li className="flex gap-4">
      <span aria-hidden="true" className="flex flex-col items-center">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-bold text-fg">
          {n}
        </span>
        {n < 4 && <span className="mt-1 w-px flex-1 bg-line" />}
      </span>
      <section aria-labelledby={id} className="flex min-w-0 flex-1 flex-col gap-3 pb-6">
        <h3 id={id} className="m-0 text-sm font-bold text-fg">
          {title}
        </h3>
        {children}
      </section>
    </li>
  );
}

/** The step a refusal belongs to; a refusal that names no field is shown at Save. */
export const stepOf = (error: unknown): StepNumber =>
  error instanceof BqError &&
  (error.code === 'route_cycle' || error.code === 'destination_not_found')
    ? 2
    : error instanceof BqError && error.code === 'webhook_key_missing'
      ? 3
      : 4;
