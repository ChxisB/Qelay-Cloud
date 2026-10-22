import { useState, type ReactNode } from 'react';
import { confirmInPage } from '@/components/dashboard/stores/confirmStore';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Tag } from '@/components/ui/Tag';
import { bq, BqError, type WebhookPauseMode } from '@/lib/bq';
import type { WebhookFull } from '@/lib/bqTypes';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { assertSuccessfulMutationResponse, useServerActionGuard } from '@/lib/useServerActionGuard';
import { ConnectionEdit } from './ConnectionEdit';
import { ConnectionPause } from './ConnectionPause';
import { ruleCards } from './connectionRules';
import { routeName } from './model';
import { SecretBanner } from './SecretBanner';

/** A card with a title, the words that say what its button does, and the button. */
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} headingLevel={3} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-[1_1_320px] text-sm text-muted">{children}</p>
        {action}
      </div>
    </Card>
  );
}

/** The rules an event goes through, in order. An operator edits the ones of this connection in the form, so only the fixed ones are listed. */
function Rules({ route, fixedOnly }: { route: WebhookFull; fixedOnly: boolean }) {
  return (
    <Card>
      <CardHeader
        title={fixedOnly ? 'Always on' : 'Rules'}
        headingLevel={3}
        sub={
          fixedOnly
            ? 'The same for every connection, after the rules above.'
            : 'What an event goes through before it is sent, in this order.'
        }
      />
      <ol className="divide-y divide-line">
        {ruleCards(route)
          .filter((rule) => !fixedOnly || !rule.editable)
          .map((rule) => (
            <li key={rule.name} className="py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-fg">{rule.name}</span>
                <Tag>{rule.on ? 'On' : 'Off'}</Tag>
              </div>
              <p className="mt-1 text-sm text-muted">{rule.summary}</p>
              {rule.code && (
                <pre className="mt-2 overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-fg">
                  {rule.code}
                </pre>
              )}
            </li>
          ))}
      </ol>
    </Card>
  );
}

const NO_KEY =
  'This deployment has no signing key, so it cannot sign events. Set QCLOUD_WEBHOOK_KEY on the Control API, then try again.';

/**
 * The signing secret of an http connection. A new secret is shown here once and lives in this component's
 * state only: not in the address, in storage or in a toast. The page keys this by connection, so another
 * connection never inherits it.
 */
function SigningSecret({ route, onRotated }: { route: WebhookFull; onRotated: () => void }) {
  const guard = useServerActionGuard(`webhook-secret:${route.id}`);
  const [secret, setSecret] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verb = route.signed ? 'Rotate' : 'Create';

  const issue = async () => {
    const asked = route.signed
      ? {
          question: 'Rotate the signing secret?',
          detail: 'The old secret keeps working for 24 hours. The new one is shown once.',
        }
      : {
          question: 'Create a signing secret?',
          detail: 'Every event from now on is signed. The secret is shown once.',
        };
    if (!(await confirmInPage({ ...asked, confirmLabel: `${verb} secret` }))) return;
    const lease = guard.begin(['webhook-secret', route.id]);
    if (!lease) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await bq.rotateWebhookSecret(route.id);
      assertSuccessfulMutationResponse(response, `${verb} secret`);
      const issued = (response.data as { secret?: unknown } | undefined)?.secret;
      if (typeof issued !== 'string' || !issued)
        throw new Error(`${verb} secret returned no secret`);
      if (!lease.isCurrent()) return;
      setSecret(issued);
      onRotated();
    } catch (caught) {
      if (!lease.isCurrent()) return;
      setProblem(
        caught instanceof BqError && caught.code === 'webhook_key_missing'
          ? NO_KEY
          : (caught as Error).message
      );
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Section
        title="Signing secret"
        action={
          <Button size="sm" disabled={busy} onClick={() => void issue()}>
            {`${verb} secret`}
          </Button>
        }
      >
        {route.signed
          ? 'Every event is signed, so the receiver can check it came from here. A new secret replaces this one; the old one still signs for 24 hours so the receiver can switch without a gap.'
          : 'Events are sent unsigned. Once there is a secret, every event is signed.'}
      </Section>
      {problem && <Banner title={`${verb} secret failed`}>{problem}</Banner>}
      {secret && (
        <SecretBanner
          secret={secret}
          title="Copy the new secret now"
          action={
            <Button size="sm" onClick={() => setSecret(null)}>
              Done
            </Button>
          }
        >
          It is shown once. The old secret keeps working for 24 hours.
        </SecretBanner>
      )}
    </div>
  );
}

/**
 * What to know and change about one connection. An operator edits its name and rules, pauses or disables it,
 * manages its signing secret and removes it; a viewer reads the same facts and has no controls.
 */
export function ConnectionSettings({
  route,
  enabled,
  removing,
  onSet,
  onRemove,
  onRotated,
  refetch,
}: {
  route: WebhookFull;
  enabled: boolean;
  removing: boolean;
  onSet: (enabled: boolean, mode?: WebhookPauseMode) => void;
  onRemove: () => void;
  onRotated: () => void;
  refetch: () => Promise<void>;
}) {
  const operator = useCanOperate();
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {operator && <ConnectionEdit route={route} refetch={refetch} />}
      <Rules route={route} fixedOnly={operator} />
      {operator && route.destination === 'http' && (
        <SigningSecret route={route} onRotated={onRotated} />
      )}
      {operator && <ConnectionPause route={route} enabled={enabled} onSet={onSet} />}
      {operator && (
        <Section
          title="Remove"
          action={
            <Button
              size="sm"
              variant="danger"
              disabled={removing}
              onClick={() =>
                void confirmInPage({
                  question: `Remove the connection to ${routeName(route)}?`,
                  detail: 'Its events and their history go with it.',
                  confirmLabel: 'Remove connection',
                  danger: true,
                }).then((ok) => ok && onRemove())
              }
            >
              Remove connection
            </Button>
          }
        >
          The connection, its events and their history are deleted, and nothing more is sent for it.
          This cannot be undone.
        </Section>
      )}
    </div>
  );
}
