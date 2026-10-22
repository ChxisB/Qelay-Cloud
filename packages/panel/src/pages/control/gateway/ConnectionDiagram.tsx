import type { ReactNode } from 'react';
import { ICON } from '@/components/layout/NavIcon';
import { ConnectionNode } from '@/components/ui/nodegraph/ConnectionNode';
import type { WebhookFull } from '@/lib/bqTypes';

/**
 * The connections of the namespace as lines: one block per source, the source on the left (on top below `xl`),
 * its connections to the right of it. `row` draws one connection and gets its place in the first-load stagger
 * (counted across the blocks) and whether its block has more than one.
 */
export function ConnectionDiagram({
  groups,
  row,
}: {
  groups: ReadonlyArray<[string, WebhookFull[]]>;
  row: (route: WebhookFull, place: number, multi: boolean) => ReactNode;
}) {
  let place = 0;
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([source, routes]) => {
        const multi = routes.length > 1;
        return (
          <section
            key={source}
            aria-label={source}
            className="rounded-card border border-line bg-surface p-3.5 shadow-panel xl:grid xl:grid-cols-[208px_32px_minmax(0,1fr)] xl:p-4"
          >
            <div role="heading" aria-level={2} className="xl:self-center">
              <ConnectionNode kind="source" icon={ICON.queues} name={source} sub="Source" />
            </div>
            <div aria-hidden="true" className="relative hidden xl:block">
              <span className="absolute top-[calc(50%-1px)] left-0 h-0.5 w-4 rounded-sm bg-line-strong" />
              {multi && (
                <span className="absolute top-[46px] bottom-[46px] left-[15px] w-0.5 rounded-sm bg-line-strong" />
              )}
            </div>
            <ul className="mt-3 ml-7 flex min-w-0 flex-col border-l-2 border-line-strong pl-5 xl:mt-0 xl:ml-0 xl:border-l-0 xl:pl-0">
              {routes.map((route) => row(route, place++, multi))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
