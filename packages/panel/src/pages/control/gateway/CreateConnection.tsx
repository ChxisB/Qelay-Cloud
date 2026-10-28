import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import { bq } from '@/lib/bq';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { ConnectionForm } from './ConnectionForm';
import { GatewayPage } from './GatewayPage';
import { connectionLink } from './model';
import { SecretBanner } from './SecretBanner';

const LIST = '/events-gateway';

/** What the server's reply names: the new connection's id, and the secret it made (shown once). Each is null when absent. */
const issued = (response: unknown) => {
  const data = (response as { data?: { webhook?: { id?: unknown }; secret?: unknown } } | null)
    ?.data;
  const id = data?.webhook?.id;
  const secret = data?.secret;
  return {
    id: typeof id === 'string' && id !== '' ? id : null,
    secret: typeof secret === 'string' && secret !== '' ? secret : null,
  };
};

/**
 * Make a connection on a page of its own, then land on it. Without an id in the reply, land on the list.
 * A secret the store made is kept in this component's state only, and the page waits until it is copied.
 */
export function CreateConnection() {
  const navigate = useNavigate();
  const guard = useServerActionGuard('webhooks');
  const [made, setMade] = useState<{ to: string; secret: string } | null>(null);
  return (
    <GatewayPage current={LIST}>
      <Card>
        <CardHeader
          title="New connection"
          sub="Choose an inbound source, then an address of yours or a queue to send its requests to."
        />
        {made ? (
          <SecretBanner
            secret={made.secret}
            title="Copy the signing secret now"
            action={<Button onClick={() => navigate(made.to)}>Open connection</Button>}
          >
            The connection is added and every event is signed. The secret is shown once: put it in
            the receiver before you leave this page.
          </SecretBanner>
        ) : (
          <ConnectionForm
            onAdd={(body) => bq.addWebhook(body)}
            onAccepted={(response) => {
              const { id, secret } = issued(response);
              const to = id === null ? LIST : connectionLink(id);
              if (secret === null) navigate(to);
              else setMade({ to, secret });
            }}
            beginAdd={() => guard.begin(['registry-write', 'add'])}
            scopeKey={guard.scopeKey}
            cancel={
              <LinkButton to={LIST} variant="ghost">
                Cancel
              </LinkButton>
            }
          />
        )}
      </Card>
    </GatewayPage>
  );
}
