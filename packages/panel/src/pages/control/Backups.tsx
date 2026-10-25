import { useState } from 'react';
import { toast } from '@/components/dashboard/stores/toastStore';
import { HealthTabs } from '@/components/HealthTabs';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { Field, FormRow, Input } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { api } from '@/lib/api';
import { useCanOperate } from '@/lib/capabilities/useCapabilities';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import type { BackupMechanism, BackupPolicy } from '@/lib/ops/types';
import { usePolledData } from '@/lib/usePolledData';
import { useServerActionGuard } from '@/lib/useServerActionGuard';
import {
  type Draft,
  draftFrom,
  draftProblems,
  inputFrom,
  isChanged,
  MAX_LOCATION_CHARS,
  MAX_TOOL_CHARS,
  MECHANISMS,
} from './backups/model';

/** What the page says about the answer on record, as a banner. Nobody having said is not the same as `none`. */
function Standing({ policy }: { policy: BackupPolicy | null }) {
  if (policy === null) {
    return (
      <Banner tone="warn" title="Not declared.">
        Nobody has said how this database is backed up. Choose one below, even if the answer is your
        own tooling.
      </Banner>
    );
  }
  const by = `Declared by ${policy.updatedBy} ${formatRelativeTime(policy.updatedAt)}.`;
  if (policy.mechanism === 'none') {
    return (
      <Banner tone="warn" title="Declared as not backed up.">
        {by}
      </Banner>
    );
  }
  const what =
    policy.mechanism === 'provider'
      ? "The database service's own backups."
      : `${policy.tool}${policy.location ? `, copies at ${policy.location}` : ''}.`;
  return (
    <Banner tone="ok" title={what}>
      {by}
    </Banner>
  );
}

function MechanismChoice({
  draft,
  disabled,
  onPick,
}: {
  draft: Draft;
  disabled: boolean;
  onPick: (mechanism: BackupMechanism) => void;
}) {
  return (
    <fieldset className="m-0 grid gap-3 border-0 p-0 sm:grid-cols-3" disabled={disabled}>
      <legend className="sr-only">How this database is backed up</legend>
      {MECHANISMS.map((option) => {
        const selected = draft.mechanism === option.value;
        return (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer flex-col gap-1 rounded-card border p-4 transition-colors',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              selected ? 'border-ring bg-hover' : 'border-line hover:bg-hover',
              disabled && 'cursor-default opacity-70'
            )}
          >
            <span className="flex items-center gap-2 text-[13px] font-bold text-fg">
              <input
                type="radio"
                name="backup-mechanism"
                value={option.value}
                checked={selected}
                onChange={() => onPick(option.value)}
              />
              {option.title}
            </span>
            <span className="text-xs text-muted">{option.hint}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * How is this database backed up? Qelay takes no backups and restores none: the operator says who
 * does, and the Deployment page warns while the answer is missing or is "nothing". The server
 * records the answer and never checks it against the database.
 */
export function Backups() {
  const canOperate = useCanOperate();
  // Wrapped, so "nobody has said" (a null policy) is not mistaken for "not loaded yet" (null data).
  const { data, error, refetch } = usePolledData(
    async () => ({ policy: await api.backupPolicy() }),
    [],
    { intervalMs: 60_000 }
  );
  const [edit, setEdit] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const guard = useServerActionGuard('backup-policy');

  if (!data && !error) return <LoadingState label="Loading backups…" />;
  if (!data) {
    return (
      <div>
        <PageHeader title="Backups" description="How this database is backed up is unavailable." />
        <HealthTabs current="/backups" />
        <ErrorState error={error!} onRetry={refetch} />
      </div>
    );
  }

  const saved = data.policy;
  const draft = edit ?? draftFrom(saved);
  const problems = draftProblems(draft);
  const input = inputFrom(draft);
  const change = (next: Partial<Draft>) => {
    setSaveError(null);
    setEdit({ ...draft, ...next });
  };

  const save = async () => {
    const lease = input && guard.begin();
    if (!input || !lease) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.setBackupPolicy(input);
      toast.success('Backup declaration saved');
      if (lease.isCurrent()) setEdit(null);
      await refetch();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      toast.error('Could not save the declaration', message);
      if (lease.isCurrent()) setSaveError(message);
    } finally {
      if (lease.finish()) setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Backups"
        description="Qelay takes no backups. Say how this database is backed up, so a missing answer shows as a warning instead of a surprise."
      />
      <HealthTabs current="/backups" />
      <div className="flex flex-col gap-6">
        {error && (
          <OfflineBanner
            message="Connection lost — showing the last successful reading."
            onRetry={refetch}
          />
        )}
        <Standing policy={saved} />
        <Card>
          <CardHeader
            title="Who backs up this database?"
            sub={
              canOperate
                ? 'Your answer is recorded and shown here. Qelay does not check it against the database.'
                : 'Only an operator can change this.'
            }
          />
          <div className="flex flex-col gap-4">
            <MechanismChoice
              draft={draft}
              disabled={!canOperate || saving}
              onPick={(mechanism) => change({ mechanism })}
            />
            {draft.mechanism === 'external' && (
              <FormRow>
                <div className="min-w-60 flex-[1_1_240px]">
                  <Field label="Tool" hint="What takes the backups." error={edit && problems.tool}>
                    <Input
                      value={draft.tool}
                      maxLength={MAX_TOOL_CHARS * 2}
                      placeholder="pgBackRest"
                      disabled={!canOperate || saving}
                      aria-invalid={Boolean(edit && problems.tool)}
                      onChange={(event) => change({ tool: event.target.value })}
                    />
                  </Field>
                </div>
                <div className="min-w-60 flex-[2_1_360px]">
                  <Field
                    label="Where the copies land (optional)"
                    hint="A bucket, a path or a runbook link. Not a credential."
                    error={edit && problems.location}
                  >
                    <Input
                      value={draft.location}
                      maxLength={MAX_LOCATION_CHARS * 2}
                      placeholder="gs://acme-backups/prod"
                      disabled={!canOperate || saving}
                      aria-invalid={Boolean(edit && problems.location)}
                      onChange={(event) => change({ location: event.target.value })}
                    />
                  </Field>
                </div>
              </FormRow>
            )}
            {saveError && (
              <p role="alert" className="text-[13px] text-bad">
                {saveError}
              </p>
            )}
            {canOperate && (
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  disabled={!input || saving || !isChanged(draft, saved)}
                  onClick={save}
                >
                  {saving ? 'Saving…' : 'Save declaration'}
                </Button>
                {edit && !saving && (
                  <Button variant="ghost" onClick={() => setEdit(null)}>
                    Discard changes
                  </Button>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
