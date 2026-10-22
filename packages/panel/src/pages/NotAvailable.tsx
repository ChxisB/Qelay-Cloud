import { EmptyState } from '@/components/ui/feedback';
import { LinkButton } from '@/components/ui/LinkButton';

const overview = (
  <LinkButton to="/" size="sm">
    Back to overview
  </LinkButton>
);

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/**
 * A page this deployment does not serve (its server concept does not exist here, or its feature is
 * switched off). Reached by a bookmark or a typed URL: the navigation never links to it.
 */
export function NotAvailable({ name }: { name: string }) {
  return (
    <EmptyState
      icon={
        <Glyph>
          <circle cx="12" cy="12" r="9" />
          <path d="M5.6 5.6l12.8 12.8" />
        </Glyph>
      }
      headingLevel={1}
      title="Not available in this deployment"
      hint={`${name} is not part of this deployment, so there is nothing to show here.`}
      action={overview}
    />
  );
}

/** A page that exists to change things, reached by a signed-in caller whose role may only look. */
export function OperatorOnly() {
  return (
    <EmptyState
      icon={
        <Glyph>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </Glyph>
      }
      headingLevel={1}
      title="Operator role needed"
      hint="This page changes things, and your role can look but not change. Ask an administrator for the operator role if you need it."
      action={overview}
    />
  );
}
