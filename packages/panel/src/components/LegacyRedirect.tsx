import { Navigate, useLocation } from 'react-router-dom';

/** The `*-classic` pages are gone. Their paths keep working: the Pro page sits at the same path without the suffix. */
export function LegacyRedirect() {
  const { pathname, search, hash } = useLocation();
  const to = pathname.replace(/-classic(?=\/|$)/i, '').replace(/^\/overview(?=\/|$)/i, '') || '/';
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}
