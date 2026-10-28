import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Field, Input, SegmentedControl } from '@/components/ui/form';
import { type AddWebhookBody, bq, type WebhookDestination } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import {
  assertSuccessfulMutationResponse,
  type ServerActionLease,
} from '@/lib/useServerActionGuard';
import { buildWebhookBody, generateWebhookSecret, SECRET_MAX_CHARS } from '../webhooks/model';
import { ConnectionFields } from './ConnectionFields';
import {
  blankFields,
  type EditField,
  type EditFields,
  refusedField,
  rulesOf,
} from './connectionPatch';
import { ConnectionPreview } from './ConnectionPreview';
import { addressOf } from './destinationFields';
import { DestinationPicker } from './DestinationPicker';
import { Step, type StepNumber, stepOf } from './FormStep';
import { SourcePicker } from './SourcePicker';

const OWN = ['Webhook address', 'Another queue'] as const;
const SAVED = 'Saved destination';
type Kind = (typeof OWN)[number] | typeof SAVED;
const DESTINATION: Record<(typeof OWN)[number], WebhookDestination> = {
  'Webhook address': 'http',
  'Another queue': 'queue',
};

/**
 * The new connection form, in four steps: which inbound source it reads, where the requests go (an address
 * of yours, a saved destination, or a job in a queue), what is sent and how it is signed, then Save. A queue
 * route has no address and no secret. `onAccepted` gets the server's reply, to find the
 * new id in.
 */
export function ConnectionForm({
  onAdd,
  onAccepted,
  beginAdd,
  scopeKey,
  cancel,
}: {
  onAdd: (body: AddWebhookBody) => Promise<unknown>;
  onAccepted: (response: unknown) => void;
  beginAdd: () => ServerActionLease | null;
  scopeKey: string;
  cancel?: ReactNode;
}) {
  const [kind, setKind] = useState<Kind>('Webhook address');
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [savedId, setSavedId] = useState('');
  const [source, setSource] = useState('');
  const [secret, setSecret] = useState('');
  // A generated secret is shown once, so it can be copied to the receiver. Stored ones never are.
  const [revealed, setRevealed] = useState(false);
  const [rules, setRules] = useState<EditFields>(blankFields);
  const [ruleError, setRuleError] = useState<{ field: EditField; msg: string } | null>(null);
  const [err, setErr] = useState<{ step: StepNumber; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // An older server has no saved destinations, and a deployment with none has nothing to choose from.
  const saved = usePolledData(() => bq.destinations(), []).data ?? [];
  const sources = usePolledData(() => bq.sources(), []).data ?? [];
  const kinds: readonly Kind[] = saved.length > 0 ? [...OWN, SAVED] : OWN;
  const chosen =
    kind === SAVED ? saved.find((destination) => destination.id === savedId) : undefined;
  const destination = kind === SAVED ? (chosen?.kind ?? null) : DESTINATION[kind];
  const toQueue = destination === 'queue';

  // scopeKey is the connection lifecycle boundary.
  useEffect(() => {
    setBusy(false);
    setErr(null);
    setRuleError(null);
    setSecret('');
    setRevealed(false);
  }, [scopeKey]);

  const changeRule = <K extends EditField>(key: K, value: EditFields[K]) => {
    setRules((current) => ({ ...current, [key]: value }));
    setRuleError(null);
  };

  const submit = async () => {
    if (busy) return;
    setErr(null);
    setRuleError(null);
    if (destination === null) return setErr({ step: 2, msg: 'Choose a saved destination.' });
    // A batch is for an http destination: one left on from before the choice changed is not sent.
    const typed = rulesOf(toQueue ? { ...rules, batchOn: false } : rules);
    if (!typed.ok) return setRuleError({ field: typed.field, msg: typed.msg });
    const built = buildWebhookBody(chosen?.url ?? url, source, secret, {
      destination,
      target: chosen ? (chosen.target ?? '') : target,
    });
    if (!built.ok) return setErr({ step: 4, msg: built.msg });
    // A saved destination gives the kind and the address; sending them too is refused.
    const body: AddWebhookBody = chosen
      ? {
          ...built.body,
          ...typed.rules,
          destination: undefined,
          url: undefined,
          target: undefined,
          destinationId: chosen.id,
        }
      : { ...built.body, ...typed.rules };
    const lease = beginAdd();
    if (!lease) return;
    setBusy(true);
    try {
      const response = await onAdd(body);
      assertSuccessfulMutationResponse(response, 'Add connection');
      if (!lease.isCurrent()) return;
      setUrl('');
      setTarget('');
      setSecret('');
      setRevealed(false);
      onAccepted(response);
    } catch (error) {
      if (!lease.isCurrent()) return;
      const field = refusedField(error);
      const msg = (error as Error).message;
      if (field) setRuleError({ field, msg });
      else setErr({ step: stepOf(error), msg });
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  const alert = (n: StepNumber) =>
    err?.step === n && (
      <p role="alert" className="m-0 text-[13px] font-bold text-danger">
        {err.msg}
      </p>
    );

  return (
    <form
      className="grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ol className="m-0 flex max-w-3xl list-none flex-col p-0">
        <Step n={1} title="Source">
          <div className="max-w-md">
            <SourcePicker sources={sources} value={source} onChange={setSource} />
          </div>
        </Step>
        <Step n={2} title="Destination">
          <div>
            <p className="mb-1 text-[13px] font-bold leading-5 text-fg">Send requests to</p>
            <SegmentedControl
              options={kinds}
              value={kind}
              onChange={setKind}
              label="Where the requests go"
              asWritten
            />
          </div>
          <div className="max-w-xl">
            {kind === SAVED ? (
              <DestinationPicker destinations={saved} value={savedId} onChange={setSavedId} />
            ) : toQueue ? (
              <Field label="To queue" hint="Each request adds one job to this queue.">
                <Input
                  value={target}
                  onInput={(event) => setTarget(event.currentTarget.value)}
                  name="route-target"
                  maxLength={256}
                  autoComplete="off"
                  placeholder="refunds"
                />
              </Field>
            ) : (
              <Field label="URL" hint="Qelay sends each request it accepts to this address.">
                <Input
                  value={url}
                  onInput={(event) => setUrl(event.currentTarget.value)}
                  name="webhook-url"
                  type="url"
                  maxLength={2_048}
                  autoComplete="url"
                  placeholder="https://example.com/hook"
                />
              </Field>
            )}
          </div>
          {alert(2)}
        </Step>
        <Step n={3} title="Rules">
          <ConnectionFields
            fields={rules}
            onChange={changeRule}
            errors={ruleError ? { [ruleError.field]: ruleError.msg } : {}}
            {...(destination && { destination })}
          />
          {destination === 'http' && (
            <div className="max-w-xl">
              <Field
                label="Signing secret (optional)"
                htmlFor="webhook-secret"
                hint="Used to sign each request. At least 16 characters, and never shown again after you save."
              >
                <div className="flex items-center gap-2">
                  <Input
                    id="webhook-secret"
                    type={revealed ? 'text' : 'password'}
                    autoComplete="new-password"
                    name="webhook-secret"
                    maxLength={SECRET_MAX_CHARS}
                    value={secret}
                    onInput={(event) => {
                      setSecret(event.currentTarget.value);
                      setRevealed(false);
                    }}
                    placeholder="Optional"
                  />
                  <Button
                    size="sm"
                    aria-label="Generate a signing secret"
                    onClick={() => {
                      setSecret(generateWebhookSecret());
                      setRevealed(true);
                    }}
                  >
                    Generate
                  </Button>
                  {revealed && <CopyButton value={secret} />}
                </div>
              </Field>
            </div>
          )}
          {alert(3)}
        </Step>
        <Step n={4} title="Save">
          <p className="m-0 text-[13px] text-muted">
            Saving adds the connection and opens its page.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add connection'}
            </Button>
            {cancel}
          </div>
          {alert(4)}
        </Step>
      </ol>
      <ConnectionPreview
        source={sources.find((one) => one.id === source)?.name ?? ''}
        destination={destination}
        address={chosen ? addressOf(chosen) : toQueue ? target : url}
        signed={secret !== ''}
        rules={rules}
      />
    </form>
  );
}
