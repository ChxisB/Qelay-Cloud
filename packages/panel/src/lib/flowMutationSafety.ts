export const FLOW_DELETION_UNAVAILABLE =
  'Unavailable in Qelay: the server cannot inspect reverse flow dependencies or delete/discard topology atomically.';

export const FLOW_BULK_RETRY_UNAVAILABLE =
  'DLQ retry is unavailable in Qelay on this server: it lists dlq-retry as unsupported. Update the server to retry failed jobs from the panel.';

export const FLOW_COMPLETED_REQUEUE_UNAVAILABLE =
  'Completed-job requeue is unavailable in Qelay because retry-completed re-inserts a child without rebuilding its flow dependency registration.';
