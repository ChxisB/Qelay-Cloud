import { Link } from 'react-router-dom';

/**
 * A page this deployment does not serve (its server concept does not exist here, or its feature is
 * switched off). Reached by a bookmark or a typed URL: the navigation never links to it.
 */
export function NotAvailable({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <h1 className="text-xl font-semibold text-fg">Not available in this deployment</h1>
      <p className="max-w-md text-sm text-muted">
        {name} is not part of this deployment, so there is nothing to show here.
      </p>
      <Link
        to="/"
        className="rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Back to Overview
      </Link>
    </div>
  );
}

/** A page that exists to change things, reached by a signed-in caller whose role may only look. */
export function OperatorOnly() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <h1 className="text-xl font-semibold text-fg">Operator role needed</h1>
      <p className="max-w-md text-sm text-muted">
        This page changes things, and your role can look but not change. Ask an administrator for
        the operator role if you need it.
      </p>
      <Link
        to="/"
        className="rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Back to Overview
      </Link>
    </div>
  );
}
