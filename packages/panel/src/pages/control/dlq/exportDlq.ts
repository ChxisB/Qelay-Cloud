import { toast } from '@/components/dashboard/stores/toastStore';
import type { DlqEntryFull } from '@/lib/bqTypes';
import { downloadCsv } from '@/lib/exportFile';

/** Saves the failed jobs on the loaded page as a CSV file. */
export function exportDlqPage(queue: string, entries: DlqEntryFull[]) {
  if (entries.length === 0) {
    toast.info('Nothing to export on this page');
    return;
  }
  const rows = entries.map((e) => ({
    jobId: e.job.id,
    reason: e.reason,
    error: e.error ?? '',
    enteredAt: new Date(e.enteredAt).toISOString(),
    attempts: e.attempts?.length ?? 0,
  }));
  downloadCsv(`dlq-${queue}`, rows, ['jobId', 'reason', 'error', 'enteredAt', 'attempts']);
}
