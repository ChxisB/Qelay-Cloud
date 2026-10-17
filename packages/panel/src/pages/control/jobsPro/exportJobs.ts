import { toast } from '@/components/dashboard/stores/toastStore';
import type { JobFull } from '@/lib/bqTypes';
import { downloadCsv } from '@/lib/exportFile';

const COLUMNS = [
  'id',
  'name',
  'queue',
  'state',
  'priority',
  'attempts',
  'maxAttempts',
  'createdAt',
  'durationMs',
];

/** Download the rows currently on screen as CSV. */
export function exportJobs(rows: JobFull[], queue: string, status: string) {
  if (rows.length === 0) {
    toast.info('No jobs to export on this page');
    return;
  }
  const out = rows.map((j) => ({
    id: j.id,
    name: j.name ?? 'default',
    queue: j.queue ?? queue,
    state: j.state ?? '',
    priority: j.priority ?? 0,
    attempts: j.attempts ?? 0,
    maxAttempts: j.maxAttempts ?? '',
    createdAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
    durationMs: j.startedAt && j.completedAt ? j.completedAt - j.startedAt : '',
  }));
  downloadCsv(`jobs-${queue}-${status}`, out, COLUMNS);
}
