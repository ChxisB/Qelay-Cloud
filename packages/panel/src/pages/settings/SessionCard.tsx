import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { getActiveSession } from '@/lib/auth/activeSession';
import { useAuthStore } from '@/lib/auth/authStore';
import { useCapabilities } from '@/lib/capabilities/useCapabilities';

/**
 * Shown instead of the connection editor once an identity provider owns the sign-in. The API
 * address comes from the deployment's `config.json` and the credential from the sign-in, so there
 * is nothing here to type: it says who the caller is and offers the way out.
 */
export function SessionCard() {
  const subject = useAuthStore((s) => s.subject);
  const baseUrl = useConnectionStore((s) => s.baseUrl);
  const { status, caps } = useCapabilities();
  const role = status === 'ready' ? caps.principal.role : 'unknown';

  return (
    <Card>
      <CardHeader title="Session" />
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted">Signed in as</dt>
        <dd className="break-all font-mono text-xs text-fg">{subject ?? 'unknown'}</dd>
        <dt className="text-muted">Role</dt>
        <dd className="text-fg">{role}</dd>
        <dt className="text-muted">API</dt>
        <dd className="break-all font-mono text-xs text-fg">{baseUrl}</dd>
      </dl>
      <p className="mt-4 text-xs text-faint">
        The address of the API is set by whoever deployed this panel. Your credential is held in
        memory for this tab only and is never written to disk.
      </p>
      <div className="mt-4">
        <Button onClick={() => void getActiveSession()?.signOut()}>Sign out</Button>
      </div>
    </Card>
  );
}
