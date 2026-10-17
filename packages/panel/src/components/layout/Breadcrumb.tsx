import { Fragment } from 'react';
import { locateNav } from './navConfig';
import { titleFor } from './pageTitle';

/**
 * Crumbs for a pathname: the product root, the nav group when the route has one, then the page.
 * A nav destination uses its sidebar label ("Overview", not "Workflow · Overview"); a route
 * outside the nav (a queue detail, a classic page, 404) falls back to its document title.
 */
export function crumbsFor(pathname: string): string[] {
  const located = locateNav(pathname);
  const page = located?.label ?? titleFor(pathname);
  return ['Control panel', ...(located?.section ? [located.section] : []), page];
}

export function Breadcrumb({ pathname }: { pathname: string }) {
  const crumbs = crumbsFor(pathname);
  const last = crumbs.length - 1;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 text-[13px]">
      <ol className="flex min-w-0 items-center gap-2">
        {crumbs.map((crumb, index) => (
          // The trail is derived from the path and never reorders, so position is a stable key.
          // oxlint-disable-next-line react/no-array-index-key -- positional, static-length list
          <Fragment key={index}>
            {index > 0 && (
              <li aria-hidden="true" className="hidden text-muted sm:list-item">
                /
              </li>
            )}
            {index === last ? (
              <li aria-current="page" className="min-w-0 truncate font-semibold text-fg">
                {crumb}
              </li>
            ) : (
              <li className="hidden shrink-0 text-muted sm:list-item">{crumb}</li>
            )}
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
