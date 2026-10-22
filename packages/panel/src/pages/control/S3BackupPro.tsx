import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import {
  type BackupSchedule,
  type S3AddressingStyle,
  useS3Store,
} from '@/components/dashboard/stores/s3Store';
import { SystemTabs } from '@/components/SystemTabs';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/form';
import { IconS3 } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusPill } from '@/components/ui/StatusBadge';
import { BackupOperationsPanel } from '@/features/backups/ui/BackupOperationsPanel';
import { bq } from '@/lib/bq';
import {
  buildS3Environment,
  parseStorageHealthResponse,
  storageTargetIdentity,
} from './s3Backup/model';
import { useRetentionDraft } from './s3Backup/retentionDraft';
import { S3EnvironmentCard } from './s3Backup/S3EnvironmentCard';

export type { S3Draft } from './s3Backup/model';
export { buildS3Environment, parseStorageHealthResponse } from './s3Backup/model';

export function S3BackupPro() {
  const s3 = useS3Store();
  const retention = useRetentionDraft(s3.retention, (value) => s3.set({ retention: value }));
  const targetIdentity = useConnectionStore(storageTargetIdentity);
  const [test, setTest] = useState<{ target: string; ok: boolean; msg: string } | null>(null);
  const [checkingTarget, setCheckingTarget] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const environment = buildS3Environment({ ...s3, retention: retention.value });
  const visibleTest = test?.target === targetIdentity ? test : null;
  const checking = checkingTarget === targetIdentity;

  // A target identity change invalidates checks from the previous target.
  useEffect(() => {
    requestGeneration.current++;
    setTest(null);
    setCheckingTarget(null);
    return () => {
      // oxlint-disable-next-line react/exhaustive-deps -- the shared generation ref invalidates this request on cleanup
      requestGeneration.current++;
    };
  }, [targetIdentity]);
  const checkServerStorage = async () => {
    const target = targetIdentity;
    const generation = ++requestGeneration.current;
    setTest(null);
    setCheckingTarget(target);
    try {
      const r = await bq.storage();
      if (
        generation !== requestGeneration.current ||
        storageTargetIdentity(useConnectionStore.getState()) !== target
      ) {
        return;
      }
      const health = parseStorageHealthResponse(r);
      setTest({
        target,
        ok: !health.diskFull,
        msg: health.diskFull
          ? 'Server disk is full'
          : 'Server disk healthy — this does not validate the S3 credentials',
      });
    } catch (e) {
      if (
        generation !== requestGeneration.current ||
        storageTargetIdentity(useConnectionStore.getState()) !== target
      ) {
        return;
      }
      setTest({ target, ok: false, msg: (e as Error).message });
    } finally {
      if (generation === requestGeneration.current) setCheckingTarget(null);
    }
  };
  return (
    <div>
      <PageHeader title="S3 backup setup" description="Configure and operate Qelay S3 backups." />
      <SystemTabs current="/s3" />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-control bg-slate-tint text-muted">
            <IconS3 className="size-5" />
          </span>
          <div>
            <div className="font-bold text-fg">
              {environment.ok ? 'Configuration draft complete' : 'Configuration draft incomplete'}
            </div>
            <div className="text-[13px] text-muted">
              {environment.ok
                ? s3.schedule === 'disabled'
                  ? 'Safe disable settings ready to apply'
                  : `Target: ${s3.bucket.trim()} · ready to apply`
                : 'Complete the required fields to generate server settings'}
            </div>
          </div>
        </div>
        <StatusPill state={environment.ok ? 'completed' : 'delayed'}>
          {environment.ok ? 'Ready' : 'Configure'}
        </StatusPill>
      </div>
      <div className="mb-6">
        <Banner tone="info" title="Configured on the server">
          Apply the generated settings through the local control agent below, then restart Qelay.
          Status, object listing, manual backups, and guarded restores use the official Qelay CLI.
          Non-secret draft fields are stored locally; credentials remain in memory.
        </Banner>
      </div>
      <Card className="mb-6">
        <CardHeader
          title="Connection settings"
          sub="Works with AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, and any S3-compatible provider."
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Endpoint">
            <Input
              name="s3-endpoint"
              value={s3.endpoint}
              onChange={(e) => s3.set({ endpoint: e.target.value })}
              placeholder="https://s3.amazonaws.com"
              maxLength={2048}
              autoComplete="off"
              inputMode="url"
            />
          </Field>
          <Field label="Region">
            <Input
              name="s3-region"
              value={s3.region}
              onChange={(e) => s3.set({ region: e.target.value })}
              placeholder="us-east-1"
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Bucket name">
              <Input
                name="s3-bucket"
                value={s3.bucket}
                onChange={(e) => s3.set({ bucket: e.target.value })}
                placeholder="my-qelay-backups"
                maxLength={255}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          <Field label="Access key ID">
            <Input
              name="s3-access-key-id"
              value={s3.accessKeyId}
              onChange={(e) => s3.set({ accessKeyId: e.target.value })}
              placeholder="AKIA…"
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Secret access key">
            <Input
              name="s3-secret-access-key"
              type="password"
              value={s3.secretAccessKey}
              onChange={(e) => s3.set({ secretAccessKey: e.target.value })}
              placeholder="••••••••••••••••"
              maxLength={2048}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Session token (optional, for temporary STS credentials)">
              <Input
                name="s3-session-token"
                type="password"
                value={s3.sessionToken}
                onChange={(e) => s3.set({ sessionToken: e.target.value })}
                placeholder="Temporary AWS session token"
                maxLength={4096}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          <p className="m-0 text-[13px] text-muted md:col-span-2">
            Keys are kept in memory only and cleared on reload.
          </p>
          <Field label="Backup interval" htmlFor="s3-backup-schedule">
            <Select
              id="s3-backup-schedule"
              name="s3-backup-schedule"
              value={s3.schedule}
              onChange={(e) => s3.set({ schedule: e.target.value as BackupSchedule })}
              title="Written to S3_BACKUP_ENABLED and S3_BACKUP_INTERVAL in the generated config"
              autoComplete="off"
            >
              <option value="disabled">Disabled</option>
              <option value="6h">Every 6 hours</option>
              <option value="12h">Every 12 hours</option>
              <option value="24h">Every 24 hours</option>
            </Select>
          </Field>
          <Field label="Path prefix (optional)">
            <Input
              name="s3-path-prefix"
              value={s3.pathPrefix}
              onChange={(e) => s3.set({ pathPrefix: e.target.value })}
              placeholder="backups/production/"
              maxLength={1024}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Addressing style" htmlFor="s3-addressing-style">
            <Select
              id="s3-addressing-style"
              name="s3-addressing-style"
              value={s3.virtualHostedStyle}
              onChange={(e) => s3.set({ virtualHostedStyle: e.target.value as S3AddressingStyle })}
            >
              <option value="auto">Provider default</option>
              <option value="virtual-hosted">Virtual-hosted style</option>
              <option value="path-style">Path style</option>
            </Select>
          </Field>
          <Field label="Backups to retain">
            <Input
              name="s3-retention"
              type="number"
              min={1}
              max={1_000_000}
              step={1}
              value={retention.text}
              onChange={(e) => retention.change(e.target.value)}
              inputMode="numeric"
            />
          </Field>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={checkServerStorage}>
            {checking ? 'Checking server storage…' : 'Check server storage'}
          </Button>
          <span className="text-[13px] text-muted">
            This checks SQLite disk health only, not S3 connectivity.
          </span>
        </div>
        {visibleTest && (
          <div className="mt-4">
            {visibleTest.ok ? (
              <Banner tone="ok" title={visibleTest.msg} />
            ) : (
              <Banner tone="problem" title="The storage check failed">
                {visibleTest.msg}
              </Banner>
            )}
          </div>
        )}
      </Card>

      <S3EnvironmentCard environment={environment} />
      <BackupOperationsPanel environmentText={environment.ok ? environment.value : undefined} />
    </div>
  );
}
