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
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 text-[13px]">
        <dt className="border-b border-line py-2.5 text-muted">Signed in as</dt>
        <dd className="m-0 break-all border-b border-line py-2.5 text-right font-mono text-[13px] font-semibold text-fg">
          {subject ?? 'unknown'}
        </dd>
        <dt className="border-b border-line py-2.5 text-muted">Role</dt>
        <dd className="m-0 border-b border-line py-2.5 text-right font-semibold text-fg">{role}</dd>
        <dt className="py-2.5 text-muted">API</dt>
        <dd className="m-0 break-all py-2.5 text-right font-mono text-[13px] font-semibold text-fg">
          {baseUrl}
        </dd>
      </dl>
      <p className="mt-4 text-[13px] text-muted">
        The address of the API is set by whoever deployed this panel. Your credential is held in
        memory for this tab only and is never written to disk.
      </p>
      <div className="mt-4">
        <Button onClick={() => void getActiveSession()?.signOut()}>Sign out</Button>
      </div>
    </Card>
  );
}
