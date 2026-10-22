import { EmptyState } from '@/components/ui/feedback';
import { LinkButton } from '@/components/ui/LinkButton';

export function NotFound() {
  return (
    <EmptyState
      code="404"
      headingLevel={1}
      title="That page does not exist"
      hint="The link may be old, or the queue was removed. Check the address, or search for what you need."
      action={
        <>
          <LinkButton to="/" variant="primary" size="sm">
            Go to overview
          </LinkButton>
          <LinkButton to="/queues" size="sm">
            Browse queues
          </LinkButton>
        </>
      }
    />
  );
}
