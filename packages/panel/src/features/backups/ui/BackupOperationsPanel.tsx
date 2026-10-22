import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Table, TableScroll, Td, Th, THead, Tr } from '@/components/ui/Table';
import { usePolledData } from '@/lib/usePolledData';
import type {
  BackupItem,
  BackupOperationResult,
  BackupRepository,
  BackupRestoreContext,
  BackupStatus,
} from '../application/BackupRepository';
import { createBackupRunnerCoordinator } from '../application/backupRunnerCoordinator';
import { captureBackupRepository, loadBackupSnapshot } from '../application/backupSnapshot';
import { parseGeneratedEnvironment } from '../domain/environmentRecord';
import { bqBackupRepository } from '../infrastructure/bqBackupRepository';
import { useScopedConfirm } from './useScopedConfirm';

interface OperationScope {
  connectionIdentity: string;
  repository: BackupRepository;
}

export function BackupOperationsPanel({
  environmentText,
  pollIntervalMs = 15_000,
  repository = bqBackupRepository,
}: {
  environmentText?: string;
  pollIntervalMs?: number;
  repository?: BackupRepository;
}) {
  // Same identity usePolledData uses: backups run through the agent, so an
  // agent-URL or profile switch must invalidate an in-flight operation too.
  const connectionIdentity = useConnectionStore((state) =>
    JSON.stringify([
      state.activeProfileId,
      state.baseUrl,
      state.agentBaseUrl,
      state.token,
      state.agentToken,
    ])
  );
  const mounted = useRef(true);
  const scopeRef = useRef<OperationScope | null>(null);
  if (
    !scopeRef.current ||
    scopeRef.current.connectionIdentity !== connectionIdentity ||
    scopeRef.current.repository !== repository
  ) {
    scopeRef.current = { connectionIdentity, repository };
  }
  const [coordinator] = useState(createBackupRunnerCoordinator);
  const snapshot = usePolledData(
    (signal) => loadBackupSnapshot(captureBackupRepository(repository), coordinator, signal),
    [repository, coordinator],
    {
      intervalMs: pollIntervalMs,
    }
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    locked.current = false;
    setBusy('');
    setError('');
    setNotice('');
  }, [connectionIdentity, repository]);
  const run = async (
    label: string,
    operation: (owner: BackupRepository) => Promise<BackupOperationResult | unknown>
  ) => {
    if (locked.current) return;
    const ownerScope = scopeRef.current;
    locked.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const owner = captureBackupRepository(repository);
      const result = await coordinator.run(async () => {
        if (!scopeIsCurrent(ownerScope, scopeRef, mounted)) {
          throw new Error('Backup operation scope changed before admission.');
        }
        return operation(owner);
      });
      if (!scopeIsCurrent(ownerScope, scopeRef, mounted)) return;
      const message = (result as BackupOperationResult | undefined)?.message;
      setNotice(message ?? `${label} completed.`);
      await snapshot.refetch();
    } catch (caught) {
      if (scopeIsCurrent(ownerScope, scopeRef, mounted)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (scopeIsCurrent(ownerScope, scopeRef, mounted)) {
        locked.current = false;
        setBusy('');
      }
    }
  };
  const latest = useRef(snapshot.data);
  latest.current = snapshot.data;
  const asked = useScopedConfirm(scopeRef, mounted);
  const apply = async () => {
    if (!environmentText) return;
    const yes = await asked({
      question: 'Apply the configuration?',
      detail: 'Apply this S3 configuration to the managed server? A restart is required.',
      confirmLabel: 'Apply configuration',
    });
    if (yes) {
      void run('Configuration', (owner) =>
        owner.configure(parseGeneratedEnvironment(environmentText))
      );
    }
  };
  const backup = async () => {
    const yes = await asked({
      question: 'Create a backup now?',
      detail: 'Create a transactionally consistent S3 backup now?',
      confirmLabel: 'Backup now',
    });
    if (yes) void run('Backup', (owner) => owner.backupNow());
  };
  const restore = async (key: string) => {
    const database = snapshot.data?.context?.database;
    if (!database || snapshot.data?.context?.serverStatus !== 'stopped') return;
    const yes = await asked({
      question: 'Restore this backup?',
      detail: `Type RESTORE to replace ${database.path} with ${key}`,
      confirmLabel: 'Restore',
      danger: true,
      typedWord: 'RESTORE',
    });
    // The server may have started while the question was open.
    const now = latest.current?.context;
    if (yes && now?.serverStatus === 'stopped' && now.database?.path === database.path) {
      void run('Restore', (owner) => owner.restore(key, database));
    }
  };
  const data = snapshot.data;
  return (
    <section className="mt-6 overflow-hidden rounded-card border border-line bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4">
        <div>
          <h2 className="m-0 text-lg font-bold text-fg">Live backup operations</h2>
          <p className="m-0 mt-1 text-[13px] text-muted">
            Official Qelay backup CLI, executed by the local control agent.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!environmentText || Boolean(busy)} onClick={apply}>
            Apply configuration
          </Button>
          <Button size="sm" variant="primary" disabled={Boolean(busy)} onClick={backup}>
            {busy === 'Backup' ? 'Backing up…' : 'Backup now'}
          </Button>
          <Button
            size="sm"
            disabled={Boolean(busy) || snapshot.loading}
            onClick={() => void snapshot.refetch()}
          >
            Refresh
          </Button>
        </div>
      </header>
      {data?.status && <BackupStatusStrip status={data.status} context={data.context} />}
      {error || data?.errors.length ? (
        <div className="border-b border-line p-4">
          <Banner tone="problem" title={error || data?.errors.join(' · ') || ''} />
        </div>
      ) : null}
      {notice && (
        <div className="border-b border-line p-4">
          <Banner tone="ok" title={notice} />
        </div>
      )}
      <BackupList
        rows={data?.backups ?? []}
        canRestore={data?.context?.serverStatus === 'stopped' && Boolean(data.context.database)}
        busy={Boolean(busy)}
        onRestore={restore}
      />
    </section>
  );
}

function BackupStatusStrip({
  status,
  context,
}: {
  status: BackupStatus;
  context?: BackupRestoreContext;
}) {
  const values = [
    ['Scheduler', status.enabled ? 'Enabled after restart' : 'Disabled'],
    ['Bucket', status.bucket || '—'],
    ['Endpoint', status.endpoint],
    ['Retention', status.retention],
    ['Server', context?.serverStatus ?? 'Unknown'],
  ];
  return (
    <dl className="grid border-b border-line sm:grid-cols-2 xl:grid-cols-5">
      {values.map(([label, value]) => (
        <div
          key={label}
          className="border-b border-line px-4 py-3.5 last:border-b-0 xl:border-r xl:border-b-0"
        >
          <dt className="text-[13px] font-semibold text-muted">{label}</dt>
          <dd className="m-0 mt-1 truncate text-[13px] font-semibold text-fg" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BackupList({
  rows,
  canRestore,
  busy,
  onRestore,
}: {
  rows: BackupItem[];
  canRestore: boolean;
  busy: boolean;
  onRestore: (key: string) => void;
}) {
  if (!rows.length)
    return (
      <p className="m-0 px-4 py-6 text-center text-[13px] text-muted">
        No backup objects returned.
      </p>
    );
  return (
    <TableScroll>
      <Table className="min-w-[680px] text-left">
        <THead>
          <tr>
            <Th>Object key</Th>
            <Th>Size</Th>
            <Th>Created</Th>
            <Th right>Restore</Th>
          </tr>
        </THead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.key}>
              <Td className="max-w-md truncate font-mono text-[13px]" title={row.key}>
                {row.key}
              </Td>
              <Td className="text-[13px] text-muted">{row.size}</Td>
              <Td className="text-[13px] text-muted">{row.date}</Td>
              <Td className="text-right">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!canRestore || busy}
                  title={
                    canRestore ? 'Restore this backup' : 'Stop the managed server before restore'
                  }
                  onClick={() => onRestore(row.key)}
                >
                  Restore
                </Button>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableScroll>
  );
}

function scopeIsCurrent(
  owner: OperationScope | null,
  scope: { current: OperationScope | null },
  mounted: { current: boolean }
): boolean {
  return mounted.current && owner !== null && scope.current === owner;
}
