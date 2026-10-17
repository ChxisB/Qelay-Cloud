import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/Card';
import { flowHref } from '@/features/flows/domain/flowUrlState';
import type { JobFull } from '@/lib/bqTypes';

/** Children listed by id; a parent with more is read in full on the Flows page. */
const CHILD_LINK_LIMIT = 10;

const jobHref = (id: string) => `/job?id=${encodeURIComponent(id)}`;

const linkClass =
  'break-all font-mono text-xs text-fg underline decoration-dotted hover:decoration-solid';

/** Where the job sits in its flow: the flow, its parent, and the jobs it waits for. */
export function JobFlowLinks({ job }: { job: JobFull }) {
  const parent = job.parentId ?? null;
  const children = job.childrenIds ?? [];
  const root = job.flowRoot ?? null;
  if (!root && !parent && children.length === 0) return null;
  const shown = children.slice(0, CHILD_LINK_LIMIT);
  return (
    <Card>
      <CardHeader title="Flow" />
      <dl className="space-y-2 text-sm">
        {root && (
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-[11px] uppercase tracking-wider text-faint">Part of flow</dt>
            <dd>
              <Link to={flowHref(root, job.id)} translate="no" className={linkClass}>
                {root === job.id ? 'This flow' : root}
              </Link>
            </dd>
          </div>
        )}
        {parent && (
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-[11px] uppercase tracking-wider text-faint">Child of</dt>
            <dd>
              <Link to={jobHref(parent)} translate="no" className={linkClass}>
                {parent}
              </Link>
            </dd>
          </div>
        )}
        {children.length > 0 && (
          <div>
            <dt className="mb-1 text-[11px] uppercase tracking-wider text-faint">
              Parent of {children.length} {children.length === 1 ? 'job' : 'jobs'}
            </dt>
            <dd>
              <ul className="space-y-1">
                {shown.map((id) => (
                  <li key={id}>
                    <Link to={jobHref(id)} translate="no" className={linkClass}>
                      {id}
                    </Link>
                  </li>
                ))}
              </ul>
              {children.length > shown.length && (
                <p className="mt-1 text-xs text-faint">
                  and {children.length - shown.length} more.{' '}
                  {root && (
                    <Link to={flowHref(root, job.id)} className="underline">
                      See them in the flow
                    </Link>
                  )}
                </p>
              )}
            </dd>
          </div>
        )}
      </dl>
    </Card>
  );
}
