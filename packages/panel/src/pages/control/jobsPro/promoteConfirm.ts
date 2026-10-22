import type { ConfirmOptions } from '@/components/dashboard/stores/confirmStore';

/** The question before Promote, for the bulk bar (`count` jobs) and a row (1). Only delayed jobs can be promoted. */
export function promoteConfirm(count: number): ConfirmOptions {
  const one = count === 1;
  return {
    question: `Promote ${count} delayed ${one ? 'job' : 'jobs'}?`,
    detail: `${one ? 'It stops' : 'They stop'} waiting for ${one ? 'its' : 'their'} delay and ${one ? 'becomes' : 'become'} ready now.`,
    confirmLabel: `Promote ${count}`,
  };
}

/** The same question from the job's own page, where "this job" is the only one in view. */
export const PROMOTE_THIS_JOB: ConfirmOptions = {
  question: 'Promote this job?',
  detail: 'It stops waiting for its delay and becomes ready now.',
  confirmLabel: 'Promote',
};
