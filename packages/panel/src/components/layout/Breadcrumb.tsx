import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { locateNav } from './navConfig';
import { ICON, NavIcon } from './NavIcon';
import { titleFor } from './pageTitle';

/**
 * Crumbs for a pathname: the root (the active connection's name), the nav group when the route has
 * one, then the page. A nav destination uses its sidebar label ("Home", not
 * "Workflow · Overview"); a route outside the nav (a queue detail, 404) falls back
 * to its document title.
 */
export function crumbsFor(pathname: string, root: string): string[] {
  const located = locateNav(pathname);
  const page = located?.label ?? titleFor(pathname);
  return [root, ...(located?.section ? [located.section] : []), page];
}

export function Breadcrumb({ pathname }: { pathname: string }) {
  const root = useConnectionStore(
    (s) => (s.profiles.find((profile) => profile.id === s.activeProfileId) ?? s.profiles[0])?.name
  );
  const crumbs = crumbsFor(pathname, root ?? 'Local');
  const last = crumbs.length - 1;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 text-sm font-semibold text-faint">
      <ol className="flex min-w-0 items-center gap-2">
        {crumbs.map((crumb, index) => (
          // The trail is derived from the path and never reorders, so position is a stable key.
          // oxlint-disable-next-line react/no-array-index-key -- positional, static-length list
          <Fragment key={index}>
            {index > 0 && (
              <li aria-hidden="true" className="hidden sm:flex sm:items-center">
                <NavIcon d={ICON.chevronRight} className="size-4" />
              </li>
            )}
            {index === last ? (
              <li aria-current="page" className="min-w-0 truncate font-bold text-fg">
                {crumb}
              </li>
            ) : index === 0 ? (
              <li className="hidden shrink-0 sm:flex sm:items-center">
                <Link
                  to="/"
                  className="inline-flex min-h-8 items-center text-muted no-underline hover:underline"
                >
                  {crumb}
                </Link>
              </li>
            ) : (
              <li className="hidden shrink-0 sm:flex sm:items-center">{crumb}</li>
            )}
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
