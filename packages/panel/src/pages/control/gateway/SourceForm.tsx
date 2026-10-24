import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, Input, SegmentedControl } from '@/components/ui/form';
import {
  bq,
  BqError,
  SOURCE_VERIFICATION_KINDS,
  type SourceIssued,
  type SourceVerificationKind,
} from '@/lib/bq';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import { NAME_MAX } from './connectionPatch';
import {
  blankSource,
  DEFAULT_HEADER,
  KIND_WORDS,
  type SourceField,
  type SourceFields,
  sourceBodyOf,
} from './sourceModel';

const WORDS = SOURCE_VERIFICATION_KINDS.map((kind) => KIND_WORDS[kind]);
const KIND_OF = Object.fromEntries(
  SOURCE_VERIFICATION_KINDS.map((kind) => [KIND_WORDS[kind], kind])
) as Record<string, SourceVerificationKind>;

/** The field a refusal is about: the server names the option, or the code says it (a taken name). */
function fieldOfRefusal(error: unknown): SourceField | null {
  if (!(error instanceof BqError)) return null;
  if (error.code === 'source_name_taken') return 'name';
  const option = error.details?.option;
  return option === 'name' || option === 'secret' ? option : null;
}

/**
 * Registers an inbound source. The check cannot be changed afterwards (make another source and move the
 * connections), so it is chosen here. `onIssued` gets the answer, which holds the token and the secret shown once.
 */
export function SourceForm({
  refetch,
  onIssued,
  onDone,
}: {
  refetch: () => Promise<void>;
  onIssued: (issued: SourceIssued) => void;
  onDone: () => void;
}) {
  const guard = useServerActionGuard('webhook-source:new');
  const [fields, setFields] = useState<SourceFields>(blankSource);
  const [refusal, setRefusal] = useState<{ field: SourceField | null; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { kind } = fields;

  // scopeKey is the connection lifecycle boundary: a new server is a new registry.
  useEffect(() => {
    setBusy(false);
    setRefusal(null);
  }, [guard.scopeKey]);

  const change = (next: Partial<SourceFields>) => {
    setFields((current) => ({ ...current, ...next }));
    setRefusal(null);
  };

  const save = async () => {
    if (busy) return;
    const built = sourceBodyOf(fields);
    if (!built.ok) return setRefusal({ field: built.field, msg: built.msg });
    const lease = guard.begin(['registry-write', 'webhook-source:new']);
    if (!lease) return;
    setBusy(true);
    setRefusal(null);
    try {
      const issued = await bq.addSource(built.body);
      if (!lease.isCurrent()) return;
      onIssued(issued);
      await refetch();
      if (lease.isCurrent()) onDone();
    } catch (caught) {
      if (lease.isCurrent()) {
        setRefusal({ field: fieldOfRefusal(caught), msg: (caught as Error).message });
      }
    } finally {
      if (lease.finish()) setBusy(false);
    }
  };

  const on = (field: SourceField) => (refusal?.field === field ? refusal.msg : undefined);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="max-w-xl">
        <Field label="Name" hint="How it is listed and chosen." error={on('name')}>
          <Input
            value={fields.name}
            onInput={(event) => change({ name: event.currentTarget.value })}
            name="source-name"
            maxLength={NAME_MAX}
            autoComplete="off"
            placeholder="Shop checkout"
          />
        </Field>
      </div>
      <div>
        <p className="mb-1 text-[13px] font-bold leading-5 text-fg">
          How a request proves who sent it
        </p>
        <SegmentedControl
          options={WORDS}
          value={KIND_WORDS[kind]}
          onChange={(word) => {
            const next = KIND_OF[word] ?? 'none';
            change({ kind: next, header: DEFAULT_HEADER[next], username: '', secret: '' });
          }}
          label="Check on each request"
          asWritten
        />
      </div>
      {(kind === 'hmac' || kind === 'api_key') && (
        <div className="max-w-xl">
          <Field
            label="Header"
            hint={
              kind === 'hmac'
                ? 'The header that carries the signature of the request body (SHA-256, hex or base64).'
                : 'The header that carries the key.'
            }
            error={on('header')}
          >
            <Input
              value={fields.header}
              onInput={(event) => change({ header: event.currentTarget.value })}
              name="source-header"
              maxLength={64}
              autoComplete="off"
            />
          </Field>
        </div>
      )}
      {kind === 'basic' && (
        <div className="max-w-xl">
          <Field label="User name" hint="The secret is the password." error={on('username')}>
            <Input
              value={fields.username}
              onInput={(event) => change({ username: event.currentTarget.value })}
              name="source-username"
              maxLength={128}
              autoComplete="off"
            />
          </Field>
        </div>
      )}
      {kind !== 'none' && (
        <div className="max-w-xl">
          <Field
            label="Secret"
            hint="Leave it blank to have one made. It is shown once, when the source is saved."
            error={on('secret')}
          >
            <Input
              value={fields.secret}
              onInput={(event) => change({ secret: event.currentTarget.value })}
              name="source-secret"
              type="password"
              maxLength={256}
              autoComplete="new-password"
            />
          </Field>
        </div>
      )}
      {refusal && !refusal.field && (
        <p role="alert" className="m-0 text-[13px] font-bold text-danger">
          {refusal.msg}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Add source'}
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
